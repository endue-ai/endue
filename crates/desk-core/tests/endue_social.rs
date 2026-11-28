//! `endue.social` (plugins/social) over the endue binding (ADR 0409): two account connectors of
//! different networks answer the social tool shape, and their posts, replies and mentions become
//! `entry` items with the social profile in `raw`, the account a `record`, its numbers `metric`
//! items, all as the item vectors in specs/item/v0 say; publishing, replying and deleting are three
//! irreversible commands.

mod endue_fixture;
mod layer;

use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

use desk_platform::fake::{FakePlatform, Seen};
use endue_fixture::{connector, desk_with, queue, turn_on};
use layer::Desk;
use layer::fixtures::state;
use serde_json::{Value, json};

const SOCIAL: &str = "endue.social";
const TOOLS: [(&str, &str); 3] = [
    ("social_read", "read"),
    ("social_publish", "send"),
    ("social_delete", "destructive"),
];

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn json_at(path: &str) -> Value {
    serde_json::from_str(&fs::read_to_string(repo().join(path)).unwrap()).unwrap()
}

/// The item a vector holds.
fn vector(name: &str) -> Value {
    json_at(&format!("specs/item/v0/vectors/valid/{name}.json"))["instance"].clone()
}

fn desk(tag: &str, fake: &FakePlatform) -> Desk {
    let desk = desk_with(tag, fake, "social", &json_at("plugins/social/plugin.json"));
    turn_on(&desk);
    desk
}

fn ok(data: Value) -> Value {
    json!({ "ok": true, "content": "", "data": data })
}

fn unsupported(what: &str) -> Value {
    json!({ "ok": false, "content": format!("This network has no {what}."),
        "error": { "reason": "unsupported", "message": "unsupported" } })
}

/// A post as the read tool gives it; `counts` as the network says them.
fn post(id: &str, kind: &str, text: &str, counts: Value) -> Value {
    json!({ "id": id, "kind": kind, "url": format!("https://instagram.example/p/{id}"),
        "text": text, "created_at": "2026-11-20T09:00:00Z",
        "author": { "id": "1784", "handle": "studio", "name": "Studio",
            "avatar_url": "https://cdn.example/studio.jpg" },
        "self": kind == "post", "media": [], "counts": counts })
}

/// The Instagram connector: the vectors' post, a mention in the inbox, its profile and numbers.
fn instagram(fake: &FakePlatform) -> String {
    let id = connector(fake, "instagram", "Studio on Instagram", &TOOLS);
    let mut first = post(
        "18011",
        "post",
        "Autumn drop\nNew colors in the shop today.",
        json!({}),
    );
    first["counts"] = json!({ "likes": 12, "replies": 3 });
    first["media"] = vector("entry-social-post")["raw"]["media"].clone();
    let mention = post(
        "18020",
        "mention",
        "Love this @studio",
        json!({ "likes": 1 }),
    );
    let numbers = vector("metric-social-followers");
    let series = json!([
        { "metric": "followers", "unit": "count", "points": numbers["points"] },
        { "metric": "reach", "unit": "count", "points": [{ "t": "2026-11-28T00:00:00Z", "v": 340 }] },
        { "metric": "engagement", "unit": "ratio", "points": [{ "t": "2026-11-28T00:00:00Z", "v": 0.04 }] }
    ]);
    let answers = vec![
        ok(vector("record-social-account")["fields"].clone()),
        ok(json!({ "items": [first] })),
        ok(json!({ "items": [mention] })),
        ok(json!({ "scope": "account", "period": "day", "series": series })),
    ];
    queue(fake, &id, "instagram__social_read", answers);
    id
}

/// The Reddit connector: the vectors' reply; no inbox and no numbers.
fn reddit(fake: &FakePlatform) -> String {
    let id = connector(fake, "reddit", "Studio on Reddit", &TOOLS);
    let reply = json!({ "id": "t1_k2", "kind": "reply", "destination": "r_studio",
        "url": "https://reddit.example/r/studio/comments/k1/_/k2", "text": "Thanks, glad you like it!",
        "created_at": "2026-11-21T10:30:00Z", "author": { "handle": "studio_team" }, "self": true,
        "media": [], "counts": { "likes": 4 }, "reply_to": "t3_k1" });
    let profile = json!({ "network": "reddit", "account": { "id": "t2_s", "handle": "studio_team" },
        "capabilities": vector("record-social-account")["fields"]["capabilities"] });
    let answers = vec![
        ok(profile),
        ok(json!({ "items": [reply] })),
        unsupported("inbox"),
        unsupported("insights"),
    ];
    queue(fake, &id, "reddit__social_read", answers);
    id
}

