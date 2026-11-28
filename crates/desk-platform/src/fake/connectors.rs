//! The fake's keys and connectors (ADR 0407), answered as endue AI answers them: keys made and
//! revoked with the session (`/api/v1/me/api-keys`), and the connector API with a key
//! (`/api/public/v1/connectors`) that refuses a revoked or unknown key with 401, a tool beyond the
//! key's scopes with 403, an expired connector's tools with 409, and answers 429 with Retry-After
//! when told to. Its answers carry the limits it is given (`X-RateLimit-*`).

use std::collections::{BTreeMap, VecDeque};

use serde_json::{Value, json};

use super::routes::{Answer, error};
use super::{Seen, State};

/// One key the fake made.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FakeKey {
    pub id: String,
    pub name: String,
    pub secret: String,
    pub scopes: Vec<String>,
    pub revoked: bool,
}

/// One connector and its tools: `{ name, description, risk, input_schema }` each.
#[derive(Debug, Clone, PartialEq)]
pub struct FakeConnector {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub display_name: Option<String>,
    pub expired: bool,
    pub tools: Vec<Value>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct FakeConnectors {
    pub keys: Vec<FakeKey>,
    pub connectors: Vec<FakeConnector>,
    /// What a call answers, by `connector/tool`: `ok`, `content` and the rest of the call's
    /// answer. A tool without one answers `ok: true` with `{}`.
    pub answers: BTreeMap<String, Value>,
    /// Answers a tool gives once each, in order, before `answers`, by `connector/tool`: one per page.
    pub queued: BTreeMap<String, VecDeque<Value>>,
    /// Headers every connector answer carries (`x-ratelimit-remaining` …).
    pub headers: BTreeMap<String, String>,
    /// The next connector API answer is 429 with this Retry-After.
    pub limited: Option<u64>,
    /// The next connector API answer is this status, as when an answer is lost on the way.
    pub failing: Option<u16>,
    /// The next this many connector API answers are 503, as when every answer is lost.
    pub lost: u32,
    /// The files uploaded for publishing, in order.
    pub uploads: Vec<super::media::FakeUpload>,
}

impl FakeConnectors {
    /// Add a connector of `kind` with tools of the tiers `risks` (`read`, `send`, `destructive`),
    /// named as the social tools are (`<kind>__social_read` …); its id.
    pub fn add(&mut self, kind: &str, display_name: &str, risks: &[&str]) -> String {
        let id = format!("conn_{}", self.connectors.len() + 1);
        let tools = risks
            .iter()
            .map(|risk| {
                let tail = match *risk {
                    "send" => "publish",
                    "destructive" => "delete",
                    other => other,
                };
                json!({
                    "name": format!("{kind}__social_{tail}"),
                    "description": format!("{tail} on {kind}"),
                    "risk": risk,
                    "input_schema": { "type": "object" },
                })
            })
            .collect();
        self.connectors.push(FakeConnector {
            id: id.clone(),
            kind: kind.to_owned(),
            name: kind.to_owned(),
            display_name: Some(display_name.to_owned()),
            expired: false,
            tools,
        });
        id
    }

