//! The desk's own key and the account's connectors against the in-process fake (ADR 0407): the key
//! is made and revoked with the session, every connector call carries the key and never the
//! session, and limits and refusals come back typed. Nothing leaves 127.0.0.1.

use std::sync::Arc;

use desk_platform::fake::FakePlatform;
use desk_platform::wire_connectors::{ConnectorStatus, KeyScope, Refusal, Risk};
use desk_platform::{ErrorKind, KEY_REFUSED, Platform, Tokens};
use serde_json::{Map, json};

struct Token;

impl Tokens for Token {
    fn token(&self) -> Option<String> {
        Some("token-1".to_owned())
    }

    fn refresh(&self, _rejected: &str) -> Option<String> {
        None
    }
}

fn client(fake: &FakePlatform) -> Platform {
    Platform::new(fake.url(), Arc::new(Token)).unwrap()
}

fn no_arguments() -> Map<String, serde_json::Value> {
    Map::new()
}

#[test]
fn a_key_is_created_and_revoked_with_the_session() {
    let fake = FakePlatform::start();
    let platform = client(&fake);
    let key = platform
        .create_key("endue Desk on ada-mac", &[KeyScope::Read])
        .unwrap();
    assert_eq!(key.id, "key_1");
    assert_eq!(key.scopes, [KeyScope::Read]);
    assert!(key.secret.starts_with("sk_"));
    assert!(
        !format!("{key:?}").contains(&key.secret),
        "a key's Debug never prints its secret"
    );
    let made = fake.seen_at("POST", "/api/v1/me/api-keys");
    assert_eq!(made[0].headers["authorization"], "Bearer token-1");
    assert_eq!(
        made[0].body,
        json!({ "name": "endue Desk on ada-mac", "scopes": ["connectors:read"] })
    );

    platform.revoke_key(&key.id).unwrap();
    let revoked = fake.seen_at("DELETE", "/api/v1/me/api-keys/key_1");
    assert_eq!(revoked[0].headers["authorization"], "Bearer token-1");
    assert!(fake.state().connectors.live_keys().is_empty());
    // A key endue AI no longer has is revoked already.
    platform.revoke_key(&key.id).unwrap();
}

#[test]
fn connector_calls_carry_the_key_and_never_the_session() {
    let fake = FakePlatform::start();
    let id = fake
        .state()
        .connectors
        .add("instagram", "@ada.studio", &["read", "send"]);
    let platform = client(&fake);
    let key = platform.create_key("desk", &[KeyScope::Read]).unwrap();
    let connectors = platform.with_key(&key.secret);
    assert!(!format!("{connectors:?}").contains(&key.secret));

    let list = connectors.list().unwrap().value;
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].connector_id, id);
    assert_eq!(list[0].kind, "instagram");
    assert_eq!(list[0].status, ConnectorStatus::Active);

    let tools = connectors.tools(&id).unwrap().value;
    assert_eq!(tools[0].risk, Some(Risk::Read));
    assert!(tools[0].callable);
    assert!(!tools[1].callable, "a read key may not publish");

    let call = connectors
        .call(&id, "instagram__social_read", no_arguments(), "inv_1.0")
        .unwrap()
        .value;
    assert!(call.ok);
    assert_eq!(call.tool, "instagram__social_read");

    let calls: Vec<_> = fake
        .seen()
        .into_iter()
        .filter(|s| s.path.starts_with("/api/public/v1/connectors"))
        .collect();
    assert_eq!(calls.len(), 3);
    for seen in &calls {
        assert_eq!(
            seen.headers["authorization"],
            format!("Bearer {}", key.secret),
            "{} carries the key",
            seen.path
        );
        assert!(!seen.headers["authorization"].contains("token-1"));
    }
    assert_eq!(calls[2].headers["idempotency-key"], "inv_1.0");
    assert_eq!(calls[2].body, json!({ "arguments": {} }));

    let refused = connectors
        .call(&id, "instagram__social_publish", no_arguments(), "inv_2.0")
        .unwrap_err();
    assert_eq!(refused.kind, ErrorKind::Forbidden);
    assert_eq!(refused.code.as_deref(), Some("CONNECTOR_TOOL_NOT_ALLOWED"));
}

#[test]
fn rate_limits_and_refusals_are_typed() {
    let fake = FakePlatform::start();
    let id = fake
        .state()
        .connectors
        .add("threads", "@ada", &["read", "send"]);
    let platform = client(&fake);
    let key = platform
        .create_key("desk", &[KeyScope::Read, KeyScope::Send])
        .unwrap();
    let connectors = platform.with_key(&key.secret);

    // The limits ride on every answer; none left asks to wait for the reset.
    for (name, value) in [
        ("x-ratelimit-limit", "60"),
        ("x-ratelimit-remaining", "0"),
        ("x-ratelimit-reset", "17"),
    ] {
        fake.state()
            .connectors
            .headers
            .insert(name.to_owned(), value.to_owned());
    }
    let answer = connectors.list().unwrap();
    assert_eq!(answer.limit.limit, Some(60));
    assert_eq!(answer.limit.wait(), Some(17));

    // 429 names its wait.
    fake.state().connectors.limited = Some(42);
    let limited = connectors.list().unwrap_err();
    assert_eq!(limited.kind, ErrorKind::RateLimited { wait_secs: 42 });

    // The network's own refusal is an answer at 200, with a reason for machines.
    fake.state().connectors.answers.insert(
        format!("{id}/threads__social_publish"),
        json!({
            "ok": false,
            "content": "Threads allows 250 posts a day.",
            "error": { "reason": "quota", "message": "Threads allows 250 posts a day.", "retry_after": 3600 }
        }),
    );
    let call = connectors
        .call(&id, "threads__social_publish", no_arguments(), "inv_3.0")
        .unwrap()
        .value;
    assert!(!call.ok);
    let error = call.error.unwrap();
    assert_eq!(error.reason, Refusal::Quota);
    assert_eq!(error.retry_after, Some(3600));

    // An expired connector is a conflict; a revoked key is signed out, and never retried.
    fake.state().connectors.connectors[0].expired = true;
    let expired = connectors
        .call(&id, "threads__social_read", no_arguments(), "inv_4.0")
        .unwrap_err();
    assert_eq!(expired.kind, ErrorKind::Conflict);
    assert_eq!(expired.code.as_deref(), Some("CONNECTOR_NOT_ACTIVE"));

    platform.revoke_key(&key.id).unwrap();
    let before = fake.seen().len();
    let gone = connectors.list().unwrap_err();
    assert_eq!(gone.kind, ErrorKind::SignedOut);
    assert_eq!(gone.message, KEY_REFUSED);
    assert_eq!(
        fake.seen().len(),
        before + 1,
        "a refused key is not retried"
    );
}
