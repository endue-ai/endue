//! The agent window's conversation (ADR 0411): its messages, the person's line into it, a run
//! followed as it goes, a stop, and the last read. A send or an attach comes only from the shell,
//! as the person's own act in the window, so it asks nothing; Eris's `desk.endue.ask` keeps its
//! review (ADR 0395). A run's steps go to that caller only, as `studio.chat.event`; deltas are
//! joined so at most one leaves every 50 ms. Only text, times, the phase, counts and a group's
//! label and provider cross: no argument, result or reasoning.

use std::thread;
use std::time::{Duration, Instant};

use desk_bridge::{
    BridgeEvent, ErrorCode, StudioChatAttachParams, StudioChatAttachResult, StudioChatEvent,
    StudioChatEventData, StudioChatEventKind, StudioChatSendParams, StudioChatSendResult,
    StudioChatStopParams, StudioChatStopResult, StudioConversationsReadParams,
    StudioConversationsReadResult, StudioMessage, StudioMessageRole, StudioMessagesListParams,
    StudioMessagesListResult, StudioWork, StudioWorkGroup,
};
use desk_platform::{ChatConversation, ChatEvent, ChatRole, ChatWork, Platform, wire::AgentStatus};

use super::spaces::id_of;
use crate::core_studio::{failed, invalid, words};
use crate::events::EventBus;
use crate::handler::{Answer, Core, error, json};

/// How often a run's new text may leave for the shell.
const DELTA_EVERY: Duration = Duration::from_millis(50);
const MAX_TEXT: usize = 12_000;
const MAX_MESSAGE: usize = 500;

fn shell_only(caller: &str) -> Result<(), desk_bridge::BridgeError> {
    if caller == "desk" {
        return Ok(());
    }
    Err(error(
        ErrorCode::PermissionDenied,
        "Only the person, in the agent's window, talks in its conversation.".to_owned(),
    ))
}

fn conversation_id(text: &str) -> Result<String, desk_bridge::BridgeError> {
    id_of(text).ok_or_else(|| invalid("Choose a conversation ID."))
}

fn cut(text: String, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((at, _)) => text[..at].to_owned(),
        None => text,
    }
}

pub(crate) fn work(w: ChatWork) -> StudioWork {
    StudioWork {
        phase: cut(w.phase, 32),
        started_at: w.started_at,
        ended_at: w.ended_at,
        attempted: w.attempted.into(),
        succeeded: w.succeeded.into(),
        failed: w.failed.into(),
        groups: w
            .groups
            .into_iter()
            .take(50)
            .map(|g| StudioWorkGroup {
                label: cut(g.label, 200),
                provider: g.provider.map(|p| cut(p, 200)),
                calls: g.calls.into(),
                failed: g.failed.into(),
            })
            .collect(),
    }
}

/// A run's steps as the shell reads them, with deltas joined to one every 50 ms.
struct Forward {
    events: EventBus,
    to: String,
    conversation: String,
    run: Option<String>,
    pending: String,
    sent: Option<Instant>,
}

impl Forward {
    fn publish(&self, kind: StudioChatEventKind, text: Option<String>, work: Option<StudioWork>) {
        self.message(kind, text, work, None);
    }

    fn message(
        &self,
        kind: StudioChatEventKind,
        text: Option<String>,
        work: Option<StudioWork>,
        message: Option<String>,
    ) {
        let data = StudioChatEventData {
            conversation_id: self.conversation.clone(),
            run_id: self.run.clone(),
            kind,
            text: text.map(|t| cut(t, MAX_TEXT)),
            work,
            message: message.map(|m| cut(m, MAX_MESSAGE)),
        };
        let event = BridgeEvent::StudioChat(StudioChatEvent {
            event: Default::default(),
            data,
        });
        self.events.publish_to(vec![self.to.clone()], event);
    }

    fn flush(&mut self) {
        if self.pending.is_empty() {
            return;
        }
        let text = std::mem::take(&mut self.pending);
        self.sent = Some(Instant::now());
        self.publish(StudioChatEventKind::Delta, Some(text), None);
    }

    fn on(&mut self, event: ChatEvent) {
        match event {
            ChatEvent::Delta(text) => {
                self.pending.push_str(&text);
                if self.sent.is_none_or(|at| at.elapsed() >= DELTA_EVERY) {
                    self.flush();
                }
            }
            other => {
                self.flush();
                match other {
                    ChatEvent::Started { run_id } => {
                        self.run = id_of(&run_id);
                        self.publish(StudioChatEventKind::Started, None, None);
                    }
                    ChatEvent::Work(w) => {
                        self.publish(StudioChatEventKind::Work, None, Some(work(w)))
                    }
                    ChatEvent::NeedsInput { message } => {
                        self.message(StudioChatEventKind::NeedsInput, None, None, message)
                    }
                    ChatEvent::Completed { text } => {
                        self.publish(StudioChatEventKind::Completed, Some(text), None)
                    }
                    ChatEvent::Failed { message } => {
                        self.message(StudioChatEventKind::Failed, None, None, Some(message))
                    }
                    ChatEvent::Cancelled => {
                        self.publish(StudioChatEventKind::Cancelled, None, None)
                    }
                    ChatEvent::Delta(_) => {}
                }
            }
        }
    }
}

