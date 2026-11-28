//! The bodies of the desk's own key and of the account's connectors (specs/platform/v0 `ApiKey*`,
//! `Connector*`): what the desk sends and what endue AI answers, as the contract writes them.

use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// What a key may do with the account's connectors (`ApiKeyScope`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum KeyScope {
    #[serde(rename = "connectors:read")]
    Read,
    #[serde(rename = "connectors:write")]
    Write,
    #[serde(rename = "connectors:send")]
    Send,
    #[serde(rename = "connectors:delete")]
    Delete,
}

/// `ApiKeyCreateRequest`: a name for people and what the key may do. The desk asks for no expiry;
/// it revokes the key itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NewKey {
    pub name: String,
    pub scopes: Vec<KeyScope>,
}

/// `ApiKeyCreated`: the key just made, with its secret this once. Its `Debug` leaves the secret
/// out, so a log line or a test failure never prints it.
#[derive(Clone, PartialEq, Eq, Deserialize)]
pub struct KeyCreated {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    pub secret: String,
    pub scopes: Vec<KeyScope>,
    #[serde(default)]
    pub created_at: Option<String>,
}

impl fmt::Debug for KeyCreated {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("KeyCreated")
            .field("id", &self.id)
            .field("name", &self.name)
            .field("secret", &"<kept out>")
            .field("scopes", &self.scopes)
            .field("created_at", &self.created_at)
            .finish()
    }
}

/// `ConnectorStatus`: an expired connector is reconnected on endue.ai, never by the desk.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnectorStatus {
    Active,
    Expired,
}

/// `ConnectorSummary`: one of the account's connectors.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConnectorSummary {
    pub connector_id: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub display_name: Option<String>,
    pub status: ConnectorStatus,
    #[serde(default)]
    pub tool_count: Option<u64>,
}

/// `ConnectorRisk`: a tool's tier, which decides the scope a key needs to call it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Risk {
    Read,
    Write,
    Send,
    Destructive,
}

impl Risk {
    /// The scope a key needs to call a tool of this tier.
    pub fn scope(self) -> KeyScope {
        match self {
            Risk::Read => KeyScope::Read,
            Risk::Write => KeyScope::Write,
            Risk::Send => KeyScope::Send,
            Risk::Destructive => KeyScope::Delete,
        }
    }
}

/// `ConnectorTool`: one tool of a connector. `risk: null` is a tool no key may call.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConnectorTool {
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub risk: Option<Risk>,
    pub callable: bool,
    #[serde(default)]
    pub input_schema: Value,
}

/// `ConnectorToolCallRequest`: the tool's arguments.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ToolArguments {
    pub arguments: Map<String, Value>,
}

/// `ConnectorToolError.reason`: why a network refused, for machines.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Refusal {
    /// The network cannot do it (its capabilities say false).
    Unsupported,
    /// The connector must be reconnected on endue.ai, or lacks a permission.
    Reauth,
    /// A network or endue limit: `retry_after` seconds.
    Quota,
    /// The network refused the content (policy, duplicate).
    Rejected,
    /// An argument is wrong.
    Invalid,
    /// A call with the same idempotency key is still running.
    InProgress,
}

/// `ConnectorToolError`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolError {
    pub reason: Refusal,
    pub message: String,
    #[serde(default)]
    pub retry_after: Option<u64>,
}

/// `ConnectorToolCall`: what one call answered. `ok: false` at 200 is the network's own refusal,
/// with `error` when the tool names a reason.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolCall {
    pub ok: bool,
    pub content: String,
    #[serde(default)]
    pub data: Option<Value>,
    #[serde(default)]
    pub truncated: bool,
    pub tool: String,
    #[serde(default)]
    pub risk: Option<Risk>,
    #[serde(default)]
    pub error: Option<ToolError>,
}

/// What an upload answered (`POST /api/public/v1/connectors/media`): the id a tool's `media` takes
/// for a day, and what endue AI kept.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MediaUploaded {
    pub media_id: String,
    pub mime: String,
    pub size: u64,
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub expires_at: Option<Value>,
}

/// A page of the connector API: `{ items, total }`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Items<T> {
    pub items: Vec<T>,
}
