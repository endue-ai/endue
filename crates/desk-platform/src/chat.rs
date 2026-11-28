//! Conversations and their turns, on the web's conversation and run endpoints: Eris's own, a new
//! one with an agent, a space's Front Desk, a text turn read as it is written (`stream_turn`), a run
//! already in flight joined (`attach`), and a run stopped (`cancel_run`). Only the text, the run's
//! state and its work cross this client's boundary; interactive stops stay in the cloud
//! conversation for the person.

use desk_sys::net::Method;
use serde::Deserialize;
use serde_json::json;

pub use crate::wire_chat::ChatDone;

use crate::http::encode;
use crate::run::ChatEvent;
use crate::work::ChatWork;
use crate::{ErrorKind, Platform, Result};

#[derive(Debug, Clone, Deserialize)]
pub struct ChatConversation {
    #[serde(alias = "conversation_id")]
    pub id: String,
    pub agent_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChatState {
    Done,
    NeedsInput,
    /// The stream ended without an answer, or the run was stopped.
    Interrupted,
    Failed,
}

#[derive(Debug, Clone)]
pub struct ChatTurn {
    pub run_id: Option<String>,
    pub state: ChatState,
    /// The saved final answer, when the run completed.
    pub text: Option<String>,
    /// Why the run failed, when it did.
    pub message: Option<String>,
    /// The turn's work as it last stood, when it did any.
    pub work: Option<ChatWork>,
}

impl ChatTurn {
    pub fn interrupted() -> Self {
        Self {
            run_id: None,
            state: ChatState::Interrupted,
            text: None,
            message: None,
            work: None,
        }
    }
}

/// The person's Eris on endue AI, as `GET /api/v1/ai/secretary` answers.
#[derive(Debug, Deserialize)]
struct Eris {
    #[serde(default)]
    available: bool,
    #[serde(default = "yes")]
    enabled: bool,
    agent_id: Option<String>,
    conversation_id: Option<String>,
}

fn yes() -> bool {
    true
}

fn conversation_path(id: &str, rest: &str) -> String {
    format!("/api/v1/ai/conversations/{}/{rest}", encode(id))
}

impl Platform {
    /// The person's own Eris on endue AI and her conversation, which the web talks in too; `None`
    /// when the account has none, or she is turned off.
    pub fn eris(&self) -> Result<Option<ChatConversation>> {
        let eris: Eris = self.read(Method::Get, "/api/v1/ai/secretary", None, "Eris")?;
        Ok(
            match (
                eris.available && eris.enabled,
                eris.agent_id,
                eris.conversation_id,
            ) {
                (true, Some(agent_id), Some(id)) => Some(ChatConversation { id, agent_id }),
                _ => None,
            },
        )
    }

    /// A conversation for one reviewed question (ADR 0395): titled "From Desk", at the `ask`
    /// approval level.
    pub fn agent_conversation(&self, agent_id: &str) -> Result<ChatConversation> {
        self.read(
            Method::Post,
            "/api/v1/ai/conversations",
            Some(&json!({ "agent_id": agent_id, "title": "From Desk", "approval_level": "ask" })),
            "the new conversation",
        )
    }

    /// A new conversation the person starts with an agent, as endue.ai's "New chat" does: no title
    /// of the desk's own (endue AI names it from its first turn), the server's approval level.
    pub fn new_agent_conversation(&self, agent_id: &str) -> Result<ChatConversation> {
        self.read(
            Method::Post,
            "/api/v1/ai/conversations",
            Some(&json!({ "agent_id": agent_id })),
            "the new conversation",
        )
    }

    pub fn space_conversation(&self, space_id: &str) -> Result<ChatConversation> {
        self.read(
            Method::Post,
            &format!("/api/v1/spaces/{}/conversation", encode(space_id)),
            None,
            "the space's Front Desk conversation",
        )
    }

    /// One text turn read to its end, its events left unread: the final answer, or the state it
    /// stopped in. The caller picks a new client message ID once, before sending or renewing auth.
    pub fn chat_turn(
        &self,
        conversation: &ChatConversation,
        text: &str,
        message_id: &str,
    ) -> Result<ChatTurn> {
        self.stream_turn(conversation, text, message_id, &mut |_| {})
    }

    /// Send one text turn and hand each of its run's events to `on` as it arrives. The same
    /// `message_id` sent again joins the run it started instead of starting another.
    pub fn stream_turn(
        &self,
        conversation: &ChatConversation,
        text: &str,
        message_id: &str,
        on: &mut dyn FnMut(ChatEvent),
    ) -> Result<ChatTurn> {
        let body = json!({
            "agent_id": conversation.agent_id, "content": text, "stream": true,
            "client_message_id": message_id
        });
        let path = conversation_path(&conversation.id, "runs");
        self.run_stream(Method::Post, &path, Some(&body), on)
    }

    /// Join the run in flight in `conversation`, handing on its events from now on; an interrupted
    /// turn without a run id and without events when none is in flight.
    pub fn attach(
        &self,
        conversation: &ChatConversation,
        on: &mut dyn FnMut(ChatEvent),
    ) -> Result<ChatTurn> {
        let path = conversation_path(&conversation.id, "attach");
        self.run_stream(Method::Get, &path, None, on)
    }

    /// Stop the run `run_id`. A run that already ended (409) is not an error.
    pub fn cancel_run(&self, conversation_id: &str, run_id: &str) -> Result<()> {
        let path = conversation_path(conversation_id, "cancel");
        match self.send(Method::Post, &path, Some(&json!({ "run_id": run_id }))) {
            Err(e) if e.kind == ErrorKind::Conflict => Ok(()),
            other => other,
        }
    }
}
