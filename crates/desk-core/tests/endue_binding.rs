//! The endue connector binding (ADR 0408) over a fixture plugin whose tools are made up
//! (`gadget__thing_read`, `gadget__thing_send`), so no network's name, field or limit is in the core:
//! its instances are the account's connectors that offer every tool, a sync maps what the read tool
//! answers into items, and its command calls the send tool, all with the desk's own key (ADR 0407)
//! against the in-process fake platform. Syncs run on an explicit tick and a fake clock.

mod endue_fixture;
mod layer;

use desk_platform::fake::{FakePlatform, Seen};
use endue_fixture::*;
use layer::fixtures::state;
use layer::{ids, source};
use serde_json::{Value, json};
#[test]
fn instances_are_the_account_connectors_that_offer_every_tool() {
    let fake = FakePlatform::start();
    let a = gadget(&fake, "Studio A", &BOTH);
    let b = gadget(&fake, "Studio B", &BOTH);
    gadget(&fake, "Read only", &BOTH[..1]);
    pages(&fake, &a, vec![page(json!([thing("t1", "Hello")]), None)]);
    let desk = desk("endue-instances", &fake);
    turn_on(&desk);
    desk.tick();

    let listed = desk.instances(GADGET);
    let names: Vec<&str> = listed
        .iter()
        .map(|i| i["instance"].as_str().unwrap())
        .collect();
    assert_eq!(names, [a.as_str(), b.as_str()], "{listed:?}");
    assert_eq!(listed[0]["title"], "Studio A");
    assert_eq!(listed[1]["title"], "Studio B");
    assert_eq!(state(&listed[0]), "connected");
    assert_eq!(ids(&entries(&desk, &a)), ["t1"]);

    fake.state().connectors.connectors.retain(|c| c.id != a);
    desk.clock.advance(900);
    desk.tick();
    let listed = desk.instances(GADGET);
    assert_eq!(listed.len(), 1, "the connector that left took its instance");
    assert_eq!(listed[0]["instance"], b);
    assert!(entries(&desk, &a).is_empty(), "and its items");
}

#[test]
fn a_sync_maps_tool_answers_into_items_and_keeps_the_cursor() {
    let fake = FakePlatform::start();
    let a = gadget(&fake, "Studio A", &BOTH);
    let first = page(json!([thing("t1", "Hello\nthere")]), Some("c2"));
    pages(
        &fake,
        &a,
        vec![first, page(json!([thing("t2", "Again")]), None)],
    );
    let desk = desk("endue-sync", &fake);
    turn_on(&desk);
    let started = desk.clock.text();
    desk.tick();

    let items = entries(&desk, &a);
    assert_eq!(ids(&items), ["t1", "t2"]);
    assert_eq!(items[0]["kind"], "entry");
    assert_eq!(items[0]["source"], source(GADGET, &a));
    assert_eq!(items[0]["body"], "Hello\nthere");
    assert_eq!(items[0]["title"], "Hello", "before keeps the first line");
    assert_eq!(
        items[0]["raw"],
        json!({ "network": "gadget", "studio": "Studio A", "text": "Hello\nthere" }),
        "an object of values, the instance's type and title among them; one that reads nothing is left out"
    );
    assert_eq!(
        items[1]["title"], "Again",
        "a value without the text is kept whole"
    );
    assert_eq!(items[0]["publishedAt"], "2026-10-29T08:00:00Z");
    let seen = calls(&fake, &a, "thing_read");
    let arguments: Vec<&Value> = seen.iter().map(|s| &s.body["arguments"]).collect();
    assert_eq!(
        arguments,
        [
            &json!({ "operation": "things" }),
            &json!({ "operation": "things", "cursor": "c2" })
        ]
    );
    for call in &seen {
        assert!(
            call.headers["authorization"].starts_with("Bearer sk_"),
            "the desk's own key"
        );
    }

    pages(&fake, &a, vec![page(json!([thing("t3", "New")]), None)]);
    desk.clock.advance(900);
    desk.tick();
    let last = calls(&fake, &a, "thing_read").pop().unwrap();
    assert_eq!(
        last.body["arguments"],
        json!({ "operation": "things", "since": started })
    );
    assert_eq!(
        ids(&entries(&desk, &a)),
        ["t1", "t2", "t3"],
        "a request with since only adds"
    );
}

