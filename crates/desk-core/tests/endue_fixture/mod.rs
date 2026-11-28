//! The fixture of the endue binding's tests (ADR 0409): a connector plugin with made-up tools
//! (`gadget__thing_read`, `gadget__thing_send`), a desk signed in to the in-process fake platform
//! with its key in a fake keychain, and the account connectors, pages and calls the fake answers.
#![allow(dead_code)]

use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use desk_core::account::{Account, AccountOptions, Keychain, NetIdClient};
use desk_core::studio_tokens;
use desk_platform::Platform;
use desk_platform::fake::{FakeConnector, FakePlatform, Seen};
use desk_sys::keychain::fake::FakeKeychain;
use serde_json::{Value, json};

use crate::layer::{Desk, connector_manage};

pub const GADGET: &str = "fixture.gadget";
pub const SEND: &str = "fixture.gadget.thing.send";

pub fn manifest() -> Value {
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
                    "id": "/id", "title": { "first": ["/title", { "pointer": "/text", "before": "\n" }] }, "body": "/text",
                    "publishedAt": "/at", "updatedAt": "/at", "url": "/url",
                    "feed": { "const": "Gadget" },
                    "raw": { "object": { "network": { "instance": "type" },
                        "studio": { "instance": "title" }, "text": "/text", "none": "/none" } } } } },
                "actions": { SEND: { "tool": "thing_send", "risk": "send", "arguments": {
                    "operation": { "const": "send" }, "text": { "arg": "text" } } } },
                "budget": 5
            }
        }
    })
}

/// A desk signed in to `fake`, its key in a fake keychain, the fixture plugin installed.
pub fn desk(tag: &str, fake: &FakePlatform) -> Desk {
    desk_with(tag, fake, "gadget", &manifest())
}

/// A desk signed in to `fake` with the plugin `manifest` installed as `plugins/<name>`.
pub fn desk_with(tag: &str, fake: &FakePlatform, name: &str, manifest: &Value) -> Desk {
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
    let dir = desk.home.join("plugins").join(name);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("plugin.json"), manifest.to_string()).unwrap();
    desk.core.install_plugin(&dir, true);
    desk
}

pub fn account(data: &Path, url: &str) -> Arc<Account> {
    let file = data.join("account.json");
    let saved = json!({ "version": 2, "note": "test", "accessToken": "token-1",
        "refreshCookie": "rt-1", "issuedAt": 1_767_225_300_u64, "expiresAt": 4_102_444_800_u64 });
    fs::write(&file, saved.to_string()).unwrap();
    let mut options = AccountOptions::new(url, "http://127.0.0.1:9");
    options.file = Some(file);
    options.retry = vec![Duration::from_millis(5); 3];
    Account::open(options, NetIdClient)
}

/// account.connectors.enable, with publish and delete so those tools may be called.
pub fn turn_on(desk: &Desk) {
    let allow = ["publish", "delete"];
    let params = json!({ "allow": allow, "scope": { "permission": "account:manage" } });
    desk.ok("desk", "account.connectors.enable", params);
}

/// An account connector of type gadget offering `endings`; its id.
pub fn gadget(fake: &FakePlatform, display: &str, endings: &[(&str, &str)]) -> String {
    connector(fake, "gadget", display, endings)
}

/// An account connector of type `kind` offering `endings` (`<kind>__<ending>`); its id.
pub fn connector(
    fake: &FakePlatform,
    kind: &str,
    display: &str,
    endings: &[(&str, &str)],
) -> String {
    let mut state = fake.state();
    let id = format!("conn_{}", state.connectors.connectors.len() + 1);
    let tools = endings.iter().map(|(ending, risk)| {
        json!({ "name": format!("{kind}__{ending}"), "risk": risk, "input_schema": {} })
    });
    state.connectors.connectors.push(FakeConnector {
        id: id.clone(),
        kind: kind.into(),
        name: kind.into(),
        display_name: Some(display.into()),
        expired: false,
        tools: tools.collect(),
    });
    id
}

pub const BOTH: [(&str, &str); 2] = [("thing_read", "read"), ("thing_send", "send")];

/// What the read tool of `connector` answers next, once each.
pub fn pages(fake: &FakePlatform, connector: &str, answers: Vec<Value>) {
    queue(fake, connector, "gadget__thing_read", answers);
}

/// What `tool` (its full name) of `connector` answers next, once each.
pub fn queue(fake: &FakePlatform, connector: &str, tool: &str, answers: Vec<Value>) {
    let key = format!("{connector}/{tool}");
    fake.state().connectors.queued.insert(key, answers.into());
}

pub fn page(items: Value, next: Option<&str>) -> Value {
    json!({ "ok": true, "content": "", "data": { "items": items, "next_cursor": next } })
}

pub fn thing(id: &str, text: &str) -> Value {
    let url = format!("https://gadget.example/{id}");
    json!({ "id": id, "text": text, "at": "2026-10-29T08:00:00Z", "url": url })
}

pub fn entries(desk: &Desk, instance: &str) -> Vec<Value> {
    let query = json!({ "sources": [format!("{GADGET}/{instance}")], "limit": 100 });
    let mut items = desk.items(query);
    items.sort_by_key(|i| i["id"].as_str().unwrap().to_owned());
    items
}

/// The calls of `tool` the fake has seen, in order.
pub fn calls(fake: &FakePlatform, connector: &str, tool: &str) -> Vec<Seen> {
    let path = format!("/api/public/v1/connectors/{connector}/tools/gadget__{tool}/call");
    fake.seen_at("POST", &path)
}

pub fn sync_now(desk: &Desk, instance: &str) -> Value {
    let params = json!({ "connector": GADGET, "instance": instance, "scope": connector_manage() });
    desk.grant("desk", connector_manage());
    desk.ok("desk", "connector.sync", params)
}

/// cmd.list of the send command as the person.
pub fn commands(desk: &Desk) -> Value {
    desk.grant("desk", json!({ "permission": "cmd:invoke", "ids": [SEND] }));
    let scope = json!({ "permission": "cmd:invoke", "ids": [SEND] });
    desk.ok("desk", "cmd.list", json!({ "scope": scope }))
}

/// cmd.invoke of the send command as the person; the cmd.answered it ends with.
pub fn send(desk: &Desk, instance: &str, text: &str) -> Value {
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
