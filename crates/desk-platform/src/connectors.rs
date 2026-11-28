//! The desk's own key and the account's connectors (ADR 0407). The key is made and revoked with the
//! session; every connector call carries the key and never the session, so a key that leaks gives
//! the connectors it was allowed and nothing else of the account.

use std::collections::BTreeMap;
use std::fmt;
use std::time::Duration;

use desk_sys::net::{MAX_BODY_BYTES, Method, Request, Response};
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

use crate::Platform;
use crate::error::{DEFAULT_WAIT_SECS, ErrorKind, PlatformError, Result};
use crate::http::encode;
use crate::wire_connectors::{
    ConnectorSummary, ConnectorTool, Items, KeyCreated, KeyScope, MediaUploaded, NewKey,
    ToolArguments, ToolCall,
};

/// What people read when endue AI no longer accepts the desk's key.
pub const KEY_REFUSED: &str = "endue AI no longer accepts this desk's key.";

/// The connector API's own limits (`X-RateLimit-*`): the tightest of the key's cells.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RateLimit {
    pub limit: Option<u64>,
    pub remaining: Option<u64>,
    /// Seconds until the window resets.
    pub reset: Option<u64>,
}

impl RateLimit {
    fn of(headers: &BTreeMap<String, String>) -> Self {
        let number = |name: &str| headers.get(name).and_then(|v| v.trim().parse().ok());
        Self {
            limit: number("x-ratelimit-limit"),
            remaining: number("x-ratelimit-remaining"),
            reset: number("x-ratelimit-reset"),
        }
    }

    /// How long to wait before the next call when none are left in the window.
    pub fn wait(&self) -> Option<u64> {
        (self.remaining == Some(0)).then(|| self.reset.unwrap_or(DEFAULT_WAIT_SECS))
    }
}

/// One answer of the connector API and the limits it came with.
#[derive(Debug, Clone, PartialEq)]
pub struct Answer<T> {
    pub value: T,
    pub limit: RateLimit,
}

impl Platform {
    /// Make a key for the desk with the session: `name` for people and what it may do. Its secret
    /// is in the answer this once.
    pub fn create_key(&self, name: &str, scopes: &[KeyScope]) -> Result<KeyCreated> {
        let body = serde_json::to_value(NewKey {
            name: name.to_owned(),
            scopes: scopes.to_vec(),
        })
        .map_err(|e| PlatformError::unexpected("key request", e))?;
        self.read(Method::Post, "/api/v1/me/api-keys", Some(&body), "key")
    }

    /// Revoke the key `id` with the session. One endue AI no longer has (404) counts as revoked.
    pub fn revoke_key(&self, id: &str) -> Result<()> {
        let path = format!("/api/v1/me/api-keys/{}", encode(id));
        match self.send(Method::Delete, &path, None) {
            Err(e) if e.kind == ErrorKind::NotFound => Ok(()),
            other => other,
        }
    }

    /// The account's connectors through the key `secret`, at this platform.
    pub fn with_key(&self, secret: &str) -> Connectors {
        Connectors {
            base: self.base.clone(),
            host: self.host.clone(),
            secret: secret.to_owned(),
            timeout: self.timeout,
        }
    }
}

/// The connector API with the desk's key. Its `Debug` leaves the key out.
pub struct Connectors {
    base: String,
    host: String,
    secret: String,
    timeout: Duration,
}

impl fmt::Debug for Connectors {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Connectors")
            .field("base", &self.base)
            .finish_non_exhaustive()
    }
}

impl Connectors {
    /// The account's connectors the key sees.
    pub fn list(&self) -> Result<Answer<Vec<ConnectorSummary>>> {
        let answer: Answer<Items<ConnectorSummary>> = self.read(
            Method::Get,
            "/api/public/v1/connectors",
            None,
            None,
            "connectors",
        )?;
        Ok(Answer {
            value: answer.value.items,
            limit: answer.limit,
        })
    }

