//! An agent's topics, as the side of its window lists them, and a new thread in one. A topic's
//! threads are its conversations: `conversations` with `ConversationQuery::topic_id` reads them.

use desk_sys::net::Method;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::chat::ChatConversation;
use crate::http::{encode, with_query};
use crate::wire_side::{Rows, TopicRow};
use crate::{Platform, Result};

/// The most topics the platform answers on one page, and the side reads.
pub const MAX_TOPICS: u32 = 100;

/// One of an agent's topics, as its row shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Topic {
    pub id: String,
    pub name: String,
    /// Its conversations other than the main one.
    pub thread_count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_activity_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub main_conversation_id: Option<String>,
}

impl From<TopicRow> for Topic {
    fn from(row: TopicRow) -> Self {
        Self {
            id: row.id,
            name: row.name,
            thread_count: row.thread_count,
            last_activity_at: row.last_activity_at,
            main_conversation_id: row.main_conversation_id,
        }
    }
}

impl Platform {
    /// The agent's active topics, the latest activity first (the platform's order), at most 100.
    pub fn topics(&self, agent_id: &str) -> Result<Vec<Topic>> {
        let path = format!("/api/v1/ai/agents/{}/topics", encode(agent_id));
        let path = with_query(
            &path,
            &[
                ("status", Some("active".to_owned())),
                ("page", Some("1".to_owned())),
                ("limit", Some(MAX_TOPICS.to_string())),
            ],
        );
        let rows: Rows = self.read(Method::Get, &path, None, "the topics")?;
        Ok(rows
            .read::<TopicRow>()
            .into_iter()
            .map(Topic::from)
            .collect())
    }

    /// A new thread in the agent's topic `topic_id`, as endue.ai's "New thread" makes one: the
    /// agent and the topic alone; endue AI names it from its first turn.
    pub fn new_topic_conversation(
        &self,
        agent_id: &str,
        topic_id: &str,
    ) -> Result<ChatConversation> {
        self.read(
            Method::Post,
            "/api/v1/ai/conversations",
            Some(&json!({ "agent_id": agent_id, "topic_id": topic_id })),
            "the new thread",
        )
    }
}
