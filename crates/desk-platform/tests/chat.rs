use std::sync::Arc;
use std::time::{Duration, Instant};

use desk_platform::fake::{FakePlatform, FakeSpace};
use desk_platform::{
    ChatConversation, ChatEvent, ChatState, ChatTurn, ErrorKind, Platform, PlatformError, RUN_CUT,
    Tokens,
};
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

#[test]
fn creates_a_reviewed_agent_conversation_and_returns_the_terminal_message() {
    let fake = FakePlatform::start();
    let agent = fake.state().add_agent("Fixture", "Read the outline");
    let platform = Platform::new(fake.url(), Arc::new(Token)).unwrap();
    let conversation = platform.agent_conversation(&agent).unwrap();
    assert_eq!(conversation.agent_id, agent);
    let turn = platform
        .chat_turn(&conversation, "Is it ready?", "desk_message")
        .unwrap();
    assert_eq!(turn.state, ChatState::Done);
    assert_eq!(turn.text.as_deref(), Some("The outline is ready."));
    assert_eq!(turn.run_id.as_deref(), Some("run_fixture"));
    let request = fake.seen_at("POST", "/api/v1/ai/conversations");
    assert_eq!(
        request[0].body,
        json!({"agent_id": agent, "title": "From Desk", "approval_level": "ask"})
    );
    let path = format!("/api/v1/ai/conversations/{}/runs", conversation.id);
    let sent = fake.seen_at("POST", &path);
    assert_eq!(sent.len(), 1);
    assert_eq!(
        sent[0].headers.get("accept").map(String::as_str),
        Some("text/event-stream")
    );
    assert!(!sent[0].headers.contains_key("origin"));
    assert_eq!(
        sent[0].body,
        json!({
            "agent_id": agent, "content": "Is it ready?", "stream": true, "client_message_id": "desk_message"
        })
    );
}

#[test]
fn uses_the_space_binding_and_keeps_incomplete_streams_out_of_the_answer() {
    let fake = FakePlatform::start();
    let mut space = FakeSpace::new("sp_fixture", "Launch");
    space.body["front_agent_id"] = json!("ag_front");
    fake.state().spaces.push(space);
    let platform = Platform::new(fake.url(), Arc::new(Token)).unwrap();
    let conversation = platform.space_conversation("sp_fixture").unwrap();
    assert_eq!(conversation.id, "cnv_sp_fixture");
    assert_eq!(conversation.agent_id, "ag_front");
    assert!(fake.seen_at("POST", "/api/v1/ai/conversations").is_empty());

    for (stream, state) in [
        (
            "event: delta\r\ndata: {\"run_id\":\"run_1\",\"content\":\"Partial\"}\r\n\r\n",
            ChatState::Interrupted,
        ),
        (
            "event: interaction\ndata: {\"run_id\":\"run_1\",\"prompt\":\"Choose\"}\n\n",
            ChatState::NeedsInput,
        ),
        (
            "event: error\ndata: {\"run_id\":\"run_1\",\"code\":\"CLOUD_ERROR\"}\n\n",
            ChatState::Failed,
        ),
        (
            "event: done\ndata: {\"run_id\":\"run_1\",\"stop_reason\":\"awaiting_choice\",\"message\":{\"role\":\"assistant\",\"content\":\"Choose\"}}\n\n",
            ChatState::NeedsInput,
        ),
    ] {
        fake.state().chat_stream = stream.to_owned();
        let result = platform
            .chat_turn(&conversation, "Is it ready?", "desk_message")
            .unwrap();
        assert_eq!(result.state, state);
        assert_eq!(result.text, None);
    }
}

#[test]
fn erises_conversation_is_the_accounts_own_and_a_turn_runs_on_it() {
    let fake = FakePlatform::start();
    let platform = Platform::new(fake.url(), Arc::new(Token)).unwrap();
    assert!(
        platform.eris().unwrap().is_none(),
        "an account without Eris"
    );
    fake.state().eris = Some(("ag_eris".into(), "cnv_eris".into()));
    let eris = platform.eris().unwrap().expect("her conversation");
    assert_eq!(
        (eris.id.as_str(), eris.agent_id.as_str()),
        ("cnv_eris", "ag_eris")
    );
    let turn = platform.chat_turn(&eris, "hello", "desk_m1").unwrap();
    assert_eq!(turn.text.as_deref(), Some("The outline is ready."));
}

fn frame(event: &str, data: serde_json::Value) -> String {
    format!("event: {event}\ndata: {data}\n\n")
}

