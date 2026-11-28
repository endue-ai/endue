//! Eris's agentic loop (ADR 0089): every brain.say turn offers the agent commands (ADR 0088), the
//! core runs a call of one that names no agent as `agent:eris` through cmd.invoke, its answer goes
//! back to the brain, and the turn shows each hand-off as `tool` and `tool-result` steps. The brain
//! here is examples/brain-echo for sessions and leases, with scripted turns.

mod common;
mod eris_brain;
mod support;

use std::fs;
use std::sync::Arc;
use std::sync::mpsc::Receiver;
use std::time::Duration;

use common::Echo;
use desk_brain::{
    Brain, BrainFailure, CreateSessionRequest, Lease, LeaseAcquireRequest, LeaseRenewRequest,
    Session, ToolResultRequest, TurnEvent, TurnRequest,
};
use desk_brain_endue::HttpBrain;
use desk_core::{Core, Delivery, MAX_STEPS, TOO_MANY_LINE};
use serde_json::{Value, json};
use support::*;

use eris_brain::*;

#[test]
fn a_turn_offers_the_commands_plugins_mark_as_tools() {
    let echo = Echo::start();
    let home = home("eris-offer");
    let brain = errands(&echo, false);
    let (core, deliveries) = core_on(brain.clone(), &home);
    let turn = say(&core, "Check my latest mail");
    play(&core, &deliveries, &turn);
    let asked = brain.asked.lock().unwrap().remove(0);
    let offered = asked.tools.unwrap_or_default();
    let names: Vec<&str> = offered.iter().map(|t| t.name.as_str()).collect();
    // The desk's two tools, then the agent command by name; the palette-only one is not offered.
    assert_eq!(names, ["desk-tools", "desk-run", "example_mail_latest"]);
    let latest = &offered[2];
    assert!(
        latest
            .description
            .contains("The newest messages in the inbox.")
    );
    assert_eq!(latest.schema["properties"]["limit"]["type"], "integer");
}

#[test]
fn about_names_the_window_in_what_the_brain_reads() {
    let echo = Echo::start();
    let home = home("eris-about");
    let brain = errands(&echo, false);
    let (core, deliveries) = core_on(brain.clone(), &home);
    let window = |id: &str, plugin: &str| {
        json!({ "id": id, "x": 0, "y": 0, "w": 400, "h": 300,
        "panes": [{ "view": format!("plugin:{plugin}"), "plugin": plugin }] })
    };
    let desk = json!({ "screen": { "w": 1440, "h": 900 }, "about": { "windows": ["mail"] },
        "windows": [window("git", "example.git"), window("mail", MAIL)] });
    let params = json!({ "text": "what is new here?", "desk": desk,
        "scope": { "permission": "brain:converse" } });
    let said = call(&core, "desk", "brain.say", params).unwrap();
    play(&core, &deliveries, said["turnId"].as_str().unwrap());
    let asked = brain.asked.lock().unwrap().remove(0);
    let words = asked.message.content[0].text.clone();
    let about = "[The line is about mail: \"this\" and \"here\" mean it; use it first.]";
    assert_eq!(words.lines().nth(1), Some(about), "{words}");
    // An address grants nothing: the turn offers the same tools.
    let tools = asked.tools.unwrap_or_default();
    assert!(tools.iter().any(|t| t.name == "example_mail_latest"));
}

#[test]
fn eris_goes_to_the_plugin_and_comes_back_with_its_answer() {
    let echo = Echo::start();
    let home = home("eris-errand");
    let brain = errands(&echo, false);
    let (core, deliveries) = core_on(brain.clone(), &home);
    let turn = say(&core, "Check my latest mail");
    let steps = play(&core, &deliveries, &turn);
    let kinds: Vec<&str> = steps.iter().map(|s| s["kind"].as_str().unwrap()).collect();
    assert_eq!(
        kinds,
        ["started", "tool", "tool-result", "delta", "completed"]
    );
    let tool = json!({ "callId": "call1", "command": LATEST, "provider": MAIL,
        "title": "Latest mail" });
    assert_eq!(steps[1]["tool"], tool);
    let mut back = tool.clone();
    back["ok"] = json!(true);
    assert_eq!(steps[2]["tool"], back);
    assert!(steps[3]["text"].as_str().unwrap().contains("Lunch?"));
    let results = brain.results.lock().unwrap();
    assert_eq!(results[0]["messages"][1]["subject"], "Invoice");
}

