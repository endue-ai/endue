//! What the side of an agent's window reads of ai-agent-service (specs/platform/v0: `Topic`,
//! `TopicListEnvelope`, `Routine`, `RoutineListEnvelope`). Only what a row shows is named: a topic's
//! instructions, goal and files, and a routine's prompt, webhook address and secret, config, run
//! history and conversation are never deserialized, so they cannot be kept. Field names follow
//! endue.ai's own clients (ai-agent-service `rowToTopicResponse`, `rowToRoutineResponse`).

use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer};
use serde_json::Value;

/// A field that reads as its default when it is absent, `null` or not the expected shape.
fn lenient<'de, D: Deserializer<'de>, T: DeserializeOwned + Default>(d: D) -> Result<T, D::Error> {
    Ok(serde_json::from_value(Value::deserialize(d)?).unwrap_or_default())
}

/// A page's rows, each read on its own, so one row the desk cannot read does not lose the page.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct Rows {
    #[serde(default, deserialize_with = "lenient")]
    pub items: Vec<Value>,
    #[serde(default, deserialize_with = "lenient")]
    pub total: u32,
}

impl Rows {
    /// The rows that read as `T`, in order.
    pub fn read<T: DeserializeOwned>(&self) -> Vec<T> {
        self.items
            .iter()
            .filter_map(|row| serde_json::from_value(row.clone()).ok())
            .collect()
    }
}

/// `Topic`: a subject of the agent's with its main conversation and threads.
#[derive(Debug, Clone, Deserialize)]
pub struct TopicRow {
    pub id: String,
    #[serde(default, deserialize_with = "lenient")]
    pub name: String,
    /// Its conversations other than the main one.
    #[serde(default, deserialize_with = "lenient")]
    pub thread_count: u32,
    #[serde(default, deserialize_with = "lenient")]
    pub last_activity_at: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    pub main_conversation_id: Option<String>,
}

/// `Routine`, as far as a row shows it: its name, whether it is on, what starts it and how its last
/// run went.
#[derive(Debug, Clone, Deserialize)]
pub struct RoutineRow {
    pub id: String,
    #[serde(default, deserialize_with = "lenient")]
    pub name: String,
    /// `active`, `paused`, `cancelled` or `done` (a one-time routine that ran).
    #[serde(default, deserialize_with = "lenient")]
    pub status: String,
    /// `schedule` or `webhook`; older servers send none.
    #[serde(default, deserialize_with = "lenient")]
    pub trigger: Option<String>,
    /// `recurring`, `one_time` or `webhook`; older servers send none.
    #[serde(default, deserialize_with = "lenient")]
    pub schedule: Option<String>,
    /// Five cron fields, for a recurring routine.
    #[serde(default, deserialize_with = "lenient")]
    pub cron_expr: Option<String>,
    /// A one-time routine's time.
    #[serde(default, deserialize_with = "lenient")]
    pub fire_at: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    pub timezone: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    pub last_fired_at: Option<String>,
    /// Runs that failed in a row, up to the last one: 0 when the last one did not fail.
    #[serde(default, deserialize_with = "lenient")]
    pub consecutive_failures: u32,
}
