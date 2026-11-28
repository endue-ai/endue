//! The fake's topics and routines, as ai-agent-service answers them (`{ success, data: { items,
//! total } }`): an agent's topics with their thread counts, the topic filter's threads, a new thread
//! in a topic, and the person's routines kept whole (prompt, webhook address and secret, config and
//! runs), so a test can prove the client reads none of it.

use serde_json::{Value, json};

use super::Seen;
use super::routes::{Answer, error, ok};
use super::state::State;

fn success(body: Value) -> Answer {
    ok(json!({ "success": true, "data": body }))
}

fn number(seen: &Seen, key: &str, default: usize) -> usize {
    seen.query
        .get(key)
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
        .max(1)
}

impl State {
    /// Seed a topic of `agent_id` named `name`, with its main conversation, as making one on
    /// endue.ai does; its id. It becomes the latest active.
    pub fn add_topic(&mut self, agent_id: &str, name: &str) -> String {
        let id = format!("top_{}", self.topics.len() + 1);
        let main = self.add_conversation(agent_id, name, None, false);
        if let Some(row) = self.conversations.iter_mut().find(|c| c["id"] == main) {
            row["topic_id"] = json!(id);
        }
        let at = self.tick();
        self.topics.insert(
            0,
            json!({
                "id": id, "agent_id": agent_id, "name": name, "instructions": "", "goal": "",
                "status": "active", "main_conversation_id": main, "icon": null,
                "icon_source": "auto", "last_activity_at": at, "created_at": at, "updated_at": at
            }),
        );
        id
    }

    /// Seed a thread of the topic `topic_id` titled `title`; its conversation's id.
    pub fn add_thread(&mut self, topic_id: &str, title: &str) -> String {
        let agent = self
            .topic(topic_id)
            .and_then(|t| t["agent_id"].as_str())
            .unwrap_or_default()
            .to_owned();
        let id = self.add_conversation(&agent, title, None, false);
        if let Some(row) = self.conversations.iter_mut().find(|c| c["id"] == id) {
            row["topic_id"] = json!(topic_id);
        }
        self.touch(topic_id);
        id
    }

    /// Seed a routine: `routine` as endue AI keeps it (`agent_id`, `name`, `prompt`, `cron_expr`,
    /// `trigger`, `webhook_url`, …), with an id, an active status and times added where it has
    /// none; its id.
    pub fn add_routine(&mut self, mut routine: Value) -> String {
        let id = routine["id"]
            .as_str()
            .map_or_else(|| format!("rtn_{}", self.routines.len() + 1), str::to_owned);
        let at = self.tick();
        routine["id"] = json!(id);
        for (key, value) in [
            ("status", json!("active")),
            ("trigger", json!("schedule")),
            ("timezone", json!("UTC")),
            ("fire_count", json!(0)),
            ("consecutive_failures", json!(0)),
            ("created_at", json!(at)),
            ("updated_at", json!(at)),
        ] {
            if routine.get(key).is_none() {
                routine[key] = value;
            }
        }
        self.routines.push(routine);
        id
    }

    pub fn topic(&self, id: &str) -> Option<&Value> {
        self.topics.iter().find(|t| t["id"] == id)
    }

    /// The topic's latest activity is now: it moves to the head of the list.
    fn touch(&mut self, topic_id: &str) {
        let at = self.tick();
        if let Some(at_index) = self.topics.iter().position(|t| t["id"] == topic_id) {
            let mut topic = self.topics.remove(at_index);
            topic["last_activity_at"] = json!(at);
            self.topics.insert(0, topic);
        }
    }

    /// A topic's conversations other than its main one.
    fn threads_of(&self, topic: &Value) -> usize {
        self.conversations
            .iter()
            .filter(|c| c["topic_id"] == topic["id"] && c["id"] != topic["main_conversation_id"])
            .count()
    }
}

/// A new conversation of `agent` in the topic `topic` (`POST /api/v1/ai/conversations` with a
/// `topic_id`): 404 unless it is the agent's active topic, as endue AI answers.
pub(super) fn new_thread(state: &mut State, agent: &str, topic: &str) -> Answer {
    let usable = state
        .topic(topic)
        .is_some_and(|t| t["agent_id"] == agent && t["status"] == "active");
    if !usable {
        return error(404, "NOT_FOUND", "Topic not found");
    }
    let id = state.add_thread(topic, "");
    if let Some(row) = state.conversations.iter_mut().find(|c| c["id"] == id) {
        row["title"] = Value::Null;
        row["message_count"] = json!(0);
        row["last_message_preview"] = Value::Null;
    }
    state
        .chat_conversations
        .insert(id.clone(), agent.to_owned());
    super::routes::data(json!({ "id": id, "agent_id": agent, "topic_id": topic }))
}

/// The answer to `seen`, when it reads topics or routines.
pub(super) fn answer(state: &State, seen: &Seen, parts: &[&str]) -> Option<Answer> {
    if seen.method != "GET" {
        return None;
    }
    let (page, limit) = (number(seen, "page", 1), number(seen, "limit", 20).min(100));
    let rows: Vec<Value> = match parts {
        ["api", "v1", "ai", "agents", agent, "topics"] => {
            let status = seen.query.get("status").map_or("active", String::as_str);
            if status != "active" && status != "archived" {
                return Some(error(
                    400,
                    "BAD_REQUEST",
                    "status must be one of: active, archived",
                ));
            }
            // Another person's agent, or none: an empty list, as endue AI answers.
            state
                .topics
                .iter()
                .filter(|t| t["agent_id"] == *agent && t["status"] == status)
                .map(|t| {
                    let mut row = t.clone();
                    row["thread_count"] = json!(state.threads_of(t));
                    row
                })
                .collect()
        }
        ["api", "v1", "ai", "routines"] => {
            let status = seen.query.get("status");
            state
                .routines
                .iter()
                .filter(|r| {
                    seen.query
                        .get("agent_id")
                        .is_none_or(|id| r["agent_id"] == id.as_str())
                })
                .filter(|r| match status {
                    Some(status) => r["status"] == status.as_str(),
                    None => r["status"] != "cancelled",
                })
                .cloned()
                .collect()
        }
        _ => return None,
    };
    let items: Vec<&Value> = rows.iter().skip((page - 1) * limit).take(limit).collect();
    Some(success(json!({ "items": items, "total": rows.len() })))
}
