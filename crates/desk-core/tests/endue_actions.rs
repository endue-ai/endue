//! The endue connector binding's commands (ADR 0408) over the fixture plugin: the core answers its
//! action with one call of the made-up send tool, one idempotency key per invocation, and the tool's
//! own words when it refuses.

mod endue_fixture;
mod layer;

use desk_platform::fake::{FakePlatform, Seen};
use endue_fixture::*;
use serde_json::json;

#[test]
fn a_command_runs_its_tool_with_one_idempotency_key_per_invocation() {
    let fake = FakePlatform::start();
    let a = gadget(&fake, "Studio A", &BOTH);
    let sent = json!({ "ok": true, "content": "sent", "data": { "id": "p1", "url": "https://gadget.example/p1" } });
    fake.state()
        .connectors
        .answers
        .insert(format!("{a}/gadget__thing_send"), sent);
    let desk = desk("endue-command", &fake);
    turn_on(&desk);
    desk.tick();
    let listed = commands(&desk);
    assert_eq!(listed["commands"][0]["provider"], GADGET);
    assert_eq!(listed["commands"][0]["irreversible"], true);

    fake.state().connectors.failing = Some(503);
    let answered = send(&desk, &a, "Hello");
    assert_eq!(answered["ok"], true, "{answered}");
    assert_eq!(
        answered["result"],
        json!({ "id": "p1", "url": "https://gadget.example/p1" })
    );
    let seen = calls(&fake, &a, "thing_send");
    assert_eq!(seen.len(), 2, "the lost answer was retried");
    assert_eq!(
        seen[1].body["arguments"],
        json!({ "operation": "send", "text": "Hello" })
    );
    let key = |s: &Seen| s.headers["idempotency-key"].clone();
    assert_eq!(key(&seen[0]), key(&seen[1]), "a retry carries the same key");
    send(&desk, &a, "Again");
    let seen = calls(&fake, &a, "thing_send");
    assert_ne!(key(&seen[2]), key(&seen[1]), "a new invocation, a new key");
}

#[test]
fn a_refusal_is_the_commands_error_in_the_tools_words() {
    let fake = FakePlatform::start();
    let a = gadget(&fake, "Studio A", &BOTH);
    let refused = json!({ "ok": false, "content": "Things longer than 10 characters are refused.",
        "error": { "reason": "invalid", "message": "too long" } });
    fake.state()
        .connectors
        .answers
        .insert(format!("{a}/gadget__thing_send"), refused);
    let desk = desk("endue-refusal", &fake);
    turn_on(&desk);
    desk.tick();
    let answered = send(&desk, &a, "A thing that is too long");
    assert_eq!(answered["ok"], false);
    assert_eq!(
        answered["error"]["message"],
        "Things longer than 10 characters are refused."
    );
}