/// Follow a run on its own thread; `read` streams it, calling back with each step.
fn follow<F>(
    core: &Core,
    caller: &str,
    conversation: ChatConversation,
    read: F,
) -> Result<(), desk_bridge::BridgeError>
where
    F: FnOnce(&ChatConversation, &mut dyn FnMut(ChatEvent)) + Send + 'static,
{
    let mut forward = Forward {
        events: core.events().clone(),
        to: caller.to_owned(),
        conversation: conversation.id.clone(),
        run: None,
        pending: String::new(),
        sent: None,
    };
    thread::Builder::new()
        .name("desk-studio-chat".to_owned())
        .spawn(move || {
            read(&conversation, &mut |event| forward.on(event));
            forward.flush();
        })
        .map(drop)
        .map_err(|_| {
            error(
                ErrorCode::IoError,
                "Could not follow the agent's run.".to_owned(),
            )
        })
}

fn active_agent(platform: &Platform, agent_id: &str) -> Result<(), desk_bridge::BridgeError> {
    let agent = platform.get_agent(agent_id).map_err(failed)?;
    if agent.id != agent_id || agent.status != AgentStatus::Active {
        return Err(invalid("Choose an active endue AI agent."));
    }
    Ok(())
}

impl Core {
    pub(crate) fn studio_messages_list(
        &self,
        caller: &str,
        params: StudioMessagesListParams,
    ) -> Answer {
        let id = conversation_id(&params.conversation_id)?;
        let before = params
            .before
            .as_deref()
            .map(|id| id_of(id).ok_or_else(|| invalid("Choose a message ID.")))
            .transpose()?;
        let limit = params.limit.unwrap_or(20).clamp(1, 100) as u32;
        let platform = self.platform_for(caller, params.scope)?;
        let page = platform
            .messages(&id, before.as_deref(), limit)
            .map_err(failed)?;
        let messages = page
            .messages
            .into_iter()
            .filter_map(|m| {
                Some(StudioMessage {
                    id: id_of(&m.id)?,
                    role: match m.role {
                        ChatRole::User => StudioMessageRole::User,
                        ChatRole::Assistant => StudioMessageRole::Assistant,
                    },
                    text: cut(m.text, MAX_TEXT),
                    created_at: m.created_at,
                    run_id: m.run_id.as_deref().and_then(id_of),
                    work: m.work.map(work),
                })
            })
            .take(100)
            .collect();
        json(StudioMessagesListResult {
            messages,
            has_more: page.has_more,
        })
    }

    pub(crate) fn studio_chat_send(&self, caller: &str, params: StudioChatSendParams) -> Answer {
        shell_only(caller)?;
        let agent_id = id_of(&params.agent_id).ok_or_else(|| invalid("Choose an agent ID."))?;
        let given = params
            .conversation_id
            .as_deref()
            .map(conversation_id)
            .transpose()?;
        let space_id = params
            .space_id
            .as_deref()
            .map(|id| id_of(id).ok_or_else(|| invalid("Choose a space ID.")))
            .transpose()?;
        let text = words(&params.text, "text", 8000)?;
        let message = params.message_id.clone();
        if !(8..=64).contains(&message.len()) || id_of(&message).is_none() {
            return Err(invalid(
                "Choose a message ID of 8 to 64 letters, digits, - or _.",
            ));
        }
        let platform = self.platform_for(caller, params.scope)?;
        let conversation = match (given, space_id.as_deref()) {
            (Some(id), _) => ChatConversation {
                id,
                agent_id: agent_id.clone(),
            },
            (None, Some(space)) => platform.space_conversation(space).map_err(failed)?,
            (None, None) => {
                active_agent(&platform, &agent_id)?;
                platform.new_agent_conversation(&agent_id).map_err(failed)?
            }
        };
        if conversation.agent_id != agent_id {
            return Err(invalid("This conversation belongs to another agent."));
        }
        let conversation_id = conversation_id(&conversation.id)
            .map_err(|_| invalid("endue AI returned an invalid conversation identifier."))?;
        follow(self, caller, conversation, move |conversation, on| {
            let _ = platform.stream_turn(conversation, &text, &message, on);
        })?;
        json(StudioChatSendResult {
            conversation_id,
            run_id: None,
        })
    }

    pub(crate) fn studio_chat_attach(
        &self,
        caller: &str,
        params: StudioChatAttachParams,
    ) -> Answer {
        shell_only(caller)?;
        let id = conversation_id(&params.conversation_id)?;
        let agent_id = id_of(&params.agent_id).ok_or_else(|| invalid("Choose an agent ID."))?;
        let platform = self.platform_for(caller, params.scope)?;
        let conversation = ChatConversation { id, agent_id };
        follow(self, caller, conversation, move |conversation, on| {
            let _ = platform.attach(conversation, on);
        })?;
        json(StudioChatAttachResult { attached: true })
    }

    pub(crate) fn studio_chat_stop(&self, caller: &str, params: StudioChatStopParams) -> Answer {
        shell_only(caller)?;
        let id = conversation_id(&params.conversation_id)?;
        let run = id_of(&params.run_id).ok_or_else(|| invalid("Choose a run ID."))?;
        let platform = self.platform_for(caller, params.scope)?;
        platform.cancel_run(&id, &run).map_err(failed)?;
        json(StudioChatStopResult { stopped: true })
    }

    pub(crate) fn studio_conversations_read(
        &self,
        caller: &str,
        params: StudioConversationsReadParams,
    ) -> Answer {
        let id = conversation_id(&params.conversation_id)?;
        let platform = self.platform_for(caller, params.scope)?;
        let previous_read_at = platform.mark_read(&id).map_err(failed)?;
        json(StudioConversationsReadResult { previous_read_at })
    }
}