    /// The tools of the connector `id`, with whether this key may call each.
    pub fn tools(&self, id: &str) -> Result<Answer<Vec<ConnectorTool>>> {
        let path = format!("/api/public/v1/connectors/{}/tools", encode(id));
        let answer: Answer<Items<ConnectorTool>> =
            self.read(Method::Get, &path, None, None, "connector tools")?;
        Ok(Answer {
            value: answer.value.items,
            limit: answer.limit,
        })
    }

    /// Call `tool` of the connector `id` with `arguments`. `idempotency_key` is one per invocation
    /// and the same on a retry, so a retried publish posts once.
    pub fn call(
        &self,
        id: &str,
        tool: &str,
        arguments: Map<String, Value>,
        idempotency_key: &str,
    ) -> Result<Answer<ToolCall>> {
        let path = format!(
            "/api/public/v1/connectors/{}/tools/{}/call",
            encode(id),
            encode(tool)
        );
        let body = serde_json::to_value(ToolArguments { arguments })
            .map_err(|e| PlatformError::unexpected("tool arguments", e))?;
        self.read(
            Method::Post,
            &path,
            Some(&body),
            Some(idempotency_key),
            "tool answer",
        )
    }

    /// Upload a file's bytes of `content_type` for a publish: endue AI keeps them a day and answers
    /// the `media_id` a tool's `media` takes. The bytes go as they are, with their length. An upload
    /// is not idempotent, so a lost answer is not tried again here.
    pub fn upload_media(
        &self,
        bytes: Vec<u8>,
        content_type: &str,
    ) -> Result<Answer<MediaUploaded>> {
        let mut request = self.request(Method::Post, "/api/public/v1/connectors/media", None);
        request
            .headers
            .insert("content-type".to_owned(), content_type.to_owned());
        // A video takes longer than a call: a minute at least.
        request.timeout = Some(self.timeout.max(Duration::from_secs(60)));
        request.body = Some(bytes);
        self.answer(request, "media upload")
    }

    fn request(&self, method: Method, path: &str, body: Option<&Value>) -> Request {
        Platform::request_to(
            &self.base,
            &self.host,
            method,
            path,
            body,
            self.timeout,
            "application/json",
        )
    }

    fn read<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        idempotency_key: Option<&str>,
        what: &str,
    ) -> Result<Answer<T>> {
        let mut request = self.request(method, path, body);
        if let Some(key) = idempotency_key {
            request
                .headers
                .insert("idempotency-key".to_owned(), key.to_owned());
        }
        self.answer(request, what)
    }

    fn answer<T: DeserializeOwned>(&self, mut request: Request, what: &str) -> Result<Answer<T>> {
        let reply = Platform::once(&mut request, &self.secret, MAX_BODY_BYTES)?;
        let limit = RateLimit::of(&reply.headers);
        if !(200..300).contains(&reply.status) {
            return Err(refused(&reply));
        }
        let value =
            serde_json::from_slice(&reply.body).map_err(|e| PlatformError::unexpected(what, e))?;
        let value = serde_json::from_value(crate::http::unwrap(value)?)
            .map_err(|e| PlatformError::unexpected(what, e))?;
        Ok(Answer { value, limit })
    }
}

/// A refusal of the key: a 401 means the key is gone (the desk forgets it), a 429 names its wait.
fn refused(reply: &Response) -> PlatformError {
    let mut error = PlatformError::from_response(reply.status, &reply.body);
    match reply.status {
        401 => error.message = KEY_REFUSED.to_owned(),
        429 => {
            let wait_secs = reply
                .headers
                .get("retry-after")
                .and_then(|v| v.trim().parse().ok())
                .or_else(|| RateLimit::of(&reply.headers).reset)
                .unwrap_or(DEFAULT_WAIT_SECS);
            error.kind = ErrorKind::RateLimited { wait_secs };
        }
        _ => {}
    }
    error
}