/// A platform with an agent's new conversation, and the client to it.
fn conversation(fake: &FakePlatform) -> (Platform, ChatConversation) {
    let agent = fake.state().add_agent("Fixture", "Read the outline");
    let platform = Platform::new(fake.url(), Arc::new(Token)).unwrap();
    let conversation = platform.new_agent_conversation(&agent).unwrap();
    (platform, conversation)
}

fn send(
    platform: &Platform,
    conversation: &ChatConversation,
) -> (Result<ChatTurn, PlatformError>, Vec<(Instant, ChatEvent)>) {
    let mut events = Vec::new();
    let turn = platform.stream_turn(conversation, "Is it ready?", "desk_m1", &mut |e| {
        events.push((Instant::now(), e));
    });
    (turn, events)
}

#[test]
fn a_runs_events_arrive_as_they_are_sent() {
    let fake = FakePlatform::start();
    let (platform, conversation) = conversation(&fake);
    let run = json!({ "run_id": "run_1" });
    fake.state().chat_stream = [
        frame("run_created", run.clone()),
        frame("delta", json!({ "run_id": "run_1", "content": "The out" })),
        frame(
            "step",
            json!({ "run_id": "run_1", "tool_calls": [
            { "id": "call_1", "name": "gmail__search", "arguments": "{\"q\":\"secret\"}",
              "result": "private mail", "ok": false }
        ] }),
        ),
        frame("delta", json!({ "run_id": "run_1", "content": "line" })),
        frame(
            "done",
            json!({ "run_id": "run_1", "stop_reason": "final",
            "message": { "role": "assistant", "content": "The outline is ready." } }),
        ),
    ]
    .concat();
    fake.state().chat_gap = Some(Duration::from_millis(150));
    let (turn, events) = send(&platform, &conversation);
    let turn = turn.unwrap();
    assert_eq!(turn.state, ChatState::Done);
    assert_eq!(turn.run_id.as_deref(), Some("run_1"));
    assert_eq!(turn.text.as_deref(), Some("The outline is ready."));
    let kinds: Vec<&ChatEvent> = events.iter().map(|(_, e)| e).collect();
    assert_eq!(
        kinds[0],
        &ChatEvent::Started {
            run_id: "run_1".into()
        }
    );
    assert_eq!(kinds[1], &ChatEvent::Delta("The out".into()));
    let ChatEvent::Work(work) = kinds[2] else {
        panic!("a step is work: {kinds:?}");
    };
    assert_eq!(
        (work.phase.as_str(), work.attempted, work.failed),
        ("running", 1, 1)
    );
    assert_eq!(work.groups[0].label, "gmail__search");
    assert_eq!(work.groups[0].provider.as_deref(), Some("gmail"));
    assert!(
        !format!("{kinds:?}").contains("secret"),
        "no argument crosses"
    );
    assert!(
        !format!("{kinds:?}").contains("private mail"),
        "no result crosses"
    );
    assert_eq!(kinds[3], &ChatEvent::Delta("line".into()));
    assert!(
        matches!(kinds.last(), Some(ChatEvent::Completed { text }) if text == "The outline is ready.")
    );
    // Each event came when it was sent, not with the stream's end.
    let first = events[1].0;
    let last = events.last().unwrap().0;
    assert!(
        last - first >= Duration::from_millis(400),
        "{:?}",
        last - first
    );
    assert_eq!(
        fake.seen_at("POST", "/api/v1/ai/conversations")[0].body,
        json!({ "agent_id": conversation.agent_id })
    );
}

#[test]
fn an_unknown_event_is_skipped() {
    let fake = FakePlatform::start();
    let (platform, conversation) = conversation(&fake);
    fake.state().chat_stream = [
        ": ping\n\n".to_owned(),
        frame("run_created", json!({ "run_id": "run_1" })),
        frame(
            "reasoning",
            json!({ "run_id": "run_1", "content": "I think privately" }),
        ),
        frame("something_new", json!({ "run_id": "run_1", "x": [1, 2] })),
        "event: delta\ndata: not json\n\n".to_owned(),
        frame("delta", json!({ "run_id": "run_1", "content": "Hi" })),
        frame(
            "done",
            json!({ "run_id": "run_1", "stop_reason": "final",
            "message": { "role": "assistant", "content": "Hi." } }),
        ),
    ]
    .concat();
    let (turn, events) = send(&platform, &conversation);
    assert_eq!(turn.unwrap().text.as_deref(), Some("Hi."));
    let events: Vec<ChatEvent> = events.into_iter().map(|(_, e)| e).collect();
    assert_eq!(
        events,
        vec![
            ChatEvent::Started {
                run_id: "run_1".into()
            },
            ChatEvent::Delta("Hi".into()),
            ChatEvent::Completed { text: "Hi.".into() },
        ]
    );
}