#[test]
fn a_turn_that_keeps_calling_tools_ends_after_max_steps() {
    let echo = Echo::start();
    let home = home("eris-endless");
    let brain = errands(&echo, true);
    let (core, deliveries) = core_on(brain.clone(), &home);
    let turn = say(&core, "Check my latest mail");
    let steps = play(&core, &deliveries, &turn);
    let last = steps.last().unwrap();
    assert_eq!(last["kind"], "error");
    assert_eq!(last["text"], TOO_MANY_LINE);
    assert_eq!(brain.results.lock().unwrap().len(), MAX_STEPS);
}

#[test]
fn brain_echo_calls_the_tool_the_message_names_and_says_its_answer() {
    let echo = Echo::start();
    let home = home("eris-echo");
    let brain = Arc::new(HttpBrain::new(echo.url()).unwrap());
    let (core, deliveries) = core_on(brain, &home);
    let turn = say(&core, "Check my latest mail");
    let steps = play(&core, &deliveries, &turn);
    let kinds: Vec<&str> = steps.iter().map(|s| s["kind"].as_str().unwrap()).collect();
    let tool = kinds
        .iter()
        .position(|k| *k == "tool")
        .expect("a tool step");
    assert_eq!(kinds[tool + 1], "tool-result");
    assert_eq!(steps[tool]["tool"]["command"], LATEST);
    let said: String = steps.iter().filter_map(|s| s["text"].as_str()).collect();
    assert!(
        said.contains("The example_mail_latest tool said:"),
        "{said}"
    );
    assert!(said.contains("Lunch?"), "{said}");
}

/// brain-echo for sessions and leases, refusing every turn as endue AI refuses a desk without a
/// good endue ID token.
struct WantsToken(HttpBrain);

impl Brain for WantsToken {
    fn create_session(&self, request: &CreateSessionRequest) -> Result<Session, BrainFailure> {
        self.0.create_session(request)
    }
    fn get_session(&self, session: &str) -> Result<Session, BrainFailure> {
        self.0.get_session(session)
    }
    fn get_lease(&self, session: &str) -> Result<Lease, BrainFailure> {
        self.0.get_lease(session)
    }
    fn acquire_lease(&self, s: &str, r: &LeaseAcquireRequest) -> Result<Lease, BrainFailure> {
        self.0.acquire_lease(s, r)
    }
    fn renew_lease(&self, s: &str, l: &str, r: &LeaseRenewRequest) -> Result<Lease, BrainFailure> {
        self.0.renew_lease(s, l, r)
    }
    fn release_lease(&self, session: &str, lease: &str) -> Result<(), BrainFailure> {
        self.0.release_lease(session, lease)
    }
    fn create_turn(
        &self,
        _session: &str,
        _request: &TurnRequest,
        _on: &mut dyn FnMut(TurnEvent),
    ) -> Result<(), BrainFailure> {
        let error = json!({ "code": "unauthorized", "message": "Sign in with endue ID." });
        Err(BrainFailure::Refused {
            status: 401,
            error: serde_json::from_value(error).unwrap(),
        })
    }
    fn submit_tool_result(
        &self,
        session: &str,
        turn: &str,
        request: &ToolResultRequest,
        on: &mut dyn FnMut(TurnEvent),
    ) -> Result<(), BrainFailure> {
        self.0.submit_tool_result(session, turn, request, on)
    }
}

#[test]
fn a_brain_that_wants_an_endue_id_token_has_eris_ask_the_person_to_sign_in() {
    let echo = Echo::start();
    let home = home("eris-sign-in");
    let brain = Arc::new(WantsToken(HttpBrain::new(echo.url()).unwrap()));
    let (core, deliveries) = core_on(brain, &home);
    let turn = say(&core, "Check my latest mail");
    let steps = play(&core, &deliveries, &turn);
    let last = steps.last().unwrap();
    assert_eq!(last["kind"], "error");
    assert_eq!(last["text"], desk_core::SIGN_IN_LINE);
}

/// The data of the next event named `event` (and, for brain.turn, of `turn` and one of `kinds`).
fn next(deliveries: &Receiver<Delivery>, event: &str, turn: &str, kinds: &[&str]) -> Value {
    loop {
        let delivery = deliveries
            .recv_timeout(Duration::from_secs(10))
            .expect("a delivery within 10 s");
        let seen = serde_json::to_value(&delivery.event).unwrap();
        let data = seen["data"].clone();
        let kind = data["kind"].as_str().unwrap_or_default();
        let ours = event != "brain.turn" || (data["turnId"] == turn && kinds.contains(&kind));
        if seen["event"] == event && ours {
            return data;
        }
    }
}

