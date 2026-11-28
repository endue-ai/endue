//! The endue connector binding (ADR 0408) over a fixture plugin whose tools are made up
//! (`gadget__thing_read`, `gadget__thing_send`), so no network's name, field or limit is in the core:
//! its instances are the account's connectors that offer every tool, a sync maps what the read tool
//! answers into items, and its command calls the send tool, all with the desk's own key (ADR 0407)
//! against the in-process fake platform. Syncs run on an explicit tick and a fake clock.

mod layer;

use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use desk_core::account::{Account, AccountOptions, Keychain, NetIdClient};
use desk_core::studio_tokens;
use desk_platform::Platform;
use desk_platform::fake::{FakeConnector, FakePlatform, Seen};
use desk_sys::keychain::fake::FakeKeychain;
use layer::fixtures::state;
use layer::{Desk, connector_manage, ids, source};
use serde_json::{Value, json};

const GADGET: &str = "fixture.gadget";
const SEND: &str = "fixture.gadget.thing.send";

fn manifest() -> Value {
    let args = json!({ "type": "object", "required": ["instance", "text"],
        "properties": { "instance": { "type": "string" }, "text": { "type": "string" } } });
    json!({
        "id": GADGET, "name": "Gadget", "version": "0.1.0", "kind": "connector",
        "description": "Things from the endue account's gadget connectors.",
        "contributes": { "commands": [{ "id": SEND, "title": "Send a thing", "irreversible": true,
            "agent": true, "description": "Send a thing from an instance.", "args": args }] },
        "connector": {
            "binding": "endue", "auth": { "kind": "endue" },
            "resources": [{ "kind": "entry", "actions": [SEND] }],
            "sync": { "mode": "pull", "intervalSeconds": 900 },
            "endue": {
                "tools": ["thing_read", "thing_send"],
                "requests": [{ "tool": "thing_read", "items": "/items", "next": "/next_cursor",
                    "arguments": { "operation": { "const": "things" }, "cursor": { "page": true },
                        "since": { "since": true } },
                    "map": "thing" }],
                "maps": { "thing": { "kind": "entry", "fields": {
                    "id": "/id", "title": "/text", "body": "/text", "publishedAt": "/at",
                    "updatedAt": "/at", "url": "/url", "feed": { "const": "Gadget" },
                    "raw": "" } } },
                "actions": { SEND: { "tool": "thing_send", "risk": "send", "arguments": {
                    "operation": { "const": "send" }, "text": { "arg": "text" } } } },
                "budget": 5
            }
        }
    })
}

/// A desk signed in to `fake`, its key in a fake keychain, the fixture plugin installed.
fn desk(tag: &str, fake: &FakePlatform) -> Desk {
    let keychain = Arc::new(FakeKeychain::default());
    let url = fake.url().to_owned();
    let desk = Desk::built(tag, move |core, data| {
        let account = account(data, &url);
        let platform = Platform::new(&url, studio_tokens(&account)).unwrap();
        core.with_account(account)
            .with_platform(platform)
            .with_account_connectors(Some(keychain as Arc<dyn Keychain>))
    });
    desk.grant("desk", json!({ "permission": "account:manage" }));
    let dir = desk.home.join("plugins/gadget");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("plugin.json"), manifest().to_string()).unwrap();
    desk.core.install_plugin(&dir, true);
    desk
}

fn account(data: &Path, url: &str) -> Arc<Account> {
    let file = data.join("account.json");
    let saved = json!({ "version": 2, "note": "test", "accessToken": "token-1",
        "refreshCookie": "rt-1", "issuedAt": 1_767_225_300_u64, "expiresAt": 4_102_444_800_u64 });
    fs::write(&file, saved.to_string()).unwrap();
    let mut options = AccountOptions::new(url, "http://127.0.0.1:9");
    options.file = Some(file);
    options.retry = vec![Duration::from_millis(5); 3];
    Account::open(options, NetIdClient)
}

/// account.connectors.enable, with publish so the send tool may be called.
fn turn_on(desk: &Desk) {
    let params = json!({ "allow": ["publish"], "scope": { "permission": "account:manage" } });
    desk.ok("desk", "account.connectors.enable", params);
}

/// An account connector of type gadget offering `endings`; its id.
fn gadget(fake: &FakePlatform, display: &str, endings: &[(&str, &str)]) -> String {
    let mut state = fake.state();
    let id = format!("conn_{}", state.connectors.connectors.len() + 1);
    let tools = endings.iter().map(|(ending, risk)| {
        json!({ "name": format!("gadget__{ending}"), "risk": risk, "input_schema": {} })
    });
    state.connectors.connectors.push(FakeConnector {
        id: id.clone(),
        kind: "gadget".into(),
        name: "gadget".into(),
        display_name: Some(display.into()),
        expired: false,
        tools: tools.collect(),
    });
    id
}

const BOTH: [(&str, &str); 2] = [("thing_read", "read"), ("thing_send", "send")];

/// What the read tool of `connector` answers next, once each.
fn pages(fake: &FakePlatform, connector: &str, answers: Vec<Value>) {
    let key = format!("{connector}/gadget__thing_read");
    fake.state().connectors.queued.insert(key, answers.into());
}

fn page(items: Value, next: Option<&str>) -> Value {
    json!({ "ok": true, "content": "", "data": { "items": items, "next_cursor": next } })
}

fn thing(id: &str, text: &str) -> Value {
    let url = format!("https://gadget.example/{id}");
    json!({ "id": id, "text": text, "at": "2026-10-29T08:00:00Z", "url": url })
}

fn entries(desk: &Desk, instance: &str) -> Vec<Value> {
    let query = json!({ "sources": [format!("{GADGET}/{instance}")], "limit": 100 });
    let mut items = desk.items(query);
    items.sort_by_key(|i| i["id"].as_str().unwrap().to_owned());
    items
}

/// The calls of `tool` the fake has seen, in order.
fn calls(fake: &FakePlatform, connector: &str, tool: &str) -> Vec<Seen> {
    let path = format!("/api/public/v1/connectors/{connector}/tools/gadget__{tool}/call");
    fake.seen_at("POST", &path)
}

fn sync_now(desk: &Desk, instance: &str) -> Value {
    let params = json!({ "connector": GADGET, "instance": instance, "scope": connector_manage() });
    desk.grant("desk", connector_manage());
    desk.ok("desk", "connector.sync", params)
}

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

/// cmd.list of the send command as the person.
fn commands(desk: &Desk) -> Value {
    desk.grant("desk", json!({ "permission": "cmd:invoke", "ids": [SEND] }));
    let scope = json!({ "permission": "cmd:invoke", "ids": [SEND] });
    desk.ok("desk", "cmd.list", json!({ "scope": scope }))
}

/// cmd.invoke of the send command as the person; the cmd.answered it ends with.
fn send(desk: &Desk, instance: &str, text: &str) -> Value {
    desk.grant("desk", json!({ "permission": "cmd:invoke", "ids": [SEND] }));
    let scope = json!({ "permission": "cmd:invoke", "ids": [SEND] });
    let args = json!({ "instance": instance, "text": text });
    let started = desk.ok(
        "desk",
        "cmd.invoke",
        json!({ "id": SEND, "args": args, "scope": scope }),
    );
    loop {
        let (_, data) = desk.wait_for("cmd.answered");
        if data["invocationId"] == started["invocationId"] {
            return data;
        }
    }
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
    let store = fs::read_to_string(desk.data.join("store.json")).unwrap_or_default();
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
