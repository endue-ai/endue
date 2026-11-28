use std::sync::Arc;

use desk_platform::fake::FakePlatform;
use desk_platform::{ChatRole, ErrorKind, Platform, Tokens};
use serde_json::json;

struct Token;

impl Tokens for Token {
    fn token(&self) -> Option<String> {
        Some("token-1".into())
    }

    fn refresh(&self, _: &str) -> Option<String> {
        None
    }
}

/// A conversation whose turn asked, called two tools (one failed, one of them twice) and answered.
fn seeded(fake: &FakePlatform) -> String {
    let mut state = fake.state();
    let agent = state.add_agent("Fixture", "Read mail");
    let id = state.add_conversation(&agent, "Mail", Some("completed"), false);
    state.add_message(&id, json!({ "role": "user", "content": "Any mail?" }));
    state.add_message(
        &id,
        json!({
            "role": "assistant", "run_id": "run_1", "content": null,
            "metadata": { "reasoning": "THINKING-ALOUD", "memory": "MEMORY-NOTE" },
            "tool_calls": [
                { "id": "call_1", "function": { "name": "gmail__search", "arguments": "{\"q\":\"ARG-SECRET\"}" } },
                { "id": "call_2", "function": { "name": "gmail__search_2", "arguments": "{}" } },
                { "id": "call_3", "function": { "name": "web_search", "arguments": "{}" } }
            ]
        }),
    );
    for (call, name, error) in [
        ("call_1", "gmail__search", false),
        ("call_2", "gmail__search_2", true),
        ("call_3", "web_search", false),
    ] {
        state.add_message(
            &id,
            json!({
                "role": "tool", "run_id": "run_1", "tool_call_id": call, "name": name,
                "content": "RESULT-SECRET from person usr_42",
                "metadata": { "is_error": error, "files": [{ "id": "FILE-ID" }] }
            }),
        );
    }
    state.add_message(
        &id,
        json!({ "role": "system", "content": "SYSTEM-NOTE", "run_id": "run_1" }),
    );
    state.add_message(
        &id,
        json!({
            "role": "assistant", "run_id": "run_1", "content": "Two new mails.",
            "reasoning_content": "REASONING-SECRET",
            "metadata": { "presentation": {
                "run_id": "run_1", "revision": 3, "phase": "completed",
                "started_at": "2026-11-01T09:00:00Z", "ended_at": "2026-11-01T09:00:14Z",
                "counts": { "attempted": 3, "succeeded": 2, "failed": 1 },
                "references": [{ "kind": "connector", "provider": "gmail", "label": "Gmail",
                                 "href": "https://endue.ai/x", "usage": "called" }]
            } }
        }),
    );
    id
}

#[test]
fn tool_rows_fold_into_the_turns_work() {
    let fake = FakePlatform::start();
    let id = seeded(&fake);
    let platform = Platform::new(fake.url(), Arc::new(Token)).unwrap();
    let page = platform.messages(&id, None, 50).unwrap();
    assert!(!page.has_more);
    let roles: Vec<ChatRole> = page.messages.iter().map(|m| m.role).collect();
    assert_eq!(roles, vec![ChatRole::User, ChatRole::Assistant]);
    assert_eq!(page.messages[0].text, "Any mail?");
    assert_eq!(page.messages[0].work, None);
    let answer = &page.messages[1];
    assert_eq!(answer.text, "Two new mails.");
    assert_eq!(answer.run_id.as_deref(), Some("run_1"));
    let work = answer.work.as_ref().expect("the turn's work");
    assert_eq!(work.phase, "completed");
    assert_eq!(work.started_at.as_deref(), Some("2026-11-01T09:00:00Z"));
    assert_eq!(work.ended_at.as_deref(), Some("2026-11-01T09:00:14Z"));
    assert_eq!((work.attempted, work.succeeded, work.failed), (3, 2, 1));
    assert_eq!(work.groups.len(), 2);
    assert_eq!(work.groups[0].label, "gmail__search");
    assert_eq!(work.groups[0].provider.as_deref(), Some("gmail"));
    assert_eq!((work.groups[0].calls, work.groups[0].failed), (2, 1));
    assert_eq!((work.groups[1].calls, work.groups[1].failed), (1, 0));

    let seen = fake.seen_at("GET", &format!("/api/v1/ai/conversations/{id}/messages"));
    assert_eq!(
        seen[0].query.get("latest").map(String::as_str),
        Some("true")
    );
    assert_eq!(seen[0].query.get("limit").map(String::as_str), Some("50"));

    // Read further back: the page before the answer.
    let earlier = platform.messages(&id, Some(&answer.id), 2).unwrap();
    assert!(earlier.has_more);
    assert!(
        earlier.messages.is_empty(),
        "a tool row and a note are not messages"
    );
    assert_eq!(
        platform.messages(&id, None, 0).unwrap_err().kind,
        ErrorKind::Invalid
    );
}

#[test]
fn no_argument_result_or_reasoning_is_kept() {
    let fake = FakePlatform::start();
    let id = seeded(&fake);
    let platform = Platform::new(fake.url(), Arc::new(Token)).unwrap();
    let page = platform.messages(&id, None, 100).unwrap();
    let kept = format!("{page:?} {}", serde_json::to_string(&page).unwrap());
    for secret in [
        "ARG-SECRET",
        "RESULT-SECRET",
        "usr_42",
        "THINKING-ALOUD",
        "MEMORY-NOTE",
        "REASONING-SECRET",
        "SYSTEM-NOTE",
        "FILE-ID",
        "call_1",
        "https://endue.ai/x",
    ] {
        assert!(!kept.contains(secret), "{secret} was kept: {kept}");
    }
    let json = serde_json::to_value(&page.messages[1]).unwrap();
    assert_eq!(json["role"], "assistant");
    assert_eq!(json["runId"], "run_1");
    assert_eq!(json["work"]["groups"][0]["calls"], 2);
}

#[test]
fn marking_read_answers_when_it_was_read_before() {
    let fake = FakePlatform::start();
    let id = seeded(&fake);
    let platform = Platform::new(fake.url(), Arc::new(Token)).unwrap();
    assert_eq!(platform.mark_read(&id).unwrap(), None, "never read");
    let first = fake.state().read_at.get(&id).cloned();
    assert!(first.is_some());
    assert_eq!(platform.mark_read(&id).unwrap(), first);
    let read = fake.seen_at("POST", &format!("/api/v1/ai/conversations/{id}/read"));
    assert_eq!(read[0].body, json!({}));
}