#[test]
fn a_record_that_is_not_an_item_is_skipped_and_counted() {
    let fake = FakePlatform::start();
    let a = gadget(&fake, "Studio A", &BOTH);
    let records = json!([thing("t1", "Fine"), { "text": "no id" }]);
    pages(&fake, &a, vec![page(records, None)]);
    let desk = desk("endue-skipped", &fake);
    turn_on(&desk);
    desk.tick();
    assert_eq!(ids(&entries(&desk, &a)), ["t1"]);
    let listed = desk.instances(GADGET);
    assert_eq!(state(&listed[0]), "connected");
    assert_eq!(listed[0]["settings"]["skipped"], 1, "{listed:?}");
}

#[test]
fn a_truncated_or_refused_answer_fails_the_sync_whole() {
    let fake = FakePlatform::start();
    let a = gadget(&fake, "Studio A", &BOTH);
    let mut cut = page(json!([thing("t1", "Half")]), None);
    cut["truncated"] = json!(true);
    let refused = json!({ "ok": false, "content": "The gadget service is down for maintenance." });
    pages(&fake, &a, vec![cut, refused]);
    let desk = desk("endue-fails", &fake);
    turn_on(&desk);
    desk.tick();
    let listed = desk.instances(GADGET);
    assert_eq!(state(&listed[0]), "error");
    assert!(
        listed[0]["status"]["error"]["message"]
            .as_str()
            .unwrap()
            .contains("part")
    );
    assert!(
        entries(&desk, &a).is_empty(),
        "half an answer is never mapped"
    );

    sync_now(&desk, &a);
    let listed = desk.instances(GADGET);
    assert_eq!(state(&listed[0]), "error");
    assert_eq!(
        listed[0]["status"]["error"]["message"],
        "The gadget service is down for maintenance."
    );
    assert!(entries(&desk, &a).is_empty());
}

#[test]
fn a_sync_spends_its_budget_and_waits_as_the_limit_asks() {
    let fake = FakePlatform::start();
    let a = gadget(&fake, "Studio A", &BOTH);
    let endless: Vec<Value> = (0..8)
        .map(|n| {
            page(
                json!([thing(&format!("t{n}"), "More")]),
                Some(&format!("c{}", n + 1)),
            )
        })
        .collect();
    pages(&fake, &a, endless);
    let desk = desk("endue-budget", &fake);
    turn_on(&desk);
    desk.tick();
    assert_eq!(
        calls(&fake, &a, "thing_read").len(),
        5,
        "the fixture's budget"
    );
    assert_eq!(entries(&desk, &a).len(), 5, "what it read is written");

    fake.state().connectors.queued.clear();
    let empty = page(json!([]), None);
    fake.state()
        .connectors
        .answers
        .insert(format!("{a}/gadget__thing_read"), empty);
    {
        let mut state = fake.state();
        let headers = &mut state.connectors.headers;
        headers.insert("x-ratelimit-remaining".into(), "0".into());
        headers.insert("x-ratelimit-reset".into(), "3600".into());
    }
    desk.clock.advance(900);
    desk.tick();
    assert_eq!(
        calls(&fake, &a, "thing_read").len(),
        6,
        "one call, then no calls left"
    );
    fake.state().connectors.headers.clear();
    desk.clock.advance(900);
    desk.tick();
    assert_eq!(
        calls(&fake, &a, "thing_read").len(),
        6,
        "due moved past the wait"
    );
    desk.clock.advance(2_700);
    desk.tick();
    assert_eq!(calls(&fake, &a, "thing_read").len(), 7);

    fake.state().connectors.limited = Some(1_800);
    desk.clock.advance(900);
    desk.tick();
    let listed = desk.instances(GADGET);
    assert_eq!(
        state(&listed[0]),
        "connected",
        "a 429 is a wait, not a failure: {listed:?}"
    );
    desk.clock.advance(900);
    desk.tick();
    assert_eq!(
        calls(&fake, &a, "thing_read").len(),
        7,
        "nothing until the 429's wait is over"
    );
    desk.clock.advance(900);
    desk.tick();
    assert_eq!(calls(&fake, &a, "thing_read").len(), 8);
}

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

