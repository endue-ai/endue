//! A scripted brain for Eris's loop (eris_loop.rs): brain-echo for sessions and leases, with
//! turns that call example.mail's tool, and a core with example.mail installed.
#![allow(dead_code)]

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::common::Echo;
use crate::support::*;
use desk_brain::{
    Brain, BrainFailure, CreateSessionRequest, Lease, LeaseAcquireRequest, LeaseRenewRequest,
    Session, StopReason, TextDeltaEvent, ToolCall, ToolCallEvent, ToolResultRequest,
    TurnCompletedEvent, TurnEvent, TurnRequest, TurnStartedEvent,
};
use desk_brain_endue::HttpBrain;
use desk_core::{BrainOptions, Core, Delivery, LocalAgents, LocalAgentsOptions};
use serde_json::{Value, json};

pub const MAIL: &str = "example.mail";
pub const LATEST: &str = "example.mail.latest";

/// brain-echo, except that a turn offering tools calls `example_mail_latest` (forever, when
/// `endless`) and then says what the tool answered. It keeps each turn's request.
pub struct Errands {
    pub inner: HttpBrain,
    pub endless: bool,
    pub asked: Mutex<Vec<TurnRequest>>,
    pub results: Mutex<Vec<Value>>,
}

macro_rules! pass {
    ($($name:ident($($arg:ident: $ty:ty),*) -> $out:ty;)*) => {$(
        fn $name(&self, $($arg: $ty),*) -> Result<$out, BrainFailure> {
            self.inner.$name($($arg),*)
        }
    )*};
}

pub fn event(turn: &str, kind: &str, extra: Value) -> TurnEvent {
    let mut value = json!({ "type": kind, "turnId": turn });
    value
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    serde_json::from_value(value).unwrap()
}

pub fn ask_latest(turn: &str, n: usize, on: &mut dyn FnMut(TurnEvent)) {
    let call = ToolCall {
        call_id: format!("call{n}"),
        name: "example_mail_latest".to_owned(),
        arguments: json!({ "limit": 3 }).as_object().cloned().unwrap(),
        agent_id: None,
    };
    on(TurnEvent::ToolCall(ToolCallEvent {
        r#type: Default::default(),
        turn_id: turn.to_owned(),
        call,
    }));
    on(TurnEvent::TurnCompleted(TurnCompletedEvent {
        r#type: Default::default(),
        turn_id: turn.to_owned(),
        stop_reason: StopReason::ToolCall,
    }));
}

impl Brain for Errands {
    pass! {
        create_session(request: &CreateSessionRequest) -> Session;
        get_session(session: &str) -> Session;
        get_lease(session: &str) -> Lease;
        acquire_lease(session: &str, request: &LeaseAcquireRequest) -> Lease;
        renew_lease(session: &str, lease: &str, request: &LeaseRenewRequest) -> Lease;
        release_lease(session: &str, lease: &str) -> ();
    }
    fn create_turn(
        &self,
        _session: &str,
        request: &TurnRequest,
        on: &mut dyn FnMut(TurnEvent),
    ) -> Result<(), BrainFailure> {
        self.asked.lock().unwrap().push(request.clone());
        on(TurnEvent::TurnStarted(TurnStartedEvent {
            r#type: Default::default(),
            turn_id: "turn1".to_owned(),
        }));
        ask_latest("turn1", 1, on);
        Ok(())
    }
    fn submit_tool_result(
        &self,
        _session: &str,
        turn: &str,
        request: &ToolResultRequest,
        on: &mut dyn FnMut(TurnEvent),
    ) -> Result<(), BrainFailure> {
        let mut results = self.results.lock().unwrap();
        results.push(request.output.clone());
        if self.endless {
            ask_latest(turn, results.len() + 1, on);
            return Ok(());
        }
        let said = format!("You have mail: {}", request.output);
        let text = TurnEvent::TextDelta(TextDeltaEvent {
            r#type: Default::default(),
            turn_id: turn.to_owned(),
            text: said,
        });
        on(text);
        on(event(
            turn,
            "turn.completed",
            json!({ "stopReason": "end_turn" }),
        ));
        Ok(())
    }
}

