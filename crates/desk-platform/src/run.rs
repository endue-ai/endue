//! A run's server-sent events, read as they arrive and handed on one by one: `run_created`, `delta`,
//! `step`, `run_presentation`, `interaction`, `done` and `error`; any other event is skipped (ADR
//! 0122's tolerant reader). The `done` event's saved message is the answer. A stream that passes
//! `MAX_STREAM` is cut and says so; one silent for the idle limit ends the read as offline.

use std::io::Read as _;
use std::time::Duration;

use desk_sys::net::Method;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::chat::{ChatState, ChatTurn};
use crate::frames::{Frames, Next};
use crate::stream::{self, Opened};
use crate::wire_chat::{
    ChatDone, RunCreatedEvent, RunDeltaEvent, RunErrorEvent, RunInteractionEvent, RunOf,
    RunPresentationEvent, RunStepEvent,
};
use crate::work::{ChatWork, Tally};
use crate::{ErrorKind, Platform, PlatformError, Result};

/// The most of one run's stream that is read.
pub const MAX_STREAM: u64 = 2 * 1024 * 1024;
/// The longest answer kept.
pub(crate) const MAX_REPLY: usize = 12_000;
/// What a run cut at `MAX_STREAM` says.
pub const RUN_CUT: &str = "The run was cut: its stream passed 2 MiB.";
const RUN_FAILED: &str = "The run failed on endue AI.";
const MAX_QUESTION: usize = 2_000;

/// What a run's stream says, in order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChatEvent {
    Started {
        run_id: String,
    },
    /// The new piece of the answer only.
    Delta(String),
    Work(ChatWork),
    NeedsInput {
        message: Option<String>,
    },
    /// The saved final answer, which replaces what the deltas wrote.
    Completed {
        text: String,
    },
    Failed {
        message: String,
    },
    Cancelled,
}

/// One run's events folded into its turn.
struct Reader<'a> {
    on: &'a mut dyn FnMut(ChatEvent),
    turn: ChatTurn,
    tally: Tally,
    asked: bool,
}

fn parse<T: DeserializeOwned>(value: &Value) -> Option<T> {
    serde_json::from_value(value.clone()).ok()
}

impl Reader<'_> {
    fn frame(&mut self, event: &str, data: &str) -> Next {
        let Ok(value) = serde_json::from_str::<Value>(data) else {
            return Next::More;
        };
        if let Some(id) = parse::<RunOf>(&value)
            .and_then(|r| r.run_id)
            .filter(|id| valid_id(id))
        {
            match self.turn.run_id.as_deref() {
                Some(old) if old != id => {
                    // Another run's events: this one is lost to the reader.
                    self.turn = ChatTurn::interrupted();
                    return Next::End;
                }
                Some(_) => {}
                None => {
                    self.turn.run_id = Some(id.clone());
                    (self.on)(ChatEvent::Started { run_id: id });
                }
            }
        }
        match event {
            "run_created" => {
                // Its run id was taken above; nothing more to read in it.
                let _ = parse::<RunCreatedEvent>(&value);
            }
            "delta" => {
                if let Some(delta) =
                    parse::<RunDeltaEvent>(&value).filter(|d| !d.content.is_empty())
                {
                    (self.on)(ChatEvent::Delta(delta.content));
                }
            }
            "step" => {
                if let Some(step) = parse::<RunStepEvent>(&value) {
                    for call in &step.tool_calls {
                        self.tally.call(&call.name, !call.ok);
                    }
                    self.work("running");
                }
            }
            "run_presentation" => {
                if let Some(event) = parse::<RunPresentationEvent>(&value) {
                    self.tally.present(&event.presentation);
                    self.work("running");
                }
            }
            "interaction" => {
                let payload = parse::<RunInteractionEvent>(&value)
                    .unwrap_or_default()
                    .payload;
                let message = payload
                    .question
                    .or(payload.prompt)
                    .map(|q| clip(&q, MAX_QUESTION));
                self.ask(message);
            }
            "error" => {
                let error = parse::<RunErrorEvent>(&value).unwrap_or_default();
                if matches!(
                    error.code.as_deref(),
                    Some("RUN_CANCELLED" | "CLIENT_ABORT")
                ) {
                    self.cancelled();
                } else {
                    let message = error.message.filter(|m| !m.trim().is_empty());
                    self.fail(message.unwrap_or_else(|| RUN_FAILED.to_owned()));
                }
                return Next::End;
            }
            "done" => {
                if let Some(done) = parse::<ChatDone>(&value) {
                    self.done(done);
                }
                return Next::End;
            }
            _ => {}
        }
        Next::More
    }

    fn work(&mut self, phase: &str) {
        let work = self.tally.work(phase);
        self.turn.work = Some(work.clone());
        (self.on)(ChatEvent::Work(work));
    }

    fn ask(&mut self, message: Option<String>) {
        if !self.asked {
            self.asked = true;
            (self.on)(ChatEvent::NeedsInput { message });
        }
    }

    fn fail(&mut self, message: String) {
        self.turn.state = ChatState::Failed;
        self.turn.message = Some(message.clone());
        (self.on)(ChatEvent::Failed { message });
    }

    fn cancelled(&mut self) {
        self.turn.state = ChatState::Interrupted;
        (self.on)(ChatEvent::Cancelled);
    }

    fn done(&mut self, done: ChatDone) {
        if self.turn.run_id.as_deref() != Some(&done.run_id) {
            return;
        }
        if let Some(presentation) = &done.message.metadata.presentation {
            self.tally.present(presentation);
        }
        match done.stop_reason.as_deref() {
            Some("awaiting_choice") => {
                self.turn.state = ChatState::NeedsInput;
                self.settle("awaiting_input");
                self.ask(None);
            }
            Some("error") => {
                self.settle("failed");
                self.fail(RUN_FAILED.to_owned());
            }
            Some("cancelled") => {
                self.settle("cancelled");
                self.cancelled();
            }
            None | Some("final") => {
                let text = done.message.content.filter(|s| !s.trim().is_empty());
                match text {
                    Some(text) if done.message.role == "assistant" => {
                        let text: String = text.chars().take(MAX_REPLY).collect();
                        self.turn.state = ChatState::Done;
                        self.turn.text = Some(text.clone());
                        self.settle("completed");
                        (self.on)(ChatEvent::Completed { text });
                    }
                    _ if self.asked => {
                        self.turn.state = ChatState::NeedsInput;
                        self.settle("awaiting_input");
                    }
                    _ => self.turn.state = ChatState::Interrupted,
                }
            }
            Some(_) => self.turn.state = ChatState::Interrupted,
        }
    }

    /// The work as the run ended, when it did any.
    fn settle(&mut self, phase: &str) {
        if !self.tally.is_empty() {
            self.work(phase);
        }
    }

    /// The stream ended without `done` or `error`.
    fn finish(mut self) -> ChatTurn {
        if self.asked && self.turn.state == ChatState::Interrupted {
            self.turn.state = ChatState::NeedsInput;
        }
        self.turn
    }
}