#[test]
fn an_expired_connector_is_error_with_reauth() {
    let fake = FakePlatform::start();
    let a = gadget(&fake, "Studio A", &BOTH);
    fake.state().connectors.connectors[0].expired = true;
    let desk = desk("endue-expired", &fake);
    turn_on(&desk);
    desk.tick();
    let listed = desk.instances(GADGET);
    assert_eq!(listed[0]["instance"], a);
    assert_eq!(state(&listed[0]), "error");
    assert_eq!(listed[0]["status"]["error"]["reauth"], true);
    assert!(
        listed[0]["status"]["error"]["message"]
            .as_str()
            .unwrap()
            .contains("Studio A")
    );
}

#[test]
fn with_the_feature_off_instances_are_paused_and_say_how_to_turn_it_on() {
    let fake = FakePlatform::start();
    let a = gadget(&fake, "Studio A", &BOTH);
    let desk = desk("endue-off", &fake);
    desk.tick();
    assert!(
        desk.instances(GADGET).is_empty(),
        "off: no instance, no call"
    );
    assert!(calls(&fake, &a, "thing_read").is_empty());

    turn_on(&desk);
    desk.tick();
    assert_eq!(desk.instances(GADGET).len(), 1);
    let params = json!({ "scope": { "permission": "account:manage" } });
    desk.ok("desk", "account.connectors.disable", params);
    sync_now(&desk, &a);
    let listed = desk.instances(GADGET);
    assert_eq!(state(&listed[0]), "paused");
    let why = listed[0]["status"]["error"]["message"].as_str().unwrap();
    assert!(why.contains("Settings"), "{why}");
}

#[test]
fn removing_the_plugin_removes_its_instances_items_and_store() {
    let fake = FakePlatform::start();
    let a = gadget(&fake, "Studio A", &BOTH);
    pages(&fake, &a, vec![page(json!([thing("t1", "Hello")]), None)]);
    let desk = desk("endue-remove", &fake);
    turn_on(&desk);
    desk.tick();
    assert_eq!(entries(&desk, &a).len(), 1);
    assert!(desk.core.remove_plugin(GADGET));
    assert!(entries(&desk, &a).is_empty());
    assert!(!desk.connectors().iter().any(|c| c["id"] == GADGET));
    let store = std::fs::read_to_string(desk.data.join("store.json")).unwrap_or_default();
    assert!(!store.contains(GADGET), "its store went with it");
    assert_eq!(commands(&desk)["commands"], json!([]));
}

#[test]
fn the_plugin_needs_no_net_fetch() {
    let fake = FakePlatform::start();
    let a = gadget(&fake, "Studio A", &BOTH);
    pages(&fake, &a, vec![page(json!([thing("t1", "Hello")]), None)]);
    let desk = desk("endue-no-fetch", &fake);
    turn_on(&desk);
    desk.tick();
    assert_eq!(
        state(&desk.instances(GADGET)[0]),
        "connected",
        "with no grant asked"
    );
    assert_eq!(entries(&desk, &a).len(), 1);
    let asked = desk.drain();
    let prompts = asked
        .iter()
        .filter(|(_, e)| e["event"] == "perm.requested")
        .count();
    assert_eq!(prompts, 0);
}
