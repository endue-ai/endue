use std::sync::Arc;

use desk_platform::fake::FakePlatform;
use desk_platform::wire_catalog::ConversationQuery;
use desk_platform::{ErrorKind, Platform, Tokens};
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
fn topics_read_only_what_a_row_shows() {
    let fake = FakePlatform::start();
    let (agent, launch, other) = {
        let mut state = fake.state();
        let agent = state.add_agent("Fixture", "Plans launches");
        let other = state.add_agent("Other", "Something else");
        let archived = state.add_topic(&agent, "old");
        state.add_topic(&agent, "hiring");
        state.add_topic(&other, "not this agent's");
        let launch = state.add_topic(&agent, "launch");
        state.add_thread(&launch, "Press kit");
        state.add_thread(&launch, "Pricing");
        for topic in state.topics.iter_mut() {
            if topic["id"] == launch {
                topic["instructions"] = json!("TOPIC-INSTRUCTIONS");
                topic["goal"] = json!("TOPIC-GOAL");
                topic["files"] = json!([{ "id": "FILE-ID" }]);
            }
            if topic["id"] == archived {
                topic["status"] = json!("archived");
            }
        }
        (agent, launch, other)
    };
    let platform = Platform::new(fake.url(), Arc::new(Token)).unwrap();
    let topics = platform.topics(&agent).unwrap();
    let names: Vec<&str> = topics.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(names, vec!["launch", "hiring"], "active ones, latest first");
    let first = &topics[0];
    assert_eq!(first.id, launch);
    assert_eq!(
        first.thread_count, 2,
        "the main conversation is not a thread"
    );
    assert!(first.last_activity_at.is_some());
    assert!(first.main_conversation_id.is_some());
    assert_eq!(topics[1].thread_count, 0);

    let kept = format!("{topics:?} {}", serde_json::to_string(&topics).unwrap());
    for secret in [
        "TOPIC-INSTRUCTIONS",
        "TOPIC-GOAL",
        "FILE-ID",
        &other,
        "usr_1",
    ] {
        assert!(!kept.contains(secret), "{secret} was kept: {kept}");
    }
    let row = serde_json::to_value(first).unwrap();
    assert_eq!(row["threadCount"], 2);
    assert!(row["mainConversationId"].is_string());

    let seen = fake.seen_at("GET", &format!("/api/v1/ai/agents/{agent}/topics"));
    assert_eq!(
        seen[0].query.get("status").map(String::as_str),
        Some("active")
    );
    assert_eq!(seen[0].query.get("limit").map(String::as_str), Some("100"));
    assert!(platform.topics("ag_nobody").unwrap().is_empty());
}

#[test]
fn a_topics_threads_are_its_conversations_and_a_new_one_joins_them() {
    let fake = FakePlatform::start();
    let (agent, topic, outside) = {
        let mut state = fake.state();
        let agent = state.add_agent("Fixture", "Plans launches");
        let topic = state.add_topic(&agent, "launch");
        state.add_thread(&topic, "Press kit");
        let outside = state.add_conversation(&agent, "Not in a topic", None, false);
        (agent, topic, outside)
    };
    let platform = Platform::new(fake.url(), Arc::new(Token)).unwrap();
    let query = ConversationQuery {
        agent_id: Some(agent.clone()),
        topic_id: Some(topic.clone()),
        ..ConversationQuery::default()
    };
    let page = platform.conversations(&query).unwrap();
    assert_eq!(page.total, 2, "the main conversation and one thread");
    assert!(
        page.items
            .iter()
            .all(|c| c.topic_id.as_deref() == Some(&topic))
    );
    assert!(page.items.iter().all(|c| c.id != outside));
    let seen = fake.seen_at("GET", "/api/v1/ai/conversations");
    assert_eq!(seen[0].query.get("topic_id"), Some(&topic));

    let thread = platform.new_topic_conversation(&agent, &topic).unwrap();
    assert_eq!(thread.agent_id, agent);
    let created = fake.seen_at("POST", "/api/v1/ai/conversations");
    assert_eq!(
        created[0].body,
        json!({ "agent_id": agent, "topic_id": topic })
    );
    assert_eq!(platform.conversations(&query).unwrap().total, 3);
    assert_eq!(platform.topics(&agent).unwrap()[0].thread_count, 2);

    let other = fake.state().add_agent("Other", "Something else");
    let refused = platform.new_topic_conversation(&other, &topic).unwrap_err();
    assert_eq!(refused.kind, ErrorKind::NotFound, "another agent's topic");
    let refused = platform
        .new_topic_conversation(&agent, "top_missing")
        .unwrap_err();
    assert_eq!(refused.kind, ErrorKind::NotFound);
}