impl Platform {
    /// How long a run's stream may stay silent: 90 s, or the client's own deadline when it was set
    /// shorter (tests, hosts with their own timeout).
    pub(crate) fn idle(&self) -> Duration {
        const IDLE: Duration = Duration::from_secs(90);
        if self.timeout == crate::TIMEOUT {
            IDLE
        } else {
            self.timeout.min(IDLE)
        }
    }

    /// Open the run stream at `path` and read it to its end, handing each event to `on`. A 204 (no
    /// run in flight) is an interrupted turn without events.
    pub(crate) fn run_stream(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        on: &mut dyn FnMut(ChatEvent),
    ) -> Result<ChatTurn> {
        let idle = self.idle();
        let mut opened = self.open_stream(method, path, body, idle)?;
        if opened.status == 204 {
            return Ok(ChatTurn::interrupted());
        }
        if opened.kind != "text/event-stream" {
            return Err(PlatformError::new(
                ErrorKind::Failed,
                "endue AI did not return a run stream",
            ));
        }
        let mut reader = Reader {
            on,
            turn: ChatTurn::interrupted(),
            tally: Tally::default(),
            asked: false,
        };
        let mut frames = Frames::default();
        let mut buf = vec![0u8; 16 * 1024];
        let mut read = 0u64;
        loop {
            let n = match opened.body.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) if reader.turn.run_id.is_none() => {
                    return Err(stream::read_failure(&e, idle));
                }
                Err(e) if stream::timed_out(&e) => {
                    return Err(stream::silent(idle));
                }
                Err(_) => break,
            };
            let room = usize::try_from(MAX_STREAM - read).unwrap_or(usize::MAX);
            let cut = n > room;
            read += n.min(room) as u64;
            let mut on_frame = |event: &str, data: &str| reader.frame(event, data);
            if let Next::End = frames.feed(&buf[..n.min(room)], &mut on_frame) {
                return Ok(reader.turn);
            }
            if cut {
                reader.fail(RUN_CUT.to_owned());
                return Ok(reader.turn);
            }
        }
        Ok(reader.finish())
    }

    /// The stream's answer head, after one refresh-and-retry when the token is refused; an error
    /// envelope for any other status but 2xx.
    fn open_stream(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        idle: Duration,
    ) -> Result<Opened> {
        let mut request = Self::request_to(
            &self.base,
            &self.host,
            method,
            path,
            body,
            idle,
            "text/event-stream",
        );
        let token = self.tokens.token().ok_or_else(PlatformError::signed_out)?;
        let bearer = |request: &mut desk_sys::net::Request, token: &str| {
            request
                .headers
                .insert("authorization".to_owned(), format!("Bearer {token}"));
        };
        bearer(&mut request, &token);
        let mut opened = stream::open(&request, idle)?;
        if opened.status == 401
            && let Some(fresh) = self.tokens.refresh(&token).filter(|t| *t != token)
        {
            bearer(&mut request, &fresh);
            opened = stream::open(&request, idle)?;
        }
        if (200..300).contains(&opened.status) {
            return Ok(opened);
        }
        let mut error = Vec::new();
        let _ = (&mut opened.body).take(64 * 1024).read_to_end(&mut error);
        Err(PlatformError::from_response(opened.status, &error))
    }
}

fn clip(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

pub(crate) fn valid_id(id: &str) -> bool {
    id.len() <= 128
        && id.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric)
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
