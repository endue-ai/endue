//! The endue connector binding without the core (specs/connector/v0 `EndueBinding`, ADR 0408): one
//! sync's tool calls and their pages, every record mapped into an item by the http binding's maps,
//! and an action's arguments built from its command's. The core hands in the call (the desk's own key,
//! ADR 0407); nothing here holds the key, and no network's name, field or limit is in it.

use std::collections::BTreeMap;

use desk_bridge::{
    EndueAction, EndueActionArgument, EndueBinding, EndueRequest, EndueRequestArgument, Item,
    ItemSource,
};
use desk_platform::Answer;
use desk_platform::wire_connectors::{Refusal, ToolCall};
use serde_json::{Map, Value};

use crate::http_binding::{Failure, item_of};

/// Pages a request reads when it names no maxPages, and the most it may name.
const PAGES: u64 = 10;
const MAX_PAGES: u64 = 50;
/// Calls one sync makes when the block names no budget.
pub(crate) const BUDGET: u64 = 30;

/// Why a call made nothing to map: wait this many seconds (a 429), or a failure for the person.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Fault {
    Wait(u64),
    Failed(Failure),
}

/// One tool call: its full name and arguments.
pub(crate) type Call<'a> =
    dyn FnMut(&str, Map<String, Value>) -> Result<Answer<ToolCall>, Fault> + 'a;

/// What a sync read: items by id, records that made no valid item, whether every page of every
/// request was read, and how long the limit asks to wait before the next sync.
#[derive(Debug, Default)]
pub(crate) struct Read {
    pub(crate) items: BTreeMap<String, Item>,
    pub(crate) skipped: u64,
    pub(crate) complete: bool,
    pub(crate) wait: Option<u64>,
}

/// Run every request of `binding` through `call`, with `tools` the instance's full tool name by
/// ending and `since` the time of its last good sync.
pub(crate) fn sync(
    binding: &EndueBinding,
    tools: &BTreeMap<String, String>,
    since: Option<&str>,
    source: &ItemSource,
    call: &mut Call<'_>,
) -> Result<Read, Failure> {
    let budget = binding.budget.unwrap_or(BUDGET);
    let mut read = Read::default();
    let mut spent = 0;
    for (r, request) in binding.requests.iter().enumerate() {
        let last = r + 1 == binding.requests.len();
        let tool = tools.get(&request.tool).ok_or_else(|| {
            Failure::new(format!(
                "This connector has no tool ending {}",
                request.tool
            ))
        })?;
        let map = binding
            .maps
            .get(&request.map)
            .ok_or_else(|| Failure::new(format!("the endue block has no map {}", request.map)))?;
        let mut cursor: Option<String> = None;
        for _ in 0..request.max_pages.unwrap_or(PAGES).clamp(1, MAX_PAGES) {
            if spent == budget {
                return Ok(read);
            }
            spent += 1;
            let answer = match call(tool, arguments(request, cursor.as_deref(), since)) {
                Ok(answer) => answer,
                Err(Fault::Wait(wait)) => {
                    read.wait = Some(wait);
                    return Ok(read);
                }
                Err(Fault::Failed(failure)) => return Err(failure),
            };
            let answered = answer.value;
            if !answered.ok {
                let unsupported =
                    answered.error.as_ref().map(|e| e.reason) == Some(Refusal::Unsupported);
                if request.optional == Some(true) && unsupported {
                    break;
                }
                return Err(Failure::new(words(&answered)));
            }
            if answered.truncated {
                let why =
                    format!("{tool} answered only part of what it read, so nothing was written");
                return Err(Failure::new(why));
            }
            let data = answered.data.unwrap_or(Value::Null);
            let records = pointer(&data, &request.items).and_then(Value::as_array);
            let records = records.ok_or_else(|| {
                Failure::new(format!(
                    "{tool} answered without a list at {:?}",
                    request.items
                ))
            })?;
            for record in records {
                match item_of(map, record, source) {
                    Some((id, item)) => {
                        read.items.insert(id, item);
                    }
                    None => read.skipped += 1,
                }
            }
            cursor = request
                .next
                .as_deref()
                .and_then(|at| pointer(&data, at))
                .and_then(Value::as_str)
                .filter(|next| !next.is_empty())
                .map(str::to_owned);
            if let Some(wait) = answer.limit.wait() {
                read.wait = Some(wait);
                read.complete = cursor.is_none() && last;
                return Ok(read);
            }
            if cursor.is_none() {
                break;
            }
        }
    }
    read.complete = true;
    Ok(read)
}

/// Whether a request only adds and changes: it reads since the last good sync.
pub(crate) fn reads_since(binding: &EndueBinding) -> bool {
    let arguments = binding
        .requests
        .iter()
        .flat_map(|r| r.arguments.iter().flatten());
    arguments
        .into_iter()
        .any(|(_, a)| matches!(a, EndueRequestArgument::EndueSince(_)))
}

/// A request's arguments: constants, the page cursor and the last sync's time when there are some.
fn arguments(
    request: &EndueRequest,
    cursor: Option<&str>,
    since: Option<&str>,
) -> Map<String, Value> {
    let mut built = Map::new();
    for (name, argument) in request.arguments.iter().flatten() {
        let value = match argument {
            EndueRequestArgument::HttpConst(constant) => Some(constant.r#const.clone()),
            EndueRequestArgument::EnduePage(_) => cursor.map(|c| Value::String(c.to_owned())),
            EndueRequestArgument::EndueSince(_) => since.map(|s| Value::String(s.to_owned())),
        };
        if let Some(value) = value {
            built.insert(name.clone(), value);
        }
    }
    built
}

/// An action's arguments from its command's `args`; an argument the command left out is left out.
/// A file cannot go yet: endue AI's connector API takes no upload.
pub(crate) fn action_arguments(
    action: &EndueAction,
    args: Option<&Map<String, Value>>,
) -> Result<Map<String, Value>, String> {
    let mut built = Map::new();
    for (name, argument) in action.arguments.iter().flatten() {
        let value = match argument {
            EndueActionArgument::HttpConst(constant) => Some(constant.r#const.clone()),
            EndueActionArgument::EndueArg(from) => args.and_then(|a| a.get(&from.arg)).cloned(),
            EndueActionArgument::EndueFile(from) => match args.and_then(|a| a.get(&from.file)) {
                Some(_) => {
                    return Err(
                        "Files cannot be sent through the endue account's connectors yet.".into(),
                    );
                }
                None => None,
            },
        };
        if let Some(value) = value {
            built.insert(name.clone(), value);
        }
    }
    Ok(built)
}

/// What a refusing tool said: its content, else its error's message, else that it refused.
pub(crate) fn words(answered: &ToolCall) -> String {
    let content = answered.content.trim();
    if !content.is_empty() {
        return content.to_owned();
    }
    match &answered.error {
        Some(error) if !error.message.trim().is_empty() => error.message.trim().to_owned(),
        _ => format!("{} refused", answered.tool),
    }
}

fn pointer<'a>(value: &'a Value, at: &str) -> Option<&'a Value> {
    if at.is_empty() {
        return Some(value);
    }
    value.pointer(at)
}
