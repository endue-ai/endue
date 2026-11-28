//! The person's own Eris on endue AI as the desk's `endue` brain (FT-01, amending ADR 0094): the
//! same Eris the web talks to, reached with the endue ID token the desk holds. endue AI names her
//! agent and conversation (`GET /api/v1/ai/secretary`); each answer is one run on that
//! conversation. She answers in words with endue AI's own tools; the desk's tools stay with the
//! brains on this computer, so a turn that needs one of them goes down the fallback order.
//! Signed out, or on an account without her, she cannot be reached and the next brain answers.

use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use desk_brain::{BrainError, BrainErrorCode, BrainFailure, StopReason};
use desk_brain_local::{Answer, Model, Piece};
use desk_platform::{ChatConversation, ChatState, ErrorKind, Platform, PlatformError};
use serde_json::Value;

/// How long the answer to "who is her conversation" is kept, so brain.status asks once a minute.
const KEPT: Duration = Duration::from_secs(60);
/// Said when her run stops to wait for the person on endue.ai.
pub const NEEDS_YOU_LINE: &str = "I need your answer on endue.ai before I go on.";

/// The endue AI client that reaches her, behind the `Model` a `LocalBrain` asks.
pub trait ErisPlatform: Send + Sync {
    fn eris(&self) -> Result<Option<ChatConversation>, PlatformError>;
    fn turn(
        &self,
        eris: &ChatConversation,
        text: &str,
        id: &str,
    ) -> Result<(ChatState, Option<String>), PlatformError>;
}

impl ErisPlatform for Platform {
    fn eris(&self) -> Result<Option<ChatConversation>, PlatformError> {
        Platform::eris(self)
    }

    fn turn(
        &self,
        eris: &ChatConversation,
        text: &str,
        id: &str,
    ) -> Result<(ChatState, Option<String>), PlatformError> {
        self.chat_turn(eris, text, id)
            .map(|turn| (turn.state, turn.text))
    }
}

pub struct EndueEris {
    platform: Box<dyn ErisPlatform>,
    found: Mutex<Option<(Instant, Result<ChatConversation, String>)>>,
    sent: AtomicU64,
}

impl EndueEris {
    pub fn new(platform: Box<dyn ErisPlatform>) -> Self {
        Self {
            platform,
            found: Mutex::new(None),
            sent: AtomicU64::new(0),
        }
    }

    /// Her conversation, asked at most once a minute; why not, as `Unreachable`.
    fn conversation(&self) -> Result<ChatConversation, BrainFailure> {
        let mut found = self.found.lock().unwrap_or_else(|p| p.into_inner());
        if let Some((at, kept)) = found.as_ref()
            && at.elapsed() < KEPT
        {
            return kept.clone().map_err(BrainFailure::Unreachable);
        }
        let now = match self.platform.eris() {
            Ok(Some(eris)) => Ok(eris),
            Ok(None) => Err("this endue account has no Eris".to_owned()),
            Err(e) if e.kind == ErrorKind::SignedOut => Err("not signed in to endue".to_owned()),
            Err(e) => Err(format!("endue AI: {}", e.message)),
        };
        *found = Some((Instant::now(), now.clone()));
        now.map_err(BrainFailure::Unreachable)
    }

    fn forget(&self) {
        *self.found.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }
}

impl Model for EndueEris {
    fn chat(
        &self,
        tools: &[Value],
        messages: &[Value],
        on: &mut dyn FnMut(Piece<'_>),
    ) -> Result<Answer, BrainFailure> {
        let _ = tools;
        // A system message first is a turn that must call one of the desk's tools (brain.ask).
        if messages.first().is_some_and(|m| m["role"] == "system") {
            return Err(BrainFailure::Unreachable(
                "Eris on endue AI does not run the desk's tools".to_owned(),
            ));
        }
        let line = last_line(messages).ok_or_else(|| {
            BrainFailure::Protocol("the turn has no line from the person".to_owned())
        })?;
        let eris = self.conversation()?;
        let id = message_id(self.sent.fetch_add(1, Ordering::Relaxed));
        let (state, text) = match self.platform.turn(&eris, &line, &id) {
            Ok(done) => done,
            Err(e) => {
                self.forget();
                return Err(failure(e));
            }
        };
        let text = match (state, text) {
            (ChatState::Done, Some(text)) => text,
            (ChatState::NeedsInput, _) => NEEDS_YOU_LINE.to_owned(),
            (ChatState::Failed, _) => return Err(refused(502, "Eris's run failed on endue AI")),
            _ => {
                return Err(BrainFailure::Protocol(
                    "Eris's run on endue AI ended without an answer".to_owned(),
                ));
            }
        };
        on(Piece::Opened);
        on(Piece::Text(&text));
        Ok(Answer {
            text,
            calls: Vec::new(),
            stop: StopReason::EndTurn,
        })
    }

    fn reachable(&self) -> Result<(), BrainFailure> {
        self.conversation().map(drop)
    }

    fn address(&self) -> String {
        "endue AI".to_owned()
    }
}

/// The last thing the person said, as text.
fn last_line(messages: &[Value]) -> Option<String> {
    messages
        .iter()
        .rev()
        .find(|m| m["role"] == "user")
        .and_then(|m| m["content"].as_str())
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// A new client message id for each run, so endue AI never takes one for another.
fn message_id(n: u64) -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    format!("desk_{ms}_{n}")
}

fn failure(e: PlatformError) -> BrainFailure {
    match e.kind {
        ErrorKind::Offline => BrainFailure::Unreachable(format!("endue AI: {}", e.message)),
        ErrorKind::SignedOut => BrainFailure::Refused {
            status: 401,
            error: BrainError {
                code: BrainErrorCode::Unauthorized,
                message: e.message,
                holder: None,
            },
        },
        _ => refused(e.status.unwrap_or(500), &e.message),
    }
}

fn refused(status: u16, message: &str) -> BrainFailure {
    BrainFailure::Refused {
        status,
        error: BrainError {
            code: BrainErrorCode::Internal,
            message: message.to_owned(),
            holder: None,
        },
    }
}

#[cfg(test)]
#[path = "endue_eris_tests.rs"]
mod tests;
