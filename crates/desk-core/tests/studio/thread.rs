//! The agent window's conversation (ADR 0411): a send from the shell asks nothing and its run's
//! steps come back to the shell alone, as `studio.chat.event`; no other caller may send; a send
//! goes on in the conversation it names; stop cancels the run; the messages and the last read.

use std::time::Duration;

use super::*;

fn send(core: &Core, caller: &str, more: Value) -> Result<Value, desk_bridge::BridgeError> {
    let mut params = json!({
        "agentId": more["agentId"].clone(),
        "text": "Move it to Thursday",
        "messageId": "desk_0123456789ab",
        "scope": {"permission": "studio:manage"}
    });
    if let Some(id) = more.get("conversationId") {
        params["conversationId"] = id.clone();
    }
    call(core, caller, "studio.chat.send", params)
}

/// The run's steps the shell hears, up to its end.
fn steps(events: &std::sync::mpsc::Receiver<desk_core::Delivery>) -> Vec<Value> {
    let mut out = Vec::new();
    loop {
        let step = wait_for(events, "studio.chat.event");
        assert!(step.is_for("desk") && !step.is_for(AGENTS), "{:?}", step.to);
        let kind = step.data()["kind"].as_str().unwrap_or_default().to_owned();
        out.push(step.data().clone());
        if matches!(kind.as_str(), "completed" | "failed" | "cancelled") {
            return out;
        }
    }
}

fn shell(tag: &str, fake: &FakePlatform) -> Core {
    let core = desk(tag, fake);
    grant(&core, "desk", json!({"permission": "studio:manage"}));
    core
}

#[test]
fn a_send_from_the_shell_asks_nothing() {
    let fake = FakePlatform::start();
    let agent = fake.state().add_agent("Miso", "Mail");
    let core = shell("studio-thread-send", &fake);
    let events = core.events().subscribe_addressed();
    let sent = send(&core, "desk", json!({"agentId": agent})).unwrap();
    let conversation = sent["conversationId"].as_str().unwrap().to_owned();
    let steps = steps(&events);
    let kinds: Vec<&str> = steps.iter().map(|s| s["kind"].as_str().unwrap()).collect();
    assert_eq!(kinds.first(), Some(&"started"));
    assert_eq!(kinds.last(), Some(&"completed"));
    assert!(steps.iter().all(|s| s["conversationId"] == conversation));
    let text: String = steps
        .iter()
        .filter(|s| s["kind"] == "delta")
        .map(|s| s["text"].as_str().unwrap())
        .collect();
    assert_eq!(text, "Partial");
    assert_eq!(steps.last().unwrap()["text"], "The outline is ready.");
    assert!(named(&events, "perm.approval").is_empty());
    let runs = format!("/api/v1/ai/conversations/{conversation}/runs");
    assert_eq!(fake.seen_at("POST", &runs).len(), 1);
}

#[test]
fn any_other_caller_is_refused() {
    let fake = FakePlatform::start();
    let agent = fake.state().add_agent("Miso", "Mail");
    let core = shell("studio-thread-refused", &fake);
    let conversation = fake
        .state()
        .add_conversation(&agent, "Dentist", None, false);
    for caller in [AGENTS, "agent:eris"] {
        let refused = send(&core, caller, json!({"agentId": agent})).unwrap_err();
        assert_eq!(refused.code, ErrorCode::PermissionDenied, "{caller}");
        let stop = call(
            &core,
            caller,
            "studio.chat.stop",
            json!({"conversationId": conversation, "runId": "run_1", "scope": {"permission": "studio:manage"}}),
        )
        .unwrap_err();
        assert_eq!(stop.code, ErrorCode::PermissionDenied, "{caller}");
    }
    assert!(fake.seen().is_empty());
}

