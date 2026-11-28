//! One sync of an endue connector's instance (ADR 0408): `syncing`, every request's pages read with
//! the desk's own key (`endue_binding`), what changed written to the index, then `connected`, or
//! `error` with the tool's words. A sync that stopped early (its budget spent, the limit reached)
//! writes what it read and removes nothing, and the next one waits as the limit asks.

use std::time::Duration;

use desk_bridge::{ConnectorError, ConnectorState, ConnectorStatus};
use desk_platform::{ErrorKind, PlatformError};
use desk_plugin_host::rfc3339;

use crate::core_connectors::status;
use crate::core_endue::{expired, off};
use crate::core_http::{interval, source};
use crate::endue_binding::{self, Fault, Read};
use crate::handler::Core;
use crate::http_binding::{Failure, Here};

/// How a sync ended.
enum Ended {
    Read(Read),
    Failed(Failure),
    Off,
    Expired,
}

impl Core {
    /// One sync: `syncing`, then what it ended with.
    pub(crate) fn sync_endue(&self, id: &str, name: &str) {
        let every = self.endue_manifest(id).and_then(|(c, _)| interval(&c));
        let now = self.clock.now();
        let syncing = {
            let mut endue = self.endue();
            let Some(i) = endue.0.get_mut(id).and_then(|p| p.instances.get_mut(name)) else {
                return;
            };
            if i.syncing {
                return;
            }
            i.syncing = true;
            i.due = every.map(|e| now + e);
            i.status = status(ConnectorState::Syncing, i.last_sync_at.clone(), None);
            i.status.clone()
        };
        self.report(id, name, syncing);
        let ended = self.run_endue(id, name);
        let ended = {
            let mut endue = self.endue();
            let Some(i) = endue.0.get_mut(id).and_then(|p| p.instances.get_mut(name)) else {
                // Its connector left meanwhile: what the sync wrote goes too.
                drop(endue);
                if let Ok(index) = self.index() {
                    let _ = index.clear(&source(id, name));
                }
                return;
            };
            i.syncing = false;
            i.status = match ended {
                Ended::Read(read) => {
                    if let Some(wait) = read.wait {
                        let wait = Duration::from_secs(wait);
                        i.due = Some(now + every.map_or(wait, |e| e.max(wait)));
                    }
                    i.skipped = read.skipped;
                    i.last_sync_at = Some(rfc3339(now));
                    status(ConnectorState::Connected, i.last_sync_at.clone(), None)
                }
                Ended::Failed(failure) => ConnectorStatus {
                    state: ConnectorState::Error,
                    last_sync_at: i.last_sync_at.clone(),
                    error: Some(ConnectorError {
                        message: failure.message,
                        reauth: failure.reauth.then_some(true),
                    }),
                },
                Ended::Off => status(
                    ConnectorState::Paused,
                    i.last_sync_at.clone(),
                    Some(off(&i.title)),
                ),
                Ended::Expired => expired(&i.title, i.last_sync_at.clone()),
            };
            i.status.clone()
        };
        self.persist_endue(id);
        self.report(id, name, ended);
    }

    /// Read every request's pages and write what changed since the index's copy.
    fn run_endue(&self, id: &str, name: &str) -> Ended {
        let Some((_, binding)) = self.endue_manifest(id) else {
            return Ended::Failed(Failure::new(format!("no connector {id}")));
        };
        let (connector, tools, since, is_expired, title, kind) = {
            let endue = self.endue();
            let Some(i) = endue.0.get(id).and_then(|p| p.instances.get(name)) else {
                return Ended::Off;
            };
            (
                i.connector.clone(),
                i.tools.clone(),
                i.last_sync_at.clone(),
                i.expired,
                i.title.clone(),
                i.kind.clone(),
            )
        };
        if is_expired {
            return Ended::Expired;
        }
        let Some((connectors, _)) = self.endue_connectors() else {
            return Ended::Off;
        };
        let mut refused = false;
        let mut call = |tool: &str, arguments| {
            let key = self.endue_key_for_read();
            match connectors.call(&connector, tool, arguments, &key) {
                Ok(answer) => Ok(answer),
                Err(e) => Err(fault(e, &mut refused)),
            }
        };
        let source = source(id, name);
        let synced_at = rfc3339(self.clock.now());
        let here = Here {
            id: name,
            title: Some(&title),
            kind: Some(&kind),
            synced_at: &synced_at,
        };
        let since = since.as_deref();
        let read = endue_binding::sync(&binding, &tools, since, &source, &here, &mut call);
        if refused {
            self.endue_key_refused();
            return Ended::Off;
        }
        let read = match read {
            Ok(read) => read,
            Err(failure) => return Ended::Failed(failure),
        };
        let remove = read.complete && !endue_binding::reads_since(&binding);
        let items = read.items.clone();
        match self.write_items(&source, items, remove) {
            Ok(()) => Ended::Read(read),
            Err(why) => Ended::Failed(Failure::new(why)),
        }
    }

    /// A key for one read call: reads change nothing, so each is its own.
    fn endue_key_for_read(&self) -> String {
        format!("desk-read-{}", self.endue_invocation_key(""))
    }
}

/// A failed call as the binding sees it: a wait, a refusal of the key (`refused`), an expired
/// connector, or a failure in endue AI's words.
fn fault(e: PlatformError, refused: &mut bool) -> Fault {
    match e.kind {
        ErrorKind::RateLimited { wait_secs } => Fault::Wait(wait_secs),
        ErrorKind::SignedOut => {
            *refused = true;
            Fault::Failed(Failure::new(e.message))
        }
        ErrorKind::Conflict => Fault::Failed(Failure {
            message: e.message,
            reauth: true,
        }),
        _ => Fault::Failed(Failure::new(e.message)),
    }
}
