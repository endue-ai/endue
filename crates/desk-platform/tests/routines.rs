use std::sync::Arc;

use desk_platform::fake::FakePlatform;
use desk_platform::{ErrorKind, Platform, RoutineTrigger, Tokens, TriggerKind};
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

/// A schedule that ran and failed, a paused webhook that never ran, a one-time one that ran, a
/// cancelled one and another agent's; each holding what endue AI keeps of a routine.
fn seeded(fake: &FakePlatform) -> String {
    let mut state = fake.state();
    let agent = state.add_agent("Fixture", "Reports");
    state.add_routine(json!({
        "agent_id": agent, "name": "Morning report", "prompt": "PROMPT-SECRET summarise mail",
        "cron_expr": "0 9 * * 1-5", "timezone": "Asia/Seoul", "schedule": "recurring",
        "last_fired_at": "2026-11-28T00:00:05Z", "consecutive_failures": 2, "fire_count": 40,
        "conversation_id": "cnv_ROUTINE", "config": { "notify": "every_run", "token": "CONFIG-SECRET" },
        "recent_fires": [{ "id": "rtf_1", "status": "failed", "error": "FIRE-ERROR" }]
    }));
    state.add_routine(json!({
        "agent_id": agent, "name": "On deploy", "prompt": "PROMPT-SECRET check the deploy",
        "status": "paused", "trigger": "webhook", "schedule": "webhook", "cron_expr": null,
        "webhook": { "prefix": "whk_PREFIX" },
        "webhook_url": "https://platform.endue.ai/api/v1/ai/hooks/routines/rtn_2/WEBHOOK-SECRET"
    }));
    state.add_routine(json!({
        "agent_id": agent, "name": "Remind me", "prompt": "PROMPT-SECRET",
        "status": "done", "schedule": "one_time", "cron_expr": null,
        "fire_at": "2026-11-20T09:00:00Z", "last_fired_at": "2026-11-20T09:00:01Z",
        "output": "OUTPUT-SECRET"
    }));
    state.add_routine(json!({ "agent_id": agent, "name": "Gone", "status": "cancelled" }));
    let other = state.add_agent("Other", "Else");
    state.add_routine(json!({ "agent_id": other, "name": "Not this agent's" }));
    agent
}

#[test]
fn a_routines_prompt_and_webhook_are_not_kept() {
    let fake = FakePlatform::start();
    let agent = seeded(&fake);
    let platform = Platform::new(fake.url(), Arc::new(Token)).unwrap();
    let page = platform.routines(&agent, None, 100).unwrap();
    let kept = format!("{page:?} {}", serde_json::to_string(&page).unwrap());
    for secret in [
        "PROMPT-SECRET",
        "WEBHOOK-SECRET",
        "whk_PREFIX",
        "hooks/routines",
        "CONFIG-SECRET",
        "every_run",
        "FIRE-ERROR",
        "rtf_1",
        "cnv_ROUTINE",
        "OUTPUT-SECRET",
    ] {
        assert!(!kept.contains(secret), "{secret} was kept: {kept}");
    }
    // The fixture does hold each of them.
    let held = format!("{:?}", fake.state().routines);
    assert!(held.contains("PROMPT-SECRET") && held.contains("WEBHOOK-SECRET"));
}

#[test]
fn a_routine_row_says_what_starts_it_and_how_it_last_ran() {
    let fake = FakePlatform::start();
    let agent = seeded(&fake);
    let platform = Platform::new(fake.url(), Arc::new(Token)).unwrap();
    let page = platform.routines(&agent, None, 100).unwrap();
    assert_eq!(
        page.total, 3,
        "the cancelled one and another agent's are left out"
    );
    let [report, hook, once] = &page.routines[..] else {
        panic!("three routines: {page:?}");
    };
    assert_eq!(report.name, "Morning report");
    assert!(report.enabled);
    assert_eq!(
        report.trigger,
        RoutineTrigger {
            kind: TriggerKind::Schedule,
            text: Some("Every weekday at 9:00 (Asia/Seoul)".to_owned())
        }
    );
    assert_eq!(report.last_run_at.as_deref(), Some("2026-11-28T00:00:05Z"));
    assert_eq!(report.last_run_status.as_deref(), Some("failed"));

    assert!(!hook.enabled);
    assert_eq!(hook.trigger.kind, TriggerKind::Webhook);
    assert_eq!(hook.trigger.text, None);
    assert_eq!(
        (hook.last_run_at.as_deref(), hook.last_run_status.as_deref()),
        (None, None)
    );

    assert!(!once.enabled, "a one-time routine that ran is done");
    assert_eq!(
        once.trigger.text.as_deref(),
        Some("Once on 2026-11-20 at 09:00")
    );
    assert_eq!(once.last_run_status.as_deref(), Some("completed"));

    let json = serde_json::to_value(report).unwrap();
    assert_eq!(json["trigger"]["kind"], "schedule");
    assert_eq!(json["lastRunStatus"], "failed");

    let seen = fake.seen_at("GET", "/api/v1/ai/routines");
    assert_eq!(seen[0].query.get("agent_id"), Some(&agent));
    assert_eq!(seen[0].query.get("page").map(String::as_str), Some("1"));
    assert_eq!(seen[0].query.get("limit").map(String::as_str), Some("100"));

    let second = platform.routines(&agent, Some(2), 2).unwrap();
    assert_eq!((second.routines.len(), second.total), (1, 3));
    for limit in [0, 101] {
        let refused = platform.routines(&agent, None, limit).unwrap_err();
        assert_eq!(refused.kind, ErrorKind::Invalid, "limit {limit}");
    }
}
