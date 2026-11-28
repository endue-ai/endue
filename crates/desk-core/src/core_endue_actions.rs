//! The commands of an endue connector plugin (ADR 0409): it has no script, so the core registers the
//! commands its endue block acts with while the plugin is on and answers them itself. An invocation
//! calls its tool on the account connector its `instance` argument names, with the desk's own key and
//! one Idempotency-Key made for the invocation, the same on the one retry after a lost answer.

use std::sync::Arc;

use desk_bridge::{BridgeEvent, CmdInvokedData, CmdInvokedEvent, EndueRisk, EventName};
use desk_bridge::{CmdAnswerParams, CmdRegisterParams, CommandFailure, CommandFailureCode};
use desk_platform::wire_connectors::Risk;
use desk_platform::{ErrorKind, PlatformError};
use serde_json::{Map, Value};

use crate::endue_binding::{action_arguments, words};
use crate::handler::Core;

impl Core {
    /// Register the commands the plugin's endue block acts with, from its manifest.
    pub(crate) fn register_endue_commands(&self, id: &str) {
        let Some((_, binding)) = self.endue_manifest(id) else {
            return;
        };
        if !self.running(id) {
            return;
        }
        let info = self.plugins().into_iter().find(|p| p.id == id);
        let manifest = info.and_then(|p| p.manifest);
        let declared = manifest
            .and_then(|m| m.contributes)
            .and_then(|c| c.commands);
        for command in declared.into_iter().flatten() {
            if !binding
                .actions
                .as_ref()
                .is_some_and(|a| a.contains_key(&command.id))
            {
                continue;
            }
            let params = CmdRegisterParams {
                id: command.id.clone(),
                title: command.title.clone(),
                description: None,
                keywords: command.keywords.clone(),
                args_schema: None,
                when: None,
                undo: None,
                result_schema: None,
                agent: None,
                read_only: None,
                irreversible: None,
            };
            if let Err(why) = self.cmd_register(id, params) {
                eprintln!(
                    "desk: {id} kept {} unregistered: {}",
                    command.id, why.message
                );
            }
        }
    }

    /// `cmd.invoked` to the provider, or, for an endue plugin, the command run by the core itself.
    pub(crate) fn deliver_invoked(&self, provider: String, data: CmdInvokedData) {
        if self.invoke_endue(&provider, &data) {
            return;
        }
        let to = self.recipients(EventName::CmdInvoked, vec![provider]);
        let event = CmdInvokedEvent {
            event: Default::default(),
            data,
        };
        self.events().publish_to(to, BridgeEvent::CmdInvoked(event));
    }

    /// An endue plugin's invocation runs on a thread of its own and is answered from there.
    /// False when `provider` is not one.
    fn invoke_endue(&self, provider: &str, data: &CmdInvokedData) -> bool {
        if !self.is_endue(provider) {
            return false;
        }
        let Some(core) = self.connectors.me.get().and_then(std::sync::Weak::upgrade) else {
            return false;
        };
        let (provider, data) = (provider.to_owned(), data.clone());
        std::thread::spawn(move || answer(&core, &provider, &data));
        true
    }

    /// Run the action: its tool, its arguments, the account connector of its instance.
    fn run_endue_action(&self, provider: &str, data: &CmdInvokedData) -> Result<Value, String> {
        let (_, binding) = self
            .endue_manifest(provider)
            .ok_or("The connector was removed.")?;
        let action = binding.actions.as_ref().and_then(|a| a.get(&data.id));
        let action = action.ok_or_else(|| format!("{} has no action {}", provider, data.id))?;
        let args = data.args.as_ref();
        let instance = args.and_then(|a| a.get("instance")).and_then(Value::as_str);
        let instance =
            instance.ok_or_else(|| format!("{} needs the instance it acts on", data.id))?;
        let (connector, tool, risk) = {
            let endue = self.endue();
            let found = endue
                .0
                .get(provider)
                .and_then(|p| p.instances.get(instance));
            let found = found.ok_or_else(|| format!("{provider} has no instance {instance}"))?;
            if found.expired {
                return Err(crate::core_endue::reconnect(&found.title));
            }
            let tool = found.tools.get(&action.tool).cloned();
            let tool =
                tool.ok_or_else(|| format!("{instance} offers no tool ending {}", action.tool))?;
            let risk = found.risks.get(&action.tool).copied();
            (found.connector.clone(), tool, risk)
        };
        let mut arguments = action_arguments(action, args)?;
        let (connectors, _) = self
            .endue_connectors()
            .ok_or_else(|| crate::core_endue::off(instance))?;
        if risk.is_none_or(|risk| rank_of(risk) > rank(action.risk)) {
            return Err(format!(
                "{tool} does more than {} says, so it was not called",
                data.id
            ));
        }
        // Files go up only once the tool may be called: a refused call uploads nothing.
        self.endue_files(&data.caller, action, &mut arguments, &connectors)?;
        let key = format!("desk-{}", self.endue_invocation_key(&data.invocation_id));
        let mut answered = connectors.call(&connector, &tool, arguments.clone(), &key);
        if answered.as_ref().is_err_and(lost) {
            answered = connectors.call(&connector, &tool, arguments, &key);
        }
        let answered = answered.map_err(|e| self.endue_call_failed(e))?.value;
        if !answered.ok {
            return Err(words(&answered));
        }
        if answered.truncated {
            return Err(format!("{tool} answered only part of what it did"));
        }
        Ok(answered.data.unwrap_or(Value::Object(Map::new())))
    }

    /// A key made once for `what`: random, so two desks or two runs never share one.
    pub(crate) fn endue_invocation_key(&self, what: &str) -> String {
        let mut bits = [0u8; 12];
        if getrandom::fill(&mut bits).is_err() {
            // No randomness: the time keeps keys apart.
            let at = self
                .clock
                .now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default();
            bits[..8].copy_from_slice(&(at.as_nanos() as u64).to_le_bytes());
        }
        let hex: String = bits.iter().map(|b| format!("{b:02x}")).collect();
        if what.is_empty() {
            hex
        } else {
            format!("{what}-{hex}")
        }
    }

    pub(crate) fn endue_call_failed(&self, e: PlatformError) -> String {
        if e.kind == ErrorKind::SignedOut {
            return self.endue_key_refused();
        }
        e.message
    }
}

/// Run and answer one invocation, as its provider would.
fn answer(core: &Arc<Core>, provider: &str, data: &CmdInvokedData) {
    let (result, error) = match core.run_endue_action(provider, data) {
        Ok(result) => (Some(result), None),
        Err(message) => {
            let code = CommandFailureCode::Failed;
            (None, Some(CommandFailure { code, message }))
        }
    };
    let params = CmdAnswerParams {
        invocation_id: data.invocation_id.clone(),
        result,
        error,
    };
    // Cancelled meanwhile: nobody waits for the answer.
    let _ = core.cmd_answer(provider, params);
}

/// No answer came back, so the call may have acted: it is tried once more with the same key.
fn lost(e: &PlatformError) -> bool {
    e.kind == ErrorKind::Offline
        || (e.kind == ErrorKind::Failed && e.status.is_some_and(|s| s >= 500))
}

fn rank(risk: EndueRisk) -> u8 {
    match risk {
        EndueRisk::Read => 0,
        EndueRisk::Write => 1,
        EndueRisk::Send => 2,
        EndueRisk::Destructive => 3,
    }
}

fn rank_of(risk: Risk) -> u8 {
    match risk {
        Risk::Read => 0,
        Risk::Write => 1,
        Risk::Send => 2,
        Risk::Destructive => 3,
    }
}
