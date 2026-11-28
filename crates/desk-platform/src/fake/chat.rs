use serde_json::{Value, json};

use super::routes::{Answer, data, error, ok};
use super::{Seen, State};

/// The conversation whose run stream `seen` asks for: a run (`POST …/runs`) or an attach
/// (`GET …/attach`).
pub(super) fn stream_of(seen: &Seen) -> Option<(&str, bool)> {
    let rest = seen.path.strip_prefix("/api/v1/ai/conversations/")?;
    let (id, tail) = rest.split_once('/')?;
    match (seen.method.as_str(), tail) {
        ("POST", "runs") => Some((id, true)),
        ("GET", "attach") => Some((id, false)),
        _ => None,
    }
}

fn success(body: Value) -> Answer {
    ok(json!({ "success": true, "data": body }))
}

pub(super) fn answer(state: &mut State, seen: &Seen, parts: &[&str]) -> Option<Answer> {
    if seen.method == "GET" && *parts == ["api", "v1", "ai", "secretary"] {
        let Some((agent, conversation)) = state.eris.clone() else {
            return Some(data(json!({ "available": false })));
        };
        state
            .chat_conversations
            .insert(conversation.clone(), agent.clone());
        return Some(data(json!({
            "available": true, "enabled": true, "agent_id": agent,
            "conversation_id": conversation, "name": "Eris"
        })));
    }
    if let ["api", "v1", "ai", "conversations", conversation, rest @ ..] = parts
        && let Some(answer) = one(state, seen, conversation, rest)
    {
        return Some(answer);
    }
    if seen.method != "POST" {
        return None;
    }
    Some(match *parts {
        ["api", "v1", "ai", "conversations"] => {
            let agent = seen.body["agent_id"].as_str().unwrap_or_default();
            if !state
                .agents
                .iter()
                .any(|row| row.id == agent && !row.foreign && row.status == "active")
            {
                return Some(error(404, "NOT_FOUND", "Agent not found"));
            }
            let id = format!("cnv_desk_{}", state.chat_conversations.len() + 1);
            state
                .chat_conversations
                .insert(id.clone(), agent.to_owned());
            data(json!({ "id": id, "agent_id": agent }))
        }
        ["api", "v1", "spaces", space, "conversation"] => {
            let target = state
                .spaces
                .iter()
                .find(|row| row.id() == space && !row.foreign);
            let Some(agent) = target.and_then(|row| row.body["front_agent_id"].as_str()) else {
                return Some(error(404, "NOT_FOUND", "Front Desk not found"));
            };
            let id = format!("cnv_{space}");
            let bound = state
                .chat_conversations
                .entry(id.clone())
                .or_insert_with(|| agent.to_owned());
            data(json!({ "conversation_id": id, "agent_id": bound }))
        }
        _ => return None,
    })
}

/// One conversation's routes: itself, its messages, read, cancel, attach and runs.
fn one(state: &mut State, seen: &Seen, conversation: &str, rest: &[&str]) -> Option<Answer> {
    let known = |state: &State| state.agent_of(conversation).is_some();
    Some(match (seen.method.as_str(), rest) {
        ("GET", []) => {
            let agent = state.agent_of(conversation)?;
            let mut row = state
                .conversations
                .iter()
                .find(|c| c["id"] == conversation)
                .cloned()
                .unwrap_or_else(|| json!({ "id": conversation, "agent_id": agent }));
            row["last_read_at"] = json!(state.read_at.get(conversation));
            success(row)
        }
        ("GET", ["messages"]) if known(state) => messages(state, seen, conversation),
        ("POST", ["read"]) if known(state) => {
            let at = state.tick();
            state.read_at.insert(conversation.to_owned(), at.clone());
            success(json!({ "last_read_at": at }))
        }
        ("POST", ["cancel"]) if known(state) => {
            if !state.streaming.contains(conversation) {
                return Some(error(409, "CONFLICT", "No run in progress"));
            }
            state.cancelled.insert(conversation.to_owned());
            ok(json!({ "cancelled": true }))
        }
        ("GET", ["attach"]) if known(state) => match state.attach_stream {
            Some(_) => ok(json!(null)),
            None => (204, None),
        },
        ("POST", ["runs"]) => run(state, seen, conversation),
        (_, ["messages" | "read" | "cancel" | "attach"]) => {
            error(404, "NOT_FOUND", "Conversation not found")
        }
        _ => return None,
    })
}

fn run(state: &State, seen: &Seen, conversation: &str) -> Answer {
    let agent = state.agent_of(conversation);
    if agent.is_none() || agent.as_deref() != seen.body["agent_id"].as_str() {
        return error(409, "WRONG_TARGET", "Conversation target changed");
    }
    if seen
        .headers
        .get("accept")
        .is_none_or(|value| value != "text/event-stream")
        || seen.body["stream"] != true
        || seen.body["content"].as_str().is_none_or(str::is_empty)
        || seen.body["client_message_id"]
            .as_str()
            .is_none_or(str::is_empty)
    {
        return error(400, "INVALID_REQUEST", "Expected a text run and message ID");
    }
    ok(json!(null))
}

/// The newest `limit` rows (`latest=true`), or the `limit` before the row `before`, oldest first.
fn messages(state: &State, seen: &Seen, conversation: &str) -> Answer {
    let rows = state
        .messages
        .get(conversation)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let limit = seen
        .query
        .get("limit")
        .and_then(|l| l.parse::<usize>().ok())
        .unwrap_or(50)
        .clamp(1, 100);
    let end = match seen.query.get("before") {
        Some(before) => match rows.iter().position(|r| r["id"] == before.as_str()) {
            Some(at) => at,
            None => return error(404, "NOT_FOUND", "Message not found"),
        },
        None => rows.len(),
    };
    let start = end.saturating_sub(limit);
    success(json!({
        "items": rows[start..end], "total": rows.len(), "has_more": start > 0
    }))
}