#[test]
fn ninety_seconds_without_an_event_ends_the_read() {
    let fake = FakePlatform::start();
    let (platform, conversation) = conversation(&fake);
    // The client's deadline stands in for the 90 s of silence.
    let platform = platform.with_timeout(Duration::from_millis(400));
    fake.state().chat_stream = frame("run_created", json!({ "run_id": "run_1" }));
    fake.state().chat_hold = Some(Duration::from_secs(10));
    let started = Instant::now();
    let (turn, events) = send(&platform, &conversation);
    let error = turn.unwrap_err();
    assert_eq!(error.kind, ErrorKind::Offline);
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(events.len(), 1, "the run started, then nothing came");

    // A stream that keeps sending is not given up on, however long it takes in all.
    let ping = ": ping\n\n";
    fake.state().chat_stream = [
        frame("run_created", json!({ "run_id": "run_2" })),
        ping.repeat(4),
        frame(
            "done",
            json!({ "run_id": "run_2", "stop_reason": "final",
            "message": { "role": "assistant", "content": "Done." } }),
        ),
    ]
    .concat();
    fake.state().chat_hold = None;
    fake.state().chat_gap = Some(Duration::from_millis(200));
    let (turn, _) = send(&platform, &conversation);
    assert_eq!(turn.unwrap().text.as_deref(), Some("Done."));
}

#[test]
fn a_run_past_two_mebibytes_is_cut_and_says_so() {
    let fake = FakePlatform::start();
    let (platform, conversation) = conversation(&fake);
    let piece = "x".repeat(64 * 1024);
    let mut stream = frame("run_created", json!({ "run_id": "run_1" }));
    for _ in 0..40 {
        stream.push_str(&frame(
            "delta",
            json!({ "run_id": "run_1", "content": piece }),
        ));
    }
    stream.push_str(&frame(
        "done",
        json!({ "run_id": "run_1", "stop_reason": "final",
        "message": { "role": "assistant", "content": "Never read." } }),
    ));
    fake.state().chat_stream = stream;
    let (turn, events) = send(&platform, &conversation);
    let turn = turn.unwrap();
    assert_eq!(turn.state, ChatState::Failed);
    assert_eq!(turn.text, None);
    assert_eq!(turn.message.as_deref(), Some(RUN_CUT));
    let events: Vec<ChatEvent> = events.into_iter().map(|(_, e)| e).collect();
    let deltas = events
        .iter()
        .filter(|e| matches!(e, ChatEvent::Delta(_)))
        .count();
    assert!((20..32).contains(&deltas), "{deltas} deltas before the cut");
    assert_eq!(
        events.last(),
        Some(&ChatEvent::Failed {
            message: RUN_CUT.into()
        })
    );
}

#[test]
fn a_run_in_flight_is_joined_and_can_be_stopped() {
    let fake = FakePlatform::start();
    let (platform, conversation) = conversation(&fake);
    let none = platform
        .attach(&conversation, &mut |_| panic!("no run, no events"))
        .unwrap();
    assert_eq!((none.state, none.run_id), (ChatState::Interrupted, None));
    assert!(
        platform.cancel_run(&conversation.id, "run_1").is_ok(),
        "nothing to stop is not an error"
    );

    fake.state().attach_stream = Some(frame(
        "delta",
        json!({ "run_id": "run_1", "content": "So far" }),
    ));
    fake.state().chat_hold = Some(Duration::from_secs(10));
    let stopper = {
        let platform = Platform::new(fake.url(), Arc::new(Token)).unwrap();
        let id = conversation.id.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            platform.cancel_run(&id, "run_1").unwrap();
        })
    };
    let mut events = Vec::new();
    let turn = platform
        .attach(&conversation, &mut |e| events.push(e))
        .unwrap();
    stopper.join().unwrap();
    assert_eq!(turn.state, ChatState::Interrupted);
    assert_eq!(
        events,
        vec![
            ChatEvent::Started {
                run_id: "run_1".into()
            },
            ChatEvent::Delta("So far".into()),
            ChatEvent::Cancelled,
        ]
    );
    let path = format!("/api/v1/ai/conversations/{}/cancel", conversation.id);
    assert_eq!(
        fake.seen_at("POST", &path)[1].body,
        json!({ "run_id": "run_1" })
    );
}
