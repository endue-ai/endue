//! A conversation's messages as the thread shows them: the person's and the agent's words, their
//! times and runs, and each turn's work. Rows of any other role (a tool's answer, a system note) and
//! an assistant row's tool calls are folded into the work of the assistant message of their run;
//! no argument, result or reasoning is read (`wire_chat`). Also where the person read up to.

use std::collections::{BTreeMap, BTreeSet};

use desk_sys::net::Method;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::http::{encode, with_query};
use crate::run::valid_id;
use crate::wire_chat::{ConversationRead, MessageList, MessageRow, ToolRow};
use crate::work::{ChatWork, Tally};
use crate::{ErrorKind, Platform, PlatformError, Result};

/// The most messages one page holds.
pub const MAX_MESSAGES: u32 = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatRole {
    User,
    Assistant,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub role: ChatRole,
    /// Markdown.
    pub text: String,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work: Option<ChatWork>,
}

/// One page of a conversation's messages, oldest first.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagePage {
    pub messages: Vec<ChatMessage>,
    /// Earlier messages are there to read, `before` the first of these.
    pub has_more: bool,
}

impl Platform {
    /// The newest `limit` (1 to 100) messages of a conversation, or the ones before the message
    /// `before` when the thread is read further back.
    pub fn messages(
        &self,
        conversation_id: &str,
        before: Option<&str>,
        limit: u32,
    ) -> Result<MessagePage> {
        if !(1..=MAX_MESSAGES).contains(&limit) {
            return Err(PlatformError::new(
                ErrorKind::Invalid,
                format!("limit must be 1 to {MAX_MESSAGES}"),
            ));
        }
        let path = format!(
            "/api/v1/ai/conversations/{}/messages",
            encode(conversation_id)
        );
        let path = with_query(
            &path,
            &[
                ("limit", Some(limit.to_string())),
                ("latest", before.is_none().then(|| "true".to_owned())),
                ("before", before.map(str::to_owned)),
            ],
        );
        let list: MessageList = self.read(Method::Get, &path, None, "the messages")?;
        let more = list.has_more.unwrap_or(list.items.len() >= limit as usize);
        Ok(MessagePage {
            messages: fold(&list.items),
            has_more: more,
        })
    }

    /// Mark the conversation read up to now; when it was read before this, if ever.
    pub fn mark_read(&self, conversation_id: &str) -> Result<Option<String>> {
        let path = format!("/api/v1/ai/conversations/{}", encode(conversation_id));
        let before: ConversationRead = self.read(Method::Get, &path, None, "the conversation")?;
        self.send(Method::Post, &format!("{path}/read"), Some(&json!({})))?;
        Ok(before.last_read_at)
    }
}

/// Rows, oldest first, as the thread's messages, each turn's work on its run's last answer.
pub(crate) fn fold(items: &[Value]) -> Vec<ChatMessage> {
    let mut rows = Vec::new();
    let mut tools = Vec::new();
    for item in items {
        if item["role"] == "tool" {
            if let Ok(row) = serde_json::from_value::<ToolRow>(item.clone()) {
                tools.push(row);
            }
        } else if let Ok(row) = serde_json::from_value::<MessageRow>(item.clone()) {
            rows.push(row);
        }
    }
    // The calls this page makes, so each tool row counts once: with its call, or alone.
    let called: BTreeSet<&str> = rows
        .iter()
        .flat_map(|r| r.tool_calls.iter().filter_map(|c| c.id.as_deref()))
        .collect();
    let failed: BTreeMap<&str, bool> = tools
        .iter()
        .filter_map(|t| {
            let id = t.tool_call_id.as_deref()?;
            Some((id, t.metadata.is_error == Some(true)))
        })
        .collect();
    let mut tallies: BTreeMap<String, Tally> = BTreeMap::new();
    let mut last_answer: BTreeMap<String, usize> = BTreeMap::new();
    let mut messages = Vec::new();
    for row in &rows {
        if !valid_id(&row.id) {
            continue;
        }
        let run = row.run_id.clone().filter(|id| valid_id(id));
        let role = match row.role.as_str() {
            "user" => ChatRole::User,
            "assistant" => ChatRole::Assistant,
            // A system note is not a message of the thread.
            _ => continue,
        };
        if role == ChatRole::Assistant
            && let Some(run) = &run
        {
            let tally = tallies.entry(run.clone()).or_default();
            for call in &row.tool_calls {
                let failed = call.id.as_deref().and_then(|id| failed.get(id).copied());
                tally.call(&call.function.name, failed.unwrap_or(false));
            }
            if let Some(presentation) = &row.metadata.presentation {
                tally.present(presentation);
            }
        }
        let Some(text) = row.content.clone().filter(|t| !t.trim().is_empty()) else {
            continue;
        };
        if role == ChatRole::Assistant
            && let Some(run) = &run
        {
            last_answer.insert(run.clone(), messages.len());
        }
        messages.push(ChatMessage {
            id: row.id.clone(),
            role,
            text,
            created_at: row.created_at.clone().unwrap_or_default(),
            run_id: run,
            work: None,
        });
    }
    for tool in &tools {
        let answered = tool
            .tool_call_id
            .as_deref()
            .is_some_and(|id| called.contains(id));
        if let (false, Some(run), Some(name)) = (answered, &tool.run_id, &tool.name) {
            let failed = tool.metadata.is_error == Some(true);
            tallies.entry(run.clone()).or_default().call(name, failed);
        }
    }
    for (run, tally) in tallies {
        if let (Some(&at), false) = (last_answer.get(&run), tally.is_empty()) {
            messages[at].work = Some(tally.work("completed"));
        }
    }
    messages
}