/// Every item of an instance by id.
fn items(desk: &Desk, instance: &str) -> Vec<Value> {
    let query = json!({ "sources": [format!("{SOCIAL}/{instance}")], "limit": 100 });
    let mut items = desk.items(query);
    items.sort_by_key(|i| i["id"].as_str().unwrap().to_owned());
    items
}

/// One item, its numbers as floats: the index keeps a metric's values as numbers, not integers.
fn item(desk: &Desk, instance: &str, id: &str) -> Value {
    let found = items(desk, instance).into_iter().find(|i| i["id"] == id);
    floats(found.unwrap_or_else(|| panic!("no item {id} in {instance}")))
}

fn floats(value: Value) -> Value {
    match value {
        Value::Number(n) => json!(n.as_f64().unwrap()),
        Value::Array(a) => Value::Array(a.into_iter().map(floats).collect()),
        Value::Object(o) => Value::Object(o.into_iter().map(|(k, v)| (k, floats(v))).collect()),
        other => other,
    }
}

fn synced() -> (FakePlatform, Desk, String, String) {
    let fake = FakePlatform::start();
    let (ig, rd) = (instagram(&fake), reddit(&fake));
    let desk = desk("endue-social", &fake);
    desk.tick();
    (fake, desk, ig, rd)
}

#[test]
fn posts_replies_and_mentions_are_entries_with_the_social_profile() {
    let (fake, desk, ig, rd) = synced();
    assert_eq!(
        item(&desk, &ig, "18011"),
        floats(vector("entry-social-post"))
    );
    assert_eq!(
        item(&desk, &rd, "t1_k2"),
        floats(vector("entry-social-reply"))
    );
    let mention = item(&desk, &ig, "18020");
    assert_eq!(mention["raw"]["postKind"], "mention");
    assert_eq!(mention["raw"]["self"], false);
    assert_eq!(mention["title"], "Love this @studio");

    let path = format!("/api/public/v1/connectors/{ig}/tools/instagram__social_read/call");
    let operations: Vec<Value> = fake
        .seen_at("POST", &path)
        .iter()
        .map(|s| s.body["arguments"].clone())
        .collect();
    assert_eq!(
        operations,
        [
            json!({ "operation": "profile" }),
            json!({ "operation": "posts", "limit": 20 }),
            json!({ "operation": "inbox", "limit": 20 }),
            json!({ "operation": "insights", "scope": "account", "period": "day",
                "metrics": ["followers", "reach", "engagement"] })
        ]
    );
}

#[test]
fn two_networks_differ_only_in_values() {
    let fake = FakePlatform::start();
    let ig = connector(&fake, "instagram", "Studio on Instagram", &TOOLS);
    let rd = connector(&fake, "reddit", "Studio on Reddit", &TOOLS);
    let full = |id: &str| {
        let mut p = post(
            id,
            "reply",
            "Same",
            json!({ "likes": 1, "replies": 1, "reposts": 1, "views": 1 }),
        );
        p["destination"] = json!("d");
        p["reply_to"] = json!("p0");
        p["text_truncated"] = json!(true);
        p
    };
    for (id, kind) in [(&ig, "instagram"), (&rd, "reddit")] {
        let answers = vec![
            ok(
                json!({ "network": kind, "account": { "id": "a", "handle": "h" },
            "capabilities": {} }),
            ),
            ok(json!({ "items": [full("p1")] })),
            unsupported("inbox"),
            unsupported("insights"),
        ];
        queue(&fake, id, &format!("{kind}__social_read"), answers);
    }
    let desk = desk("endue-social-same", &fake);
    desk.tick();
    let keys = |instance: &str| -> BTreeSet<String> {
        let raw = item(&desk, instance, "p1")["raw"].clone();
        raw.as_object().unwrap().keys().cloned().collect()
    };
    assert_eq!(keys(&ig), keys(&rd));
    assert_eq!(
        keys(&ig).len(),
        15,
        "every field of the profile: {:?}",
        keys(&ig)
    );
    assert_ne!(
        item(&desk, &ig, "p1")["raw"]["network"],
        item(&desk, &rd, "p1")["raw"]["network"]
    );
}

#[test]
fn a_count_the_network_does_not_give_is_absent() {
    let (_fake, desk, _ig, rd) = synced();
    let raw = item(&desk, &rd, "t1_k2")["raw"].clone();
    assert_eq!(raw["likes"], 4.0);
    for absent in ["replies", "reposts", "views"] {
        assert!(raw.get(absent).is_none(), "{absent} is absent, never 0");
    }
}

