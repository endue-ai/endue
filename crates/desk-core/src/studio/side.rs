//! The side of an agent's window (ADR 0411): its topics and its routines, read-only. Only what a
//! row shows crosses: a topic's name, thread count, last activity and main conversation; a
//! routine's name, whether it is on, what starts it in words, and when it last ran with how that
//! ended. A routine's prompt, webhook address and secret, and its run history are never read.

use desk_bridge::{
    StudioRoutine, StudioRoutineTrigger, StudioRoutineTriggerKind, StudioRoutinesListParams,
    StudioRoutinesListResult, StudioTopic, StudioTopicsListParams, StudioTopicsListResult,
};
use desk_platform::{Routine, Topic, TriggerKind};

use super::spaces::id_of;
use crate::core_studio::{failed, invalid};
use crate::handler::{Answer, Core, json};

const ROUTINES: u64 = 20;

fn cut(text: String, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((at, _)) => text[..at].to_owned(),
        None => text,
    }
}

fn topic(t: Topic) -> Option<StudioTopic> {
    let name = cut(t.name, 200);
    if name.trim().is_empty() {
        return None;
    }
    Some(StudioTopic {
        id: id_of(&t.id)?,
        name,
        thread_count: t.thread_count.into(),
        last_activity_at: t.last_activity_at,
        main_conversation_id: t.main_conversation_id.as_deref().and_then(id_of),
    })
}

fn routine(r: Routine) -> Option<StudioRoutine> {
    let name = cut(r.name, 200);
    if name.trim().is_empty() {
        return None;
    }
    Some(StudioRoutine {
        id: id_of(&r.id)?,
        name,
        enabled: r.enabled,
        trigger: StudioRoutineTrigger {
            kind: match r.trigger.kind {
                TriggerKind::Schedule => StudioRoutineTriggerKind::Schedule,
                TriggerKind::Webhook => StudioRoutineTriggerKind::Webhook,
                TriggerKind::Event => StudioRoutineTriggerKind::Event,
            },
            text: r.trigger.text.map(|t| cut(t, 200)),
        },
        last_run_at: r.last_run_at,
        last_run_status: r.last_run_status.map(|s| cut(s, 32)),
    })
}

impl Core {
    pub(crate) fn studio_topics_list(
        &self,
        caller: &str,
        params: StudioTopicsListParams,
    ) -> Answer {
        let agent = id_of(&params.agent_id).ok_or_else(|| invalid("Choose an agent ID."))?;
        let platform = self.platform_for(caller, params.scope)?;
        let topics = platform.topics(&agent).map_err(failed)?;
        json(StudioTopicsListResult {
            topics: topics.into_iter().filter_map(topic).take(200).collect(),
        })
    }

    pub(crate) fn studio_routines_list(
        &self,
        caller: &str,
        params: StudioRoutinesListParams,
    ) -> Answer {
        let agent = id_of(&params.agent_id).ok_or_else(|| invalid("Choose an agent ID."))?;
        let page = params.page.unwrap_or(1).clamp(1, u64::from(u32::MAX)) as u32;
        let limit = params.limit.unwrap_or(ROUTINES).clamp(1, 100) as u32;
        let platform = self.platform_for(caller, params.scope)?;
        let answer = platform
            .routines(&agent, Some(page), limit)
            .map_err(failed)?;
        json(StudioRoutinesListResult {
            routines: answer
                .routines
                .into_iter()
                .filter_map(routine)
                .take(100)
                .collect(),
            total: answer.total.into(),
        })
    }
}
