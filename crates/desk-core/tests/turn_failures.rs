//! A turn that fails says why (FT-01, ADR 0405): brain.turn's error carries a reason the desk can
//! act on, a turn no brain answers ends after `give_up` instead of waiting for ever, and every
//! failed turn is in the desk's log, channel `brain`, without the person's line.

mod common;
mod support;

use std::sync::Arc;
use std::sync::mpsc::Receiver;
use std::time::Duration;

use common::free_port;
use desk_brain_endue::HttpBrain;
use desk_core::{BrainOptions, Core, Delivery, OFFLINE_LINE};
use serde_json::{Value, json};
use support::*;

/// A core whose only brain is not there, giving up after `give_up`.
fn unreachable(tag: &str, give_up: Duration) -> (Arc<Core>, Receiver<Delivery>) {
    let url = format!("http://127.0.0.1:{}/v0", free_port());
    let options = BrainOptions {
        retry: Duration::from_millis(20),
        max_retry: Duration::from_millis(40),
        give_up,
        ..BrainOptions::default()
    };
    let core =
        Core::new(roots(&home(tag))).with_brain(Arc::new(HttpBrain::new(&url).unwrap()), options);
    let core = Arc::new(core);
    core.route_tools();
    for permission in ["brain:converse", "log:read"] {
        grant(&core, "desk", json!({ "permission": permission }));
    }
    let deliveries = core.events().subscribe_addressed();
    (core, deliveries)
}

fn say(core: &Core, text: &str) -> Value {
    let params = json!({ "text": text, "scope": { "permission": "brain:converse" } });
    call(core, "desk", "brain.say", params).unwrap()["turnId"].clone()
}

/// The turn's brain.turn data, up to its error or completed.
fn turn(deliveries: &Receiver<Delivery>, id: &Value) -> Vec<Value> {
    let mut seen = Vec::new();
    loop {
        let data = wait_for(deliveries, "brain.turn").data().clone();
        if data["turnId"] != *id {
            continue;
        }
        let kind = data["kind"].as_str().unwrap_or_default().to_owned();
        seen.push(data);
        if kind == "error" || kind == "completed" {
            return seen;
        }
    }
}

#[test]
fn a_turn_no_brain_answers_ends_once_with_no_brain() {
    let (core, deliveries) = unreachable("turn-no-brain", Duration::from_millis(200));
    let id = say(&core, "hello");
    let seen = turn(&deliveries, &id);
    let offline = seen
        .iter()
        .find(|d| d["kind"] == "offline")
        .expect("offline first");
    assert_eq!(offline["reason"], "no_brain");
    let last = seen.last().unwrap();
    assert_eq!(
        (last["kind"].as_str(), last["reason"].as_str()),
        (Some("error"), Some("no_brain"))
    );
    assert_eq!(last["text"], OFFLINE_LINE);
}

#[test]
fn a_failed_turn_is_logged_without_the_persons_line() {
    let (core, deliveries) = unreachable("turn-logged", Duration::from_millis(100));
    let line = "my secret plan for friday";
    let id = say(&core, line);
    turn(&deliveries, &id);
    let tail = call(
        &core,
        "desk",
        "log.tail",
        json!({ "channel": "brain", "scope": { "permission": "log:read" } }),
    )
    .unwrap();
    let entries = tail["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 1, "{entries:?}");
    let entry = &entries[0];
    assert_eq!(entry["level"], "warn");
    assert_eq!(entry["fields"]["reason"], "no_brain");
    assert_eq!(entry["fields"]["turn"], id);
    assert!(!entry.to_string().contains(line), "{entry}");
}
