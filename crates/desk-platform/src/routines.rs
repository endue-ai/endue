//! An agent's routines, as the side of its window lists them: name, what starts it, on or off, and
//! when it last ran with how that ended. A routine's prompt, webhook address and secret, config and
//! run history are never read (`wire_side::RoutineRow` names none of them).

use desk_sys::net::Method;
use serde::{Deserialize, Serialize};

use crate::http::with_query;
use crate::schedule;
use crate::wire_side::{RoutineRow, Rows};
use crate::{ErrorKind, Platform, PlatformError, Result};

/// The most routines one page holds.
pub const MAX_ROUTINES: u32 = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TriggerKind {
    Schedule,
    Webhook,
    /// Something that happened; endue AI sends no such trigger yet.
    Event,
}

/// What starts a routine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoutineTrigger {
    pub kind: TriggerKind,
    /// A schedule in a sentence ("Every weekday at 9:00 (Asia/Seoul)"); none for a webhook. endue
    /// AI answers a cron expression and its time zone, which the desk words (`schedule`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

/// One routine, as its row shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Routine {
    pub id: String,
    pub name: String,
    /// It runs when its time or its call comes (active), not while paused or after it is done.
    pub enabled: bool,
    pub trigger: RoutineTrigger,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run_at: Option<String>,
    /// `completed` or `failed`, from how many runs failed in a row; none before the first run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run_status: Option<String>,
}

/// One page of routines, and how many there are in all.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoutinePage {
    pub routines: Vec<Routine>,
    pub total: u32,
}

impl From<RoutineRow> for Routine {
    fn from(row: RoutineRow) -> Self {
        let webhook =
            row.trigger.as_deref() == Some("webhook") || row.schedule.as_deref() == Some("webhook");
        let kind = match row.trigger.as_deref() {
            _ if webhook => TriggerKind::Webhook,
            Some("event") => TriggerKind::Event,
            _ => TriggerKind::Schedule,
        };
        let text = match kind {
            TriggerKind::Schedule => schedule::words(&row),
            _ => None,
        };
        let last_run_status = row.last_fired_at.as_ref().map(|_| {
            if row.consecutive_failures > 0 {
                "failed".to_owned()
            } else {
                "completed".to_owned()
            }
        });
        Self {
            id: row.id,
            name: row.name,
            enabled: row.status == "active",
            trigger: RoutineTrigger { kind, text },
            last_run_at: row.last_fired_at,
            last_run_status,
        }
    }
}

impl Platform {
    /// One page (1-based, 1 unless given) of the agent's routines, `limit` (1 to 100) a page;
    /// cancelled ones are left out, as endue AI leaves them out.
    pub fn routines(&self, agent_id: &str, page: Option<u32>, limit: u32) -> Result<RoutinePage> {
        if !(1..=MAX_ROUTINES).contains(&limit) {
            return Err(PlatformError::new(
                ErrorKind::Invalid,
                format!("limit must be 1 to {MAX_ROUTINES}"),
            ));
        }
        let path = with_query(
            "/api/v1/ai/routines",
            &[
                ("agent_id", Some(agent_id.to_owned())),
                ("page", Some(page.unwrap_or(1).max(1).to_string())),
                ("limit", Some(limit.to_string())),
            ],
        );
        let rows: Rows = self.read(Method::Get, &path, None, "the routines")?;
        Ok(RoutinePage {
            routines: rows
                .read::<RoutineRow>()
                .into_iter()
                .map(Routine::from)
                .collect(),
            total: rows.total,
        })
    }
}
