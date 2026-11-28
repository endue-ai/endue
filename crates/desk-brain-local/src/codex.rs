//! The person's own Codex CLI as a `LocalBrain`'s model, the same recipe ADR 0109 gives Claude
//! Code. Every answer is one run of `codex exec` in the brain's folder: a read-only sandbox, no git
//! repository asked for, no colour. The desk's tools go in the prompt, the answer comes back through
//! `--output-schema` into the file `--output-last-message` names, and the conversation goes on
//! stdin. It signs in with the person's own account, as their terminal does: Desk holds no key.

use std::ffi::OsString;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use desk_brain::{BrainErrorCode, BrainFailure, StopReason};
use serde_json::{Value, json};

use crate::claude::{Output, Program, find_program, first_line, refused, run_program};
use crate::claude_prompt;
use crate::model::{Answer, Model, Piece};

/// How long one answer may take before the run is stopped.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(180);
/// How long a reachability answer is kept, so brain.status does not start a program every time.
const REACH_KEPT: Duration = Duration::from_secs(30);
/// The file the answer is written to, in the brain's folder.
const LAST: &str = "codex-answer.txt";
/// The answer's schema, in the brain's folder.
const SCHEMA: &str = "codex-schema.json";

/// Which Codex to run, and with which model.
#[derive(Debug, Clone, PartialEq)]
pub struct CodexOptions {
    /// The `codex` program (`find_codex` finds it).
    pub program: PathBuf,
    /// `--model`; `None` keeps Codex's own.
    pub model: Option<String>,
    pub timeout: Duration,
}

impl CodexOptions {
    pub fn new(program: impl Into<PathBuf>) -> Self {
        Self {
            program: program.into(),
            model: None,
            timeout: DEFAULT_TIMEOUT,
        }
    }

    pub fn with_model(mut self, model: impl Into<String>) -> Self {
        let model = model.into();
        self.model = (!model.trim().is_empty()).then(|| model.trim().to_owned());
        self
    }
}

/// The `codex` program: the first on `path`, else where its installers put it.
pub fn find_codex(path: Option<OsString>, home: Option<PathBuf>) -> Option<PathBuf> {
    let names: &[&str] = if cfg!(windows) {
        &["codex.exe", "codex.cmd"]
    } else {
        &["codex"]
    };
    find_program(names, path, home)
}

pub(crate) struct Codex {
    options: CodexOptions,
    folder: PathBuf,
    reached: Mutex<Option<(Instant, bool)>>,
}

impl Codex {
    pub(crate) fn new(options: CodexOptions, folder: PathBuf) -> Self {
        Self {
            options,
            folder,
            reached: Mutex::new(None),
        }
    }

    fn program(&self, timeout: Duration) -> Program<'_> {
        Program {
            path: &self.options.program,
            name: "Codex",
            timeout,
        }
    }
}

