//! The brains the desk chooses from for Eris (ADR 0094, amended for FT-01): the person's own Eris
//! on endue AI with their endue ID, their own Codex and Claude Code (ADR 0109), the local brain on
//! Ollama and examples/brain-echo. The runtime's setting `brain.use` picks one per turn (desk-core's
//! brain_choice.rs); a turn it cannot answer goes down endue, Codex, Claude Code, local. Each
//! address can be moved with an environment variable.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use desk_brain::Brain;
use desk_brain_endue::HttpBrain;
use desk_brain_local::{
    ClaudeCodeOptions, CodexOptions, DEFAULT_BASE_URL, LocalBrain, LocalBrainOptions, find_claude,
    find_codex,
};
use desk_core::account::Account;
use desk_core::{Brains, studio_tokens};
use desk_platform::Platform;

use crate::endue_eris::EndueEris;

/// examples/brain-echo (`just brain-echo`) unless `DESK_ECHO_URL` says otherwise.
pub const DEFAULT_ECHO_URL: &str = "http://127.0.0.1:8787/v0";

/// Every brain this desk can reach, keeping their sessions in `data`. endue is the person's Eris on
/// endue AI, asked with `account`'s token (`DESK_BRAIN_URL` points it at a `specs/brain/v0` brain
/// instead); Codex and Claude Code are `DESK_CODEX_PATH` and `DESK_CLAUDE_PATH`, else the program
/// found on PATH or where its installers put it, with `DESK_CODEX_MODEL` and `DESK_CLAUDE_MODEL`;
/// Ollama is at `DESK_OLLAMA_URL` (its own default otherwise).
pub fn brains(data: &Path, home: &Path, account: Arc<Account>) -> Brains {
    let mut brains = Brains::default().with_folder(data);
    match endue(data, account) {
        Ok(brain) => brains = brains.with_endue(brain),
        Err(why) => eprintln!("endue: no endue AI brain ({why})"),
    }
    match HttpBrain::new(&url("DESK_ECHO_URL", DEFAULT_ECHO_URL)) {
        Ok(brain) => brains = brains.with_echo(Arc::new(brain)),
        Err(why) => eprintln!("endue: no echo brain ({why})"),
    }
    let path = std::env::var_os("PATH");
    // A Codex or Claude Code not found now still answers as the name on PATH, or is unreachable,
    // so the choice exists and the next brain stands in.
    let codex = std::env::var_os("DESK_CODEX_PATH")
        .map(PathBuf::from)
        .or_else(|| find_codex(path.clone(), Some(home.to_path_buf())))
        .unwrap_or_else(|| PathBuf::from("codex"));
    let mut options = CodexOptions::new(codex);
    if let Ok(model) = std::env::var("DESK_CODEX_MODEL") {
        options = options.with_model(model);
    }
    match LocalBrain::codex(data.join("codex-brain"), options) {
        Ok(brain) => brains = brains.with_codex(Arc::new(brain)),
        Err(why) => eprintln!("endue: no Codex brain ({why})"),
    }
    let program = std::env::var_os("DESK_CLAUDE_PATH")
        .map(PathBuf::from)
        .or_else(|| find_claude(path, Some(home.to_path_buf())))
        .unwrap_or_else(|| PathBuf::from("claude"));
    let mut claude = ClaudeCodeOptions::new(program.clone());
    if let Ok(model) = std::env::var("DESK_CLAUDE_MODEL") {
        claude = claude.with_model(model);
    }
    match LocalBrain::claude_code(data.join("claude-brain"), claude) {
        Ok(brain) => brains = brains.with_claude(Arc::new(brain)),
        Err(why) => eprintln!("endue: no Claude Code brain ({why})"),
    }
    // The model the person chose for Eris (`brain.claude-model`, ADR 0296), each in a folder of its own.
    let claude_models = data.join("claude-brain-models");
    brains = brains.with_claude_models(move |model: &str| {
        let options = ClaudeCodeOptions::new(program.clone()).with_model(model.to_owned());
        let brain = LocalBrain::claude_code(claude_models.join(file_safe(model)), options)?;
        Ok(Arc::new(brain) as Arc<dyn Brain>)
    });
    let ollama = url("DESK_OLLAMA_URL", DEFAULT_BASE_URL);
    let folder = data.join("local-brain");
    brains.with_local(move |model: &str| {
        let options = LocalBrainOptions::new(model).with_base_url(ollama.clone());
        let brain = LocalBrain::open(folder.join(file_safe(model)), options)?;
        Ok(Arc::new(brain) as Arc<dyn Brain>)
    })
}

/// The `endue` brain: a `specs/brain/v0` brain at `DESK_BRAIN_URL` when it is set, else the
/// person's Eris on endue AI (`DESK_ENDUE_PLATFORM_URL` moves endue AI, as for the agent bar).
fn endue(data: &Path, account: Arc<Account>) -> Result<Arc<dyn Brain>, String> {
    if let Some(at) = std::env::var("DESK_BRAIN_URL")
        .ok()
        .filter(|at| !at.trim().is_empty())
    {
        let brain = HttpBrain::new(&at).map_err(|e| e.to_string())?;
        let brain = brain.with_token_source(Arc::new(move || account.token()));
        return Ok(Arc::new(brain));
    }
    let platform = Platform::from_env(studio_tokens(&account)).map_err(|e| e.message)?;
    let eris = EndueEris::new(Box::new(platform));
    let brain = LocalBrain::with_model(data.join("endue-brain"), "endue", Box::new(eris))?;
    Ok(Arc::new(brain))
}

fn url(variable: &str, default: &str) -> String {
    std::env::var(variable).unwrap_or_else(|_| default.to_owned())
}

/// A model name as a folder name: letters, digits, `.`, `-` and `_`; anything else is `_`.
fn file_safe(model: &str) -> String {
    model
        .chars()
        .map(|c| match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '.' | '-' | '_' => c,
            _ => '_',
        })
        .collect()
}