fn stop(core: &Core, caller: &str, turn: &str) -> Result<Value, desk_bridge::BridgeError> {
    let params = json!({ "turnId": turn, "scope": { "permission": "brain:converse" } });
    call(core, caller, "brain.stop", params)
}

#[test]
fn stop_starts_no_further_call_and_ends_the_turn_as_stopped() {
    let echo = Echo::start();
    let home = home("eris-stop");
    let brain = errands(&echo, true);
    let (core, deliveries) = core_on(brain.clone(), &home);
    let turn = say(&core, "Check my latest mail");
    next(&deliveries, "cmd.invoked", &turn, &[]);
    // Only the caller that said the line stops it.
    grant(&core, MAIL, json!({ "permission": "brain:converse" }));
    let other = stop(&core, MAIL, &turn).unwrap_err();
    assert_eq!(
        serde_json::to_value(other.code).unwrap(),
        "permission_denied"
    );
    assert_eq!(stop(&core, "desk", &turn).unwrap()["stopped"], true);
    let end = next(&deliveries, "brain.turn", &turn, &["error", "completed"]);
    assert_eq!(end["reason"], "stopped");
    assert_eq!(end["text"], "Stopped.");
    // The call in flight is not answered to the brain, and nothing more of the turn is said.
    std::thread::sleep(Duration::from_millis(400));
    assert!(brain.results.lock().unwrap().is_empty());
    let after: Vec<Value> = deliveries
        .try_iter()
        .map(|d| serde_json::to_value(&d.event).unwrap())
        .filter(|e| e["event"] == "cmd.invoked" || e["data"]["turnId"] == turn.as_str())
        .collect();
    assert_eq!(after, Vec::<Value>::new());
    assert_eq!(stop(&core, "desk", &turn).unwrap()["stopped"], false);
}

#[cfg(unix)]
#[test]
fn stop_ends_a_local_run_the_turn_started() {
    use std::os::unix::fs::PermissionsExt;
    let echo = Echo::start();
    let home = home("eris-stop-run");
    let bin = home.join("bin");
    fs::create_dir_all(&bin).unwrap();
    let codex = bin.join("codex");
    fs::write(&codex, "#!/bin/sh\nexec /bin/sleep 30\n").unwrap();
    fs::set_permissions(&codex, fs::Permissions::from_mode(0o755)).unwrap();
    let (core, deliveries) = core_with(errands(&echo, false), &home, Some(bin));
    let turn = say(&core, "Ask Codex to rename the loader");
    next(&deliveries, "cmd.invoked", &turn, &[]);
    // The command the turn waits on starts a local run, as desk.agents.ask does.
    let ask = json!({ "agent": "codex", "prompt": "Rename the loader",
        "scope": { "permission": "agents:manage" } });
    let run = call(&core, "desk", "agents.ask", ask).unwrap()["run"]["runId"].clone();
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(stop(&core, "desk", &turn).unwrap()["stopped"], true);
    let runs = json!({ "agent": "codex", "scope": { "permission": "agents:manage" } });
    let runs = call(&core, "desk", "agents.runs", runs).unwrap()["runs"].clone();
    let ours = runs
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["runId"] == run)
        .unwrap();
    assert_eq!(ours["state"], "stopped");
}

#[test]
fn a_failed_call_carries_its_message_first_line() {
    let echo = Echo::start();
    let home = home("eris-failed-call");
    let (core, deliveries) = core_on(errands(&echo, false), &home);
    let turn = say(&core, "Check my latest mail");
    let invoked = next(&deliveries, "cmd.invoked", &turn, &[]);
    let failure = json!({ "code": "failed",
        "message": "The inbox is not reachable\n  at fetch (mail.js:12)" });
    let answered = json!({ "invocationId": invoked["invocationId"], "error": failure });
    call(&core, MAIL, "cmd.answer", answered).unwrap();
    let back = next(&deliveries, "brain.turn", &turn, &["tool-result"]);
    assert_eq!(back["tool"]["ok"], false);
    assert_eq!(back["tool"]["message"], "The inbox is not reachable");
}
