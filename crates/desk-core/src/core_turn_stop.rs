//! brain.stop (FT-06, ADR 0409): the person stops a turn of Eris's. Each turn has a flag the turn
//! loop, its sink and the wait on a command read; brain.stop raises it, stops the local agent runs
//! the turn started, and ends the turn at once as `stopped`. A call already sent to a command runs
//! on: it cannot be taken back, and its row says so.

use std::collections::HashMap;
use std::mem;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use desk_bridge::{
    BrainStopParams, BrainStopResult, BrainTurnKind, BrainTurnReason, ErrorCode, Permission,
};

use crate::conversation_sink::Sink;
use crate::handler::{Answer, Core, error, json};
use crate::perm::Target;

/// What Eris says when the person stopped her turn.
pub const STOPPED_LINE: &str = "Stopped.";

#[derive(Default)]
struct Turn {
    /// Who said the line; only they may stop it.
    caller: Option<String>,
    stop: Arc<AtomicBool>,
    /// The local agent runs its calls started.
    runs: Vec<String>,
}

/// The turns going on, by id.
#[derive(Default)]
pub(crate) struct TurnStops(Mutex<HashMap<String, Turn>>);

impl TurnStops {
    fn lock(&self) -> MutexGuard<'_, HashMap<String, Turn>> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Turn `turn`'s flag: raised once it is stopped.
    pub(crate) fn flag(&self, turn: &str) -> Arc<AtomicBool> {
        Arc::clone(&self.lock().entry(turn.to_owned()).or_default().stop)
    }

    /// `caller` said turn `turn`'s line.
    pub(crate) fn said(&self, turn: &str, caller: &str) {
        self.lock().entry(turn.to_owned()).or_default().caller = Some(caller.to_owned());
    }

    /// A call of turn `turn` started local agent run `run`.
    pub(crate) fn ran(&self, turn: &str, run: &str) {
        if let Some(entry) = self.lock().get_mut(turn) {
            entry.runs.push(run.to_owned());
        }
    }

    pub(crate) fn stopped(&self, turn: &str) -> bool {
        self.lock()
            .get(turn)
            .is_some_and(|t| t.stop.load(Ordering::SeqCst))
    }

    /// Turn `turn` ended: nothing is left to stop.
    pub(crate) fn ended(&self, turn: &str) {
        self.lock().remove(turn);
    }
}

impl Core {
    pub(crate) fn brain_stop(&self, caller: &str, params: BrainStopParams) -> Answer {
        self.check(
            caller,
            &Permission::BrainConverse(params.scope),
            &Target::None,
        )?;
        let turn = params.turn_id;
        let runs = {
            let mut turns = self.turn_stops.lock();
            let Some(going) = turns.get_mut(&turn) else {
                return json(BrainStopResult { stopped: false });
            };
            if going.caller.as_deref() != Some(caller) {
                let why = format!("turn {turn} is not one {caller} started");
                return Err(error(ErrorCode::PermissionDenied, why));
            }
            if going.stop.swap(true, Ordering::SeqCst) {
                return json(BrainStopResult { stopped: false });
            }
            mem::take(&mut going.runs)
        };
        if let Some(agents) = &self.local_agents {
            for run in runs {
                crate::local_agents::stop_run(&agents.runs, &run);
            }
        }
        let reason = Some(BrainTurnReason::Stopped);
        Sink::new(self.events(), &turn).publish_why(
            BrainTurnKind::Error,
            Some(STOPPED_LINE),
            reason,
        );
        json(BrainStopResult { stopped: true })
    }
}