#[test]
fn a_send_continues_the_conversation_it_names() {
    let fake = FakePlatform::start();
    let agent = fake.state().add_agent("Miso", "Mail");
    let conversation = fake
        .state()
        .add_conversation(&agent, "Dentist", None, false);
    let core = shell("studio-thread-continue", &fake);
    let events = core.events().subscribe_addressed();
    let sent = send(
        &core,
        "desk",
        json!({"agentId": agent, "conversationId": conversation}),
    )
    .unwrap();
    assert_eq!(sent["conversationId"], conversation);
    steps(&events);
    let runs = format!("/api/v1/ai/conversations/{conversation}/runs");
    assert_eq!(fake.seen_at("POST", &runs).len(), 1);
    assert!(fake.seen_at("POST", "/api/v1/ai/conversations").is_empty());
}

#[test]
fn stop_cancels_the_run() {
    let fake = FakePlatform::start();
    let agent = fake.state().add_agent("Miso", "Mail");
    let conversation = fake
        .state()
        .add_conversation(&agent, "Dentist", None, false);
    fake.state().chat_stream =
        "event: run_created\ndata: {\"run_id\":\"run_held\"}\n\nevent: delta\ndata: {\"run_id\":\"run_held\",\"content\":\"Dear\"}\n\n"
            .to_owned();
    fake.state().chat_hold = Some(Duration::from_secs(20));
    let core = shell("studio-thread-stop", &fake);
    let events = core.events().subscribe_addressed();
    send(
        &core,
        "desk",
        json!({"agentId": agent, "conversationId": conversation}),
    )
    .unwrap();
    let started = wait_for(&events, "studio.chat.event");
    assert_eq!(started.data()["kind"], "started");
    assert_eq!(started.data()["runId"], "run_held");
    let stopped = call(
        &core,
        "desk",
        "studio.chat.stop",
        json!({"conversationId": conversation, "runId": "run_held", "scope": {"permission": "studio:manage"}}),
    )
    .unwrap();
    assert_eq!(stopped, json!({"stopped": true}));
    let rest = steps(&events);
    assert_eq!(rest.last().unwrap()["kind"], "cancelled");
    let cancel = format!("/api/v1/ai/conversations/{conversation}/cancel");
    assert_eq!(fake.seen_at("POST", &cancel).len(), 1);
}

#[test]
fn the_messages_and_the_last_read_cross_without_tool_rows() {
    let fake = FakePlatform::start();
    let agent = fake.state().add_agent("Miso", "Mail");
    let conversation = fake
        .state()
        .add_conversation(&agent, "Dentist", None, false);
    {
        let mut state = fake.state();
        state.add_message(&conversation, json!({"role": "user", "content": "Move it"}));
        state.add_message(
            &conversation,
            json!({"role": "assistant", "content": "", "run_id": "run_1",
                   "tool_calls": [{"id": "t1", "function": {"name": "calendar__update_event", "arguments": "{\"secret\":1}"}}]}),
        );
        state.add_message(
            &conversation,
            json!({"role": "tool", "content": "secret result", "tool_call_id": "t1", "run_id": "run_1"}),
        );
        state.add_message(
            &conversation,
            json!({"role": "assistant", "content": "Moved.", "run_id": "run_1"}),
        );
        state
            .read_at
            .insert(conversation.clone(), "2026-11-09T08:00:00Z".to_owned());
    }
    let core = shell("studio-thread-messages", &fake);
    let scope = json!({"permission": "studio:manage"});
    let page = call(
        &core,
        AGENTS,
        "studio.messages.list",
        json!({"conversationId": conversation, "scope": scope}),
    )
    .unwrap();
    let text = page.to_string();
    assert!(!text.contains("secret"), "{text}");
    let messages = page["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 2);
    assert!(messages.iter().any(|m| m["role"] == "assistant"
        && m["text"] == "Moved."
        && m["work"]["groups"][0]["label"].is_string()));
    let read = call(
        &core,
        AGENTS,
        "studio.conversations.read",
        json!({"conversationId": conversation, "scope": scope}),
    )
    .unwrap();
    assert_eq!(read["previousReadAt"], "2026-11-09T08:00:00Z");
}