    /// The keys not revoked.
    pub fn live_keys(&self) -> Vec<&FakeKey> {
        self.keys.iter().filter(|k| !k.revoked).collect()
    }
}

fn created(body: Value) -> Answer {
    (201, Some(json!({ "success": true, "data": body })))
}

fn success(body: Value) -> Answer {
    (200, Some(json!({ "success": true, "data": body })))
}

/// The key routes, behind the session (the caller checked the token).
pub(super) fn keys(state: &mut State, seen: &Seen, parts: &[&str]) -> Option<Answer> {
    let answer = match (seen.method.as_str(), parts) {
        ("POST", ["api", "v1", "me", "api-keys"]) => create(state, &seen.body),
        ("DELETE", ["api", "v1", "me", "api-keys", id]) => revoke(state, id),
        _ => return None,
    };
    Some(answer)
}

fn create(state: &mut State, body: &Value) -> Answer {
    let name = body["name"].as_str().unwrap_or_default().trim();
    if name.is_empty() || name.chars().count() > 80 {
        return error(400, "VALIDATION_ERROR", "name is 1 to 80 characters");
    }
    let known = [
        "connectors:read",
        "connectors:write",
        "connectors:send",
        "connectors:delete",
    ];
    let scopes: Vec<String> = body["scopes"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    if scopes.is_empty() || scopes.iter().any(|s| !known.contains(&s.as_str())) {
        return error(400, "VALIDATION_ERROR", "unknown scope");
    }
    let n = state.connectors.keys.len() + 1;
    let key = FakeKey {
        id: format!("key_{n}"),
        name: name.to_owned(),
        secret: format!("sk_fake_{n}_{:08x}", n * 2_654_435_761 % 4_294_967_291),
        scopes,
        revoked: false,
    };
    let at = state.tick();
    let answer = json!({
        "id": key.id, "name": key.name, "key_prefix": &key.secret[..8], "agent_id": null,
        "scopes": key.scopes, "scopes_explicit": true, "last_used_at": null,
        "expires_at": null, "created_at": at, "secret": key.secret,
    });
    state.connectors.keys.push(key);
    created(answer)
}

fn revoke(state: &mut State, id: &str) -> Answer {
    match state
        .connectors
        .keys
        .iter_mut()
        .find(|k| k.id == id && !k.revoked)
    {
        Some(key) => {
            key.revoked = true;
            (204, None)
        }
        None => error(404, "NOT_FOUND", "API key not found"),
    }
}

/// The connector API, behind the key: `None` for any other path.
pub(super) fn api(state: &mut State, seen: &Seen) -> Option<Answer> {
    let parts: Vec<&str> = seen.path.trim_start_matches('/').split('/').collect();
    let ["api", "public", "v1", "connectors", rest @ ..] = parts.as_slice() else {
        return None;
    };
    let secret = seen
        .headers
        .get("authorization")
        .and_then(|h| h.strip_prefix("Bearer "));
    let Some(key) = state
        .connectors
        .keys
        .iter()
        .find(|k| !k.revoked && Some(k.secret.as_str()) == secret)
        .cloned()
    else {
        return Some(error(401, "UNAUTHORIZED", "API key required"));
    };
    if let Some(wait) = state.connectors.limited.take() {
        state
            .connectors
            .headers
            .insert("retry-after".to_owned(), wait.to_string());
        return Some(error(429, "RATE_LIMITED", "Too many requests"));
    }
    state.connectors.headers.remove("retry-after");
    if let Some(status) = state.connectors.failing.take() {
        return Some(error(status, "UNAVAILABLE", "Try again"));
    }
    if state.connectors.lost > 0 {
        state.connectors.lost -= 1;
        return Some(error(503, "UNAVAILABLE", "Try again"));
    }
    let may = |risk: &str| {
        let scope = match risk {
            "destructive" => "connectors:delete",
            "send" => "connectors:send",
            "write" => "connectors:write",
            _ => "connectors:read",
        };
        key.scopes.iter().any(|s| s == scope)
    };
    let answer = match (seen.method.as_str(), rest) {
        ("GET", []) => {
            let items: Vec<Value> = state
                .connectors
                .connectors
                .iter()
                .map(|c| {
                    json!({
                        "connector_id": c.id, "type": c.kind, "name": c.name,
                        "display_name": c.display_name,
                        "status": if c.expired { "expired" } else { "active" },
                        "tool_count": c.tools.len(),
                    })
                })
                .collect();
            success(json!({ "items": items, "total": items.len() }))
        }
        ("GET", [id, "tools"]) => match connector(state, id) {
            Some(c) => {
                let items: Vec<Value> = c
                    .tools
                    .iter()
                    .map(|t| {
                        let mut t = t.clone();
                        t["callable"] = json!(may(t["risk"].as_str().unwrap_or_default()));
                        t
                    })
                    .collect();
                success(json!({ "items": items, "total": items.len() }))
            }
            None => error(404, "CONNECTOR_NOT_FOUND", "Connector not found"),
        },
        ("POST", [id, "tools", tool, "call"]) => call(state, seen, id, tool, &may),
        ("POST", ["media"]) if may("send") => super::media::upload(state, seen),
        ("POST", ["media"]) => error(403, "FORBIDDEN", "This key may not upload media"),
        _ => error(404, "NOT_FOUND", "No such route"),
    };
    Some(answer)
}

fn connector<'a>(state: &'a State, id: &str) -> Option<&'a FakeConnector> {
    state.connectors.connectors.iter().find(|c| c.id == id)
}

fn call(
    state: &mut State,
    seen: &Seen,
    id: &str,
    tool: &str,
    may: &dyn Fn(&str) -> bool,
) -> Answer {
    let Some(c) = connector(state, id) else {
        return error(404, "CONNECTOR_NOT_FOUND", "Connector not found");
    };
    let Some(spec) = c.tools.iter().find(|t| t["name"] == tool) else {
        return error(404, "CONNECTOR_TOOL_NOT_FOUND", "Tool not found");
    };
    let risk = spec["risk"].as_str().unwrap_or_default().to_owned();
    let expired = c.expired;
    if !may(&risk) {
        return error(
            403,
            "CONNECTOR_TOOL_NOT_ALLOWED",
            "This key may not call this tool",
        );
    }
    if expired {
        return error(
            409,
            "CONNECTOR_NOT_ACTIVE",
            "Reconnect this connector on endue",
        );
    }
    if !seen.body["arguments"].is_object() {
        return error(400, "VALIDATION_ERROR", "arguments must be an object");
    }
    let key = format!("{id}/{tool}");
    let queued = state
        .connectors
        .queued
        .get_mut(&key)
        .and_then(VecDeque::pop_front);
    let mut answer = super::media::unknown_media(state, &seen.body["arguments"])
        .or(queued)
        .or_else(|| state.connectors.answers.get(&key).cloned())
        .unwrap_or_else(|| json!({ "ok": true, "content": "{}", "data": {} }));
    answer["tool"] = json!(tool);
    answer["risk"] = json!(risk);
    if answer.get("truncated").is_none() {
        answer["truncated"] = json!(false);
    }
    success(answer)
}
