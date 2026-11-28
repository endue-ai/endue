//! The side of an agent's window (ADR 0411, FT-07): its topics and routines need studio:manage and
//! cross with only what a row shows; a new thread is made in the topic it names.

use super::*;

const SCOPE: &str = "studio:manage";

fn shell(tag: &str, fake: &FakePlatform) -> Core {
    let core = desk(tag, fake);
    grant(&core, "desk", json!({"permission": SCOPE}));
    core
}

#[test]
fn topics_and_routines_need_studio_manage() {
    let fake = FakePlatform::start();
    let agent = fake.state().add_agent("Miso", "Mail");
    let topic = fake.state().add_topic(&agent, "launch-plan");
    fake.state().add_thread(&topic, "Pricing page copy");
    fake.state().add_routine(json!({
        "agent_id": agent, "name": "Morning brief", "prompt": "Read my mail and say what matters",
        "schedule": "recurring", "cron_expr": "0 9 * * 1-5",
        "webhook_url": "https://hooks.example/secret-path", "webhook_secret": "s3cr3t"
    }));
    let core = shell("studio-side-scope", &fake);
    let scope = json!({"permission": SCOPE});
    for caller in ["agent:eris", "plugin:notes"] {
        for method in ["studio.topics.list", "studio.routines.list"] {
            let refused = call(
                &core,
                caller,
                method,
                json!({"agentId": agent, "scope": scope}),
            )
            .unwrap_err();
            assert_eq!(
                refused.code,
                ErrorCode::PermissionDenied,
                "{caller} {method}"
            );
        }
    }
    let topics = call(
        &core,
        "desk",
        "studio.topics.list",
        json!({"agentId": agent, "scope": scope}),
    )
    .unwrap();
    assert_eq!(topics["topics"][0]["id"], topic);
    assert_eq!(topics["topics"][0]["name"], "launch-plan");
    assert_eq!(topics["topics"][0]["threadCount"], 1);
    let routines = call(
        &core,
        "desk",
        "studio.routines.list",
        json!({"agentId": agent, "limit": 10, "scope": scope}),
    )
    .unwrap();
    assert_eq!(routines["total"], 1);
    let row = &routines["routines"][0];
    assert_eq!(row["name"], "Morning brief");
    assert_eq!(row["trigger"]["kind"], "schedule");
    assert_eq!(row["trigger"]["text"], "Every weekday at 9:00");
    let text = routines.to_string();
    for kept in ["Read my mail", "hooks.example", "s3cr3t", "cron"] {
        assert!(!text.contains(kept), "{kept} crossed: {text}");
    }
}

#[test]
fn a_new_thread_is_made_in_its_topic() {
    let fake = FakePlatform::start();
    let agent = fake.state().add_agent("Miso", "Mail");
    let topic = fake.state().add_topic(&agent, "launch-plan");
    let core = shell("studio-side-thread", &fake);
    let scope = json!({"permission": SCOPE});
    let sent = call(
        &core,
        "desk",
        "studio.chat.send",
        json!({
            "agentId": agent, "topicId": topic, "text": "Draft the launch post",
            "messageId": "desk_0123456789ab", "scope": scope
        }),
    )
    .unwrap();
    let conversation = sent["conversationId"].as_str().unwrap().to_owned();
    let made = fake.seen_at("POST", "/api/v1/ai/conversations");
    assert_eq!(made.len(), 1);
    assert_eq!(made[0].body["topic_id"], topic);
    let threads = call(
        &core,
        "desk",
        "studio.conversations.list",
        json!({"agentId": agent, "topicId": topic, "scope": scope}),
    )
    .unwrap();
    let rows = threads["conversations"].as_array().unwrap();
    let mine = rows
        .iter()
        .find(|c| c["id"] == conversation)
        .expect("the new thread is listed");
    assert_eq!(mine["topicId"], topic);
    assert!(rows.iter().all(|c| c["topicId"] == topic));
}