/// A shared core on `brain`, with example.mail installed and its two commands registered: one a
/// tool for Eris, one not. The person says yes to every prompt.
pub fn core_on(brain: Arc<dyn Brain>, home: &Path) -> (Arc<Core>, Receiver<Delivery>) {
    core_with(brain, home, None)
}

/// `core_on`, with the agent programs in `bin` on this computer when it is given (ADR 0110).
pub fn core_with(
    brain: Arc<dyn Brain>,
    home: &Path,
    bin: Option<PathBuf>,
) -> (Arc<Core>, Receiver<Delivery>) {
    let dir = home.join("plugins/mail");
    fs::create_dir_all(dir.join("ui")).unwrap();
    fs::write(dir.join("ui/index.html"), "<p>mail</p>").unwrap();
    let manifest = json!({
        "id": MAIL, "version": "0.1.0", "kind": "ui", "entry": "ui/index.html",
        "contributes": { "commands": [
            { "id": LATEST, "title": "Latest mail", "agent": true, "readOnly": true,
                "description": "The newest messages in the inbox.",
                "args": { "type": "object", "properties": { "limit": { "type": "integer" } } } },
            { "id": "example.mail.compose", "title": "New message" },
        ] },
    });
    fs::write(dir.join("plugin.json"), manifest.to_string()).unwrap();
    let options = BrainOptions {
        retry: Duration::from_millis(50),
        ..BrainOptions::default()
    };
    let mut core = Core::new(roots(home))
        .with_prompter(SayYes)
        .with_brain(brain, options);
    if let Some(bin) = bin {
        let agents = LocalAgentsOptions {
            home: home.to_path_buf(),
            claude_home: home.join(".claude"),
            codex_home: home.join(".codex"),
            app_data: None,
            data: None,
            path: None,
            extra_path: vec![bin],
        };
        core = core.with_local_agents(LocalAgents::new(agents));
    }
    core.install_plugin(&dir, false);
    let core = Arc::new(core);
    core.route_tools();
    grant(&core, "desk", json!({ "permission": "brain:converse" }));
    grant(&core, "desk", json!({ "permission": "agents:manage" }));
    for (id, title) in [
        (LATEST, "Latest mail"),
        ("example.mail.compose", "New message"),
    ] {
        call(
            &core,
            MAIL,
            "cmd.register",
            json!({ "id": id, "title": title }),
        )
        .unwrap();
    }
    let deliveries = core.events().subscribe_addressed();
    (core, deliveries)
}

pub fn errands(echo: &Echo, endless: bool) -> Arc<Errands> {
    Arc::new(Errands {
        inner: HttpBrain::new(echo.url()).unwrap(),
        endless,
        asked: Mutex::default(),
        results: Mutex::default(),
    })
}

pub fn say(core: &Core, text: &str) -> String {
    let params = json!({ "text": text, "scope": { "permission": "brain:converse" } });
    let said = call(core, "desk", "brain.say", params).unwrap();
    said["turnId"].as_str().unwrap().to_owned()
}

/// The turn's brain.turn data up to its completed or error, answering every cmd.invoked of the
/// mail plugin with two messages.
pub fn play(core: &Core, deliveries: &Receiver<Delivery>, turn: &str) -> Vec<Value> {
    let mut steps = Vec::new();
    loop {
        let delivery = deliveries
            .recv_timeout(Duration::from_secs(10))
            .expect("a delivery within 10 s");
        let seen = serde_json::to_value(&delivery.event).unwrap();
        let data = seen["data"].clone();
        if seen["event"] == "cmd.invoked" {
            assert_eq!(data["caller"], "agent:eris");
            let answered = json!({ "invocationId": data["invocationId"],
                "result": { "messages": [{ "subject": "Lunch?" }, { "subject": "Invoice" }] } });
            call(core, MAIL, "cmd.answer", answered).unwrap();
            continue;
        }
        if seen["event"] != "brain.turn" || data["turnId"] != turn {
            continue;
        }
        let kind = data["kind"].as_str().unwrap().to_owned();
        steps.push(data);
        if kind == "completed" || kind == "error" {
            return steps;
        }
    }
}
