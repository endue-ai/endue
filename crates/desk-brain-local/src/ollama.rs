//! Ollama's `/api/chat`: the messages of a conversation, one streamed request, and its answer read
//! into text, tool calls and a stop reason.

use std::io;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use desk_brain::{BrainError, BrainErrorCode, BrainFailure, StopReason};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::http::{Endpoint, get, post};
use crate::model::{Answer, Call, Model, Piece};

/// The model name that asks for any model the server holds (`brain.model` unset).
pub const ANY_MODEL: &str = "any";
/// How long the server's model list is kept.
const LIST_KEPT: Duration = Duration::from_secs(60);

/// Ollama at `endpoint`, running `model`, or the first chat model it holds for `ANY_MODEL`.
pub struct Ollama {
    pub endpoint: Endpoint,
    pub model: String,
    listed: Mutex<Option<(Instant, Vec<String>)>>,
}

impl Ollama {
    pub fn new(endpoint: Endpoint, model: String) -> Self {
        Self {
            endpoint,
            model,
            listed: Mutex::new(None),
        }
    }

    /// The model that answers: the one named, or for `ANY_MODEL` the first chat model the server
    /// holds. A server without one cannot answer (`Unreachable`), so the turn goes on to the next
    /// brain instead of asking for a model that is not there.
    fn resolve(&self) -> Result<String, BrainFailure> {
        if self.model != ANY_MODEL {
            return Ok(self.model.clone());
        }
        let mut listed = self.listed.lock().unwrap_or_else(|p| p.into_inner());
        let names = match listed.as_ref().filter(|(at, _)| at.elapsed() < LIST_KEPT) {
            Some((_, names)) => names.clone(),
            None => {
                let names = models(&self.endpoint)?;
                *listed = Some((Instant::now(), names.clone()));
                names
            }
        };
        pick(&self.model, &names).ok_or_else(|| {
            BrainFailure::Unreachable(
                "Ollama holds no model that can chat; pull one with ollama pull".to_owned(),
            )
        })
    }
}