#[test]
fn the_account_is_a_record_and_its_numbers_are_metrics() {
    let (_fake, desk, ig, _rd) = synced();
    let at = desk.clock.text();
    let mut account = vector("record-social-account");
    account["updatedAt"] = json!(at);
    assert_eq!(item(&desk, &ig, "1784"), floats(account.clone()));
    assert_eq!(account["fields"]["capabilities"]["delete_post"], false);
    let mut followers = vector("metric-social-followers");
    followers["updatedAt"] = json!(at);
    assert_eq!(item(&desk, &ig, "followers"), floats(followers));
    for series in ["reach", "engagement"] {
        assert_eq!(item(&desk, &ig, series)["kind"], "metric");
    }
}

#[test]
fn an_inbox_or_insights_the_network_lacks_is_skipped() {
    let (_fake, desk, _ig, rd) = synced();
    let listed = desk.instances(SOCIAL);
    let reddit = listed
        .iter()
        .find(|i| i["instance"] == rd.as_str())
        .unwrap();
    assert_eq!(state(reddit), "connected", "{reddit}");
    let ids: Vec<Value> = items(&desk, &rd).iter().map(|i| i["id"].clone()).collect();
    assert_eq!(ids, [json!("t1_k2"), json!("t2_s")]);
}

/// cmd.invoke as the person; the cmd.answered it ends with.
fn invoke(desk: &Desk, id: &str, args: Value) -> Value {
    let scope = json!({ "permission": "cmd:invoke", "ids": [id] });
    desk.grant("desk", scope.clone());
    let started = desk.ok(
        "desk",
        "cmd.invoke",
        json!({ "id": id, "args": args, "scope": scope }),
    );
    loop {
        let (_, data) = desk.wait_for("cmd.answered");
        if data["invocationId"] == started["invocationId"] {
            return data;
        }
    }
}

#[test]
fn publish_reply_and_delete_are_irreversible_commands() {
    let (fake, desk, ig, _rd) = synced();
    let ids = [
        "endue.social.post.publish",
        "endue.social.post.reply",
        "endue.social.post.delete",
    ];
    let scope = json!({ "permission": "cmd:invoke", "ids": ids });
    desk.grant("desk", scope.clone());
    let listed = desk.ok("desk", "cmd.list", json!({ "scope": scope }));
    let commands = listed["commands"].as_array().unwrap();
    assert_eq!(commands.len(), 3, "{listed}");
    for command in commands {
        assert_eq!(command["provider"], SOCIAL);
        assert_eq!(command["irreversible"], true, "{command}");
    }
    let manifest = json_at("plugins/social/plugin.json");
    for command in manifest["contributes"]["commands"].as_array().unwrap() {
        assert_eq!(
            command["agent"], true,
            "an agent may call {}",
            command["id"]
        );
    }

    let published =
        json!({ "id": "18030", "url": "https://instagram.example/p/18030", "status": "published" });
    let answers = vec![ok(published.clone()), ok(json!({ "id": "18031" }))];
    queue(&fake, &ig, "instagram__social_publish", answers);
    queue(
        &fake,
        &ig,
        "instagram__social_delete",
        vec![ok(Value::Null)],
    );
    let media = json!([{ "url": "https://cdn.example/new.jpg", "alt": "A red coat" }]);
    let args = json!({ "instance": ig, "text": "Winter drop", "media": media, "replyTo": "18011" });
    let answered = invoke(&desk, ids[0], args);
    assert_eq!(answered["result"], published, "{answered}");
    let answered = invoke(
        &desk,
        ids[1],
        json!({ "instance": ig, "id": "18020", "text": "Thank you!" }),
    );
    assert_eq!(answered["result"], json!({ "id": "18031" }), "{answered}");
    let answered = invoke(&desk, ids[2], json!({ "instance": ig, "id": "18011" }));
    assert_eq!(answered["ok"], true, "{answered}");

    let seen = |tool: &str| {
        fake.seen_at(
            "POST",
            &format!("/api/public/v1/connectors/{ig}/tools/instagram__{tool}/call"),
        )
    };
    let publish = seen("social_publish");
    assert_eq!(
        publish[0].body["arguments"],
        json!({ "operation": "publish", "text": "Winter drop", "media": media, "reply_to": "18011" })
    );
    assert_eq!(
        publish[1].body["arguments"],
        json!({ "operation": "reply", "id": "18020", "text": "Thank you!" })
    );
    let delete = seen("social_delete");
    assert_eq!(
        delete[0].body["arguments"],
        json!({ "operation": "delete_post", "id": "18011" })
    );
    let key = |s: &Seen| s.headers["idempotency-key"].clone();
    assert_ne!(key(&publish[0]), key(&publish[1]), "one key per invocation");
    assert_ne!(key(&publish[1]), key(&delete[0]));
}
