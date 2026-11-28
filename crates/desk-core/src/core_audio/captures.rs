//! The captures `Core` keeps (ADR 0245): each one's entry by id, in the order they started, and the
//! ids that ended, so stopping one again is not an error.

use std::collections::{BTreeMap, VecDeque};
use std::sync::{Arc, Mutex};

use desk_bridge::{AudioCaptureInForce, AudioEndReason, Permission};
use desk_sys::audio::Capture;

use super::RUNTIME;

/// How many ended ids are remembered, so that stopping one again is not an error.
const ENDED: usize = 256;

pub(super) struct Entry {
    pub(super) caller: String,
    pub(super) scope: Permission,
    pub(super) capture: Arc<Capture>,
    /// Why it ends, set before it is stopped; its callback reads it for `audio.ended`.
    pub(super) reason: Arc<Mutex<AudioEndReason>>,
}

/// The captures callers started, by id, in the order they started, and the ids that ended (a stop of
/// one of those is not an error). Shared with each capture's callback, which removes its entry when
/// the capture ends.
#[derive(Default)]
pub(crate) struct Captures {
    pub(super) next: u64,
    pub(super) entries: BTreeMap<u64, (String, Entry)>,
    ended: VecDeque<(String, String)>,
}

impl Captures {
    pub(super) fn find(&self, id: &str) -> Option<u64> {
        self.entries
            .iter()
            .find(|(_, (capture_id, _))| capture_id == id)
            .map(|(key, _)| *key)
    }

    pub(super) fn has_ended(&self, caller: &str, id: &str) -> bool {
        self.ended
            .iter()
            .any(|(c, e)| (caller == RUNTIME || c == caller) && e == id)
    }

    pub(super) fn remember_ended(&mut self, caller: &str, id: &str) {
        if self.ended.len() == ENDED {
            self.ended.pop_front();
        }
        self.ended.push_back((caller.to_owned(), id.to_owned()));
    }

    pub(super) fn held_by(&self, caller: &str) -> usize {
        self.entries
            .values()
            .filter(|(_, e)| e.caller == caller)
            .count()
    }

    pub(super) fn in_force(&self) -> Vec<AudioCaptureInForce> {
        self.entries
            .values()
            .map(|(capture_id, entry)| AudioCaptureInForce {
                capture_id: capture_id.clone(),
                caller: entry.caller.clone(),
            })
            .collect()
    }
}