impl Model for Codex {
    fn chat(
        &self,
        tools: &[Value],
        messages: &[Value],
        on: &mut dyn FnMut(Piece<'_>),
    ) -> Result<Answer, BrainFailure> {
        let required = messages.first().is_some_and(|m| m["role"] == "system");
        let schema = schema(tools, required);
        let last = self.folder.join(LAST);
        let _ = fs::remove_file(&last);
        if let Some(schema) = &schema {
            fs::write(self.folder.join(SCHEMA), schema).map_err(|e| {
                BrainFailure::Protocol(format!("the schema cannot be written: {e}"))
            })?;
        }
        let args = arguments(&self.options, schema.is_some());
        let prompt = prompt(tools, messages);
        let output = run_program(
            &self.program(self.options.timeout),
            &args,
            &prompt,
            &self.folder,
        )?;
        let written = fs::read_to_string(&last).unwrap_or_default();
        let answer = read(&output, &written, schema.is_none())?;
        on(Piece::Opened);
        if answer.calls.is_empty() && !answer.text.is_empty() {
            on(Piece::Text(&answer.text));
        }
        Ok(answer)
    }

    fn reachable(&self) -> Result<(), BrainFailure> {
        let mut reached = self.reached.lock().unwrap_or_else(|p| p.into_inner());
        let ok = match reached.filter(|(at, _)| at.elapsed() < REACH_KEPT) {
            Some((_, ok)) => ok,
            None => {
                let quick = self.program(Duration::from_secs(15));
                let ok = run_program(&quick, &["--version".to_owned()], "", &self.folder)
                    .is_ok_and(|output| output.success);
                *reached = Some((Instant::now(), ok));
                ok
            }
        };
        if ok {
            Ok(())
        } else {
            let program = self.options.program.display();
            Err(BrainFailure::Unreachable(format!(
                "Codex does not run at {program}"
            )))
        }
    }

    fn address(&self) -> String {
        self.options.program.display().to_string()
    }
}

/// The arguments of one answer: a read-only sandbox, so Codex never acts on its own; the prompt is
/// read from stdin (`-`).
pub(crate) fn arguments(options: &CodexOptions, schema: bool) -> Vec<String> {
    let mut args: Vec<String> = [
        "exec",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--color",
        "never",
        "--output-last-message",
        LAST,
    ]
    .map(str::to_owned)
    .into();
    if schema {
        args.extend(["--output-schema".to_owned(), SCHEMA.to_owned()]);
    }
    if let Some(model) = &options.model {
        args.extend(["--model".to_owned(), model.clone()]);
    }
    args.push("-".to_owned());
    args
}

/// Codex has no system prompt of its own: the instructions come first, then the conversation.
pub(crate) fn prompt(tools: &[Value], messages: &[Value]) -> String {
    let mut text = claude_prompt::system(tools);
    if !tools.is_empty() {
        text.push_str(
            "\n\nAnswer with JSON: `say` is what you tell the person, `calls` the tools to run, \
             each with its `arguments` as one JSON text.",
        );
    }
    text.push_str("\n\nThe conversation:\n");
    text.push_str(&claude_prompt::transcript(messages));
    text
}

/// The answer's schema, in the strict form Codex's structured output takes: every object closed,
/// every property required, and each call's arguments as one JSON text. Without tools, none.
pub(crate) fn schema(tools: &[Value], required: bool) -> Option<String> {
    let names: Vec<&str> = tools
        .iter()
        .filter_map(|t| t["function"]["name"].as_str())
        .collect();
    if names.is_empty() {
        return None;
    }
    let mut calls = json!({
        "type": "array",
        "items": {
            "type": "object",
            "properties": {
                "tool": { "type": "string", "enum": names },
                "arguments": { "type": "string" }
            },
            "required": ["tool", "arguments"],
            "additionalProperties": false
        }
    });
    if required {
        calls["minItems"] = json!(1);
    }
    let schema = json!({
        "type": "object",
        "properties": { "say": { "type": "string" }, "calls": calls },
        "required": ["say", "calls"],
        "additionalProperties": false
    });
    Some(schema.to_string())
}

/// A run's answer: the last message it wrote, as JSON when a schema was asked (`plain` false).
pub(crate) fn read(output: &Output, written: &str, plain: bool) -> Result<Answer, BrainFailure> {
    let written = written.trim();
    if written.is_empty() {
        let said = first_line(&output.stderr)
            .or_else(|| first_line(&output.stdout))
            .unwrap_or("it wrote no answer");
        let lower = said.to_ascii_lowercase();
        if lower.contains("unexpected argument") || lower.contains("unknown option") {
            let why = format!("Codex refused an option ({said}); update it");
            return Err(refused(400, BrainErrorCode::InvalidRequest, why));
        }
        if lower.contains("login") || lower.contains("not logged in") || lower.contains("401") {
            let why = format!("Codex is not signed in; run codex login in a terminal ({said})");
            return Err(refused(401, BrainErrorCode::Internal, why));
        }
        return Err(BrainFailure::Unreachable(format!("Codex stopped: {said}")));
    }
    let (say, calls) = if plain {
        (written.to_owned(), Vec::new())
    } else {
        let structured: Value = serde_json::from_str(written)
            .map_err(|e| BrainFailure::Protocol(format!("Codex's answer is not JSON: {e}")))?;
        claude_prompt::answer(&structured)?
    };
    if say.is_empty() && calls.is_empty() {
        return Err(BrainFailure::Protocol("Codex answered nothing".to_owned()));
    }
    let stop = if calls.is_empty() {
        StopReason::EndTurn
    } else {
        StopReason::ToolCall
    };
    Ok(Answer {
        text: say,
        calls,
        stop,
    })
}

#[cfg(test)]
#[path = "codex_tests.rs"]
mod tests;