impl Model for Ollama {
    fn chat(
        &self,
        tools: &[Value],
        messages: &[Value],
        on: &mut dyn FnMut(Piece<'_>),
    ) -> Result<Answer, BrainFailure> {
        let model = self.resolve()?;
        chat(&self.endpoint, &model, tools, messages, on)
    }

    fn reachable(&self) -> Result<(), BrainFailure> {
        version(&self.endpoint)?;
        self.resolve().map(drop)
    }

    fn address(&self) -> String {
        self.endpoint.url()
    }
}

/// A 404 for the model is a model the server does not hold: the server cannot answer it, which is
/// not a session the brain lost (the conversation would start a new one and try again).
fn missing_model(status: u16, text: &str, model: &str) -> Option<BrainFailure> {
    (status == 404 && text.contains("not found")).then(|| {
        BrainFailure::Unreachable(format!(
            "Ollama does not hold {model}; pull it with ollama pull {model}"
        ))
    })
}

/// The model of `names` that answers for `wanted`: itself (with or without `:latest`), or for
/// `ANY_MODEL` the first that is not only for embeddings.
pub fn pick(wanted: &str, names: &[String]) -> Option<String> {
    if wanted == ANY_MODEL {
        return names
            .iter()
            .find(|name| !name.to_ascii_lowercase().contains("embed"))
            .cloned();
    }
    names
        .iter()
        .find(|name| *name == wanted || name.strip_suffix(":latest") == Some(wanted))
        .cloned()
}

/// The models the server holds (`/api/tags`), in its order.
pub fn models(endpoint: &Endpoint) -> Result<Vec<String>, BrainFailure> {
    let response = get(endpoint, "/api/tags").map_err(unreachable)?;
    let status = response.status;
    let text = response.text().map_err(unreachable)?;
    if status >= 300 {
        return Err(refused(status, error_message(status, &text)));
    }
    let listed: Value = serde_json::from_str(&text)
        .map_err(|e| BrainFailure::Protocol(format!("Ollama's model list: {e}")))?;
    Ok(listed["models"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| m["name"].as_str().or(m["model"].as_str()))
        .map(str::to_owned)
        .collect())
}

/// Send the conversation and read the streamed answer. Nothing reaches `on` before Ollama has
/// accepted the request, so a refusal or an unreachable server leaves no trace in the turn.
pub fn chat(
    endpoint: &Endpoint,
    model: &str,
    tools: &[Value],
    messages: &[Value],
    on: &mut dyn FnMut(Piece<'_>),
) -> Result<Answer, BrainFailure> {
    let mut body = json!({ "model": model, "messages": messages, "stream": true });
    if !tools.is_empty() {
        body["tools"] = Value::from(tools.to_vec());
    }
    let response = post(endpoint, "/api/chat", &body).map_err(unreachable)?;
    if response.status >= 300 {
        let status = response.status;
        let text = response.text().map_err(unreachable)?;
        if let Some(missing) = missing_model(status, &text, model) {
            return Err(missing);
        }
        return Err(refused(status, error_message(status, &text)));
    }
    on(Piece::Opened);
    let mut answer = Answer {
        text: String::new(),
        calls: Vec::new(),
        stop: StopReason::EndTurn,
    };
    for line in response.lines() {
        let line = line.map_err(unreachable)?;
        let chunk: Chunk = serde_json::from_str(&line)
            .map_err(|e| BrainFailure::Protocol(format!("{e} in Ollama's line {line}")))?;
        if let Some(error) = chunk.error {
            return Err(refused(500, error));
        }
        if let Some(message) = chunk.message {
            let text = message.content.unwrap_or_default();
            if !text.is_empty() {
                on(Piece::Text(&text));
                answer.text.push_str(&text);
            }
            for call in message.tool_calls.unwrap_or_default() {
                answer.calls.push(call.into_call()?);
            }
        }
        if chunk.done {
            answer.stop = if !answer.calls.is_empty() {
                StopReason::ToolCall
            } else if chunk.done_reason.as_deref() == Some("length") {
                StopReason::MaxTokens
            } else {
                StopReason::EndTurn
            };
            return Ok(answer);
        }
    }
    Err(BrainFailure::Unreachable(
        "Ollama's stream ended before the answer did".to_owned(),
    ))
}

/// Whether Ollama answers at all: its `/api/version`, without loading a model.
pub fn version(endpoint: &Endpoint) -> Result<(), BrainFailure> {
    let response = get(endpoint, "/api/version").map_err(unreachable)?;
    if response.status >= 300 {
        let status = response.status;
        let text = response.text().map_err(unreachable)?;
        return Err(refused(status, error_message(status, &text)));
    }
    Ok(())
}

/// A user message: the parts of what the person typed, joined.
pub fn user(text: &str) -> Value {
    json!({ "role": "user", "content": text })
}

/// The model's answer as it goes back into the conversation.
pub fn assistant(text: &str, calls: &[Call]) -> Value {
    let mut message = json!({ "role": "assistant", "content": text });
    if !calls.is_empty() {
        let calls: Vec<Value> = calls
            .iter()
            .map(|c| json!({ "function": { "name": c.name, "arguments": c.arguments } }))
            .collect();
        message["tool_calls"] = Value::from(calls);
    }
    message
}

/// A tool's result for the model: text stays text, anything else is sent as JSON.
pub fn tool(name: &str, output: &Value, failed: bool) -> Value {
    let text = match output {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    };
    let content = if failed {
        format!("The tool failed: {text}")
    } else {
        text
    };
    json!({ "role": "tool", "tool_name": name, "content": content })
}

/// One line of Ollama's stream. Fields this adapter does not use are ignored.
#[derive(Deserialize)]
struct Chunk {
    #[serde(default)]
    message: Option<ChunkMessage>,
    #[serde(default)]
    done: bool,
    #[serde(default)]
    done_reason: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Deserialize)]
struct ChunkMessage {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tool_calls: Option<Vec<WireCall>>,
}

#[derive(Deserialize)]
struct WireCall {
    function: WireFunction,
}

#[derive(Deserialize)]
struct WireFunction {
    name: String,
    #[serde(default)]
    arguments: Value,
}

impl WireCall {
    fn into_call(self) -> Result<Call, BrainFailure> {
        let WireFunction { name, arguments } = self.function;
        if name.is_empty() {
            return Err(BrainFailure::Protocol(
                "Ollama asked for a tool without a name".to_owned(),
            ));
        }
        // Ollama sends an object; some models put the object in a string.
        let arguments = match arguments {
            Value::Null => Map::new(),
            Value::Object(map) => map,
            Value::String(text) => match serde_json::from_str(&text) {
                Ok(Value::Object(map)) => map,
                _ => return Err(bad_arguments(&name, &Value::String(text))),
            },
            other => return Err(bad_arguments(&name, &other)),
        };
        Ok(Call { name, arguments })
    }
}

fn bad_arguments(name: &str, arguments: &Value) -> BrainFailure {
    BrainFailure::Protocol(format!(
        "Ollama called {name} with arguments that are not an object: {arguments}"
    ))
}

/// Ollama's `{"error": "..."}`, or the body itself when it is not that.
fn error_message(status: u16, body: &str) -> String {
    let error = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v.get("error").and_then(Value::as_str).map(str::to_owned));
    match error {
        Some(error) => error,
        None if body.trim().is_empty() => format!("Ollama answered {status}"),
        None => body.trim().to_owned(),
    }
}

