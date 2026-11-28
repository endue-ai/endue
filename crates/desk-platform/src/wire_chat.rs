//! What the desk reads of a conversation's messages and of a run's server-sent events
//! (specs/platform/v0: `MessageListEnvelope`, `MessageRow`, `ToolRow`, `Run*Event`,
//! `RunPresentation`, `AgentConversationDone`). Only text, times, ids, a run's phase and counts and
//! each tool's name and outcome are named: a tool's arguments, its result, reasoning and every other
//! field are never deserialized, so they cannot be kept.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer};
use serde_json::Value;

/// A field that reads as its default when it is not the expected shape (a tolerant reader).
fn lenient<'de, D: Deserializer<'de>, T: DeserializeOwned + Default>(d: D) -> Result<T, D::Error> {
    Ok(serde_json::from_value(Value::deserialize(d)?).unwrap_or_default())
}

/// Text, or nothing when the field is not a string.
fn text<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Ok(match Value::deserialize(d)? {
        Value::String(s) => Some(s),
        _ => None,
    })
}

/// A call's outcome: `false` (or `"false"`) failed; anything else did not.
fn ok_flag<'de, D: Deserializer<'de>>(d: D) -> Result<bool, D::Error> {
    Ok(match Value::deserialize(d)? {
        Value::Bool(ok) => ok,
        Value::String(s) => s != "false",
        _ => true,
    })
}

fn yes() -> bool {
    true
}

/// `MessageListEnvelope`'s data: one page, oldest first. Rows are read one at a time, so one row
/// the desk cannot read does not lose the page.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct MessageList {
    #[serde(default)]
    pub items: Vec<Value>,
    #[serde(default, deserialize_with = "lenient")]
    pub has_more: Option<bool>,
}

/// `MessageRow`: a user or assistant row (`content` is its markdown; an assistant row may call
/// tools, whose names alone are read).
#[derive(Debug, Clone, Deserialize)]
pub struct MessageRow {
    pub id: String,
    #[serde(default, deserialize_with = "text")]
    pub run_id: Option<String>,
    pub role: String,
    #[serde(default, deserialize_with = "text")]
    pub content: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    pub tool_calls: Vec<RowToolCall>,
    #[serde(default, deserialize_with = "lenient")]
    pub metadata: RowMetadata,
    #[serde(default, deserialize_with = "text")]
    pub created_at: Option<String>,
}

/// One call an assistant row makes: its id and its tool's name; never its arguments.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct RowToolCall {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub function: RowFunction,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct RowFunction {
    #[serde(default)]
    pub name: String,
}

/// `ToolRow`: a tool's answer to one call. Its content (the result) is not read.
#[derive(Debug, Clone, Deserialize)]
pub struct ToolRow {
    #[serde(default, deserialize_with = "text")]
    pub run_id: Option<String>,
    #[serde(default, deserialize_with = "text")]
    pub tool_call_id: Option<String>,
    #[serde(default, deserialize_with = "text")]
    pub name: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    pub metadata: RowMetadata,
}

/// What a row's metadata says that the desk reads: whether a tool row failed, and the run's
/// summary on a final answer.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct RowMetadata {
    #[serde(default, deserialize_with = "lenient")]
    pub is_error: Option<bool>,
    #[serde(default, deserialize_with = "lenient")]
    pub presentation: Option<RunPresentation>,
}

/// `RunPresentation`: the run's summary as it stands; a newer `revision` replaces an older one.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct RunPresentation {
    #[serde(default, deserialize_with = "text")]
    pub run_id: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    pub revision: u64,
    #[serde(default, deserialize_with = "text")]
    pub phase: Option<String>,
    #[serde(default, deserialize_with = "text")]
    pub started_at: Option<String>,
    #[serde(default, deserialize_with = "text")]
    pub ended_at: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    pub counts: RunCounts,
    #[serde(default, deserialize_with = "lenient")]
    pub references: Vec<RunReference>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct RunCounts {
    #[serde(default)]
    pub attempted: u32,
    #[serde(default)]
    pub succeeded: u32,
    #[serde(default)]
    pub failed: u32,
}

/// Something the run leaned on; the desk reads the connectors among them.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct RunReference {
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub usage: Option<String>,
}

/// `run_created`.
#[derive(Debug, Clone, Deserialize)]
pub struct RunCreatedEvent {
    pub run_id: String,
}

/// `delta`: the next piece of the answer.
#[derive(Debug, Clone, Deserialize)]
pub struct RunDeltaEvent {
    pub content: String,
}

/// `step`: the calls a step made and how each went; never their arguments or results.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct RunStepEvent {
    #[serde(default, deserialize_with = "lenient")]
    pub tool_calls: Vec<StepCall>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct StepCall {
    #[serde(default)]
    pub name: String,
    #[serde(default = "yes", deserialize_with = "ok_flag")]
    pub ok: bool,
}

/// `run_presentation`.
#[derive(Debug, Clone, Deserialize)]
pub struct RunPresentationEvent {
    pub presentation: RunPresentation,
}

/// `interaction`: the run stopped for the person; the desk reads the question's words alone.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct RunInteractionEvent {
    #[serde(default, deserialize_with = "lenient")]
    pub payload: InteractionPayload,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct InteractionPayload {
    #[serde(default, deserialize_with = "text")]
    pub question: Option<String>,
    #[serde(default, deserialize_with = "text")]
    pub prompt: Option<String>,
}

/// `error`: the run failed or was stopped (`RUN_CANCELLED`).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct RunErrorEvent {
    #[serde(default, deserialize_with = "text")]
    pub code: Option<String>,
    #[serde(default, deserialize_with = "text")]
    pub message: Option<String>,
}

/// `done` (`AgentConversationDone`): the saved final message is authoritative.
#[derive(Debug, Clone, Deserialize)]
pub struct ChatDone {
    pub run_id: String,
    pub stop_reason: Option<String>,
    pub message: DoneMessage,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DoneMessage {
    pub role: String,
    pub content: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    pub metadata: RowMetadata,
}

/// `ConversationEnvelope`'s data: what the desk reads of one conversation.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ConversationRead {
    #[serde(default, deserialize_with = "text")]
    pub last_read_at: Option<String>,
}

/// A run stream frame's `run_id`, when it names one.
#[derive(Debug, Clone, Default, Deserialize)]
pub(crate) struct RunOf {
    #[serde(default, deserialize_with = "text")]
    pub run_id: Option<String>,
}