fn refused(status: u16, message: String) -> BrainFailure {
    let code = match status {
        400 => BrainErrorCode::InvalidRequest,
        401 | 403 => BrainErrorCode::Unauthorized,
        404 => BrainErrorCode::NotFound,
        429 => BrainErrorCode::RateLimited,
        _ => BrainErrorCode::Internal,
    };
    BrainFailure::Refused {
        status,
        error: BrainError {
            code,
            message,
            holder: None,
        },
    }
}

fn unreachable(error: io::Error) -> BrainFailure {
    BrainFailure::Unreachable(format!("Ollama: {error}"))
}

#[cfg(test)]
mod tests {
    #[test]
    fn any_model_is_the_first_chat_model_the_server_holds() {
        let names = ["qwen3-embedding:8b".to_owned(), "qwen3:27b".to_owned()];
        assert_eq!(
            super::pick(super::ANY_MODEL, &names).as_deref(),
            Some("qwen3:27b")
        );
        assert_eq!(
            super::pick(super::ANY_MODEL, &names[..1]),
            None,
            "embeddings only"
        );
        let latest = ["llama3.2:latest".to_owned()];
        assert_eq!(
            super::pick("llama3.2", &latest).as_deref(),
            Some("llama3.2:latest")
        );
    }

    #[test]
    fn a_model_the_server_does_not_hold_is_not_a_lost_session() {
        let text = r#"{"error":"model \"llama3.2\" not found, try pulling it first"}"#;
        assert!(matches!(
            super::missing_model(404, text, "llama3.2"),
            Some(desk_brain::BrainFailure::Unreachable(_))
        ));
        assert!(super::missing_model(404, "{\"error\":\"session\"}", "x").is_none());
    }

    use super::*;

    #[test]
    fn arguments_may_arrive_as_a_string() {
        let call: WireCall = serde_json::from_value(
            json!({ "function": { "name": "f", "arguments": "{\"a\":1}" } }),
        )
        .unwrap();
        assert_eq!(call.into_call().unwrap().arguments["a"], 1);
        let call: WireCall =
            serde_json::from_value(json!({ "function": { "name": "f", "arguments": [1] } }))
                .unwrap();
        assert!(matches!(call.into_call(), Err(BrainFailure::Protocol(_))));
    }

    #[test]
    fn error_bodies_keep_their_message() {
        assert_eq!(error_message(404, r#"{"error":"no model"}"#), "no model");
        assert_eq!(error_message(502, " bad gateway "), "bad gateway");
        assert_eq!(error_message(500, ""), "Ollama answered 500");
    }
}
