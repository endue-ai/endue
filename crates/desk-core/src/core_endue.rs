//! Endue connectors (`binding: endue`, ADR 0408): plugins whose instances are the endue account's
//! connectors. The core lists the account's connectors with the desk's own key (ADR 0407) at start,
//! on connector.sync and every sync interval, keeps one instance per connector that offers every
//! tool the block names, and removes the instance and its items when its connector leaves. Records
//! live in the plugin's store under `desk.connector/instances`, as the http binding's do.

use std::collections::BTreeMap;
use std::time::SystemTime;

use desk_bridge::{
    ConnectorError, ConnectorInstance, ConnectorManifest, ConnectorState, ConnectorStatus,
    EndueBinding, ErrorCode,
};
use desk_platform::wire_connectors::Risk;
use serde_json::{Value, json};

use crate::core_connectors::{INSTANCES, status};
use crate::core_http::source;
use crate::handler::{Answer, Core, error};

/// One instance: the account connector it stands for and what the last sync left.
pub(crate) struct EndueInstance {
    /// The account connector's id.
    pub(crate) connector: String,
    /// The account connector's type, which `{ instance: type }` values read.
    pub(crate) kind: String,
    pub(crate) title: String,
    /// Its tools' full names, by the ending the block names.
    pub(crate) tools: BTreeMap<String, String>,
    /// What each of those tools does, as the account's catalog says.
    pub(crate) risks: BTreeMap<String, Risk>,
    pub(crate) expired: bool,
    pub(crate) last_sync_at: Option<String>,
    /// Records of the last sync that made no valid item.
    pub(crate) skipped: u64,
    pub(crate) status: ConnectorStatus,
    pub(crate) due: Option<SystemTime>,
    pub(crate) syncing: bool,
}

/// One plugin's instances and when the account's connectors are listed again.
#[derive(Default)]
pub(crate) struct EnduePlugin {
    pub(crate) instances: BTreeMap<String, EndueInstance>,
    pub(crate) refresh: Option<SystemTime>,
}

#[derive(Default)]
pub(crate) struct EndueConnectors(pub(crate) BTreeMap<String, EnduePlugin>);

/// What the person reads while the endue account's connectors are off.
pub(crate) fn off(title: &str) -> String {
    format!("Turn on the endue account's connectors in Settings, Connections to sync {title}.")
}

/// What the person reads when the account connector must be connected again.
pub(crate) fn reconnect(title: &str) -> String {
    format!("Reconnect {title} on endue.ai.")
}

impl Core {
    /// The connector block and its endue block of a ready endue connector plugin.
    pub(crate) fn endue_manifest(&self, id: &str) -> Option<(ConnectorManifest, EndueBinding)> {
        let info = self.plugins().into_iter().find(|p| p.id == id)?;
        let connector = crate::core_wasm::listed(&info)?.clone();
        let binding = connector.endue.clone()?;
        (connector.binding == desk_bridge::ConnectorBinding::Endue).then_some((connector, binding))
    }

    pub(crate) fn is_endue(&self, id: &str) -> bool {
        self.endue_manifest(id).is_some()
    }

    /// Load the plugin's instances from its store, once; the account is listed at the next tick.
    pub(crate) fn load_endue(&self, id: &str) {
        if !self.endue().0.contains_key(id) {
            let now = self.clock.now();
            let mut plugin = EnduePlugin {
                refresh: Some(now),
                ..EnduePlugin::default()
            };
            if let Some(Value::Array(records)) = self.stored(id, INSTANCES) {
                for record in records {
                    if let Some((name, instance)) = stored(&record, now) {
                        plugin.instances.insert(name, instance);
                    }
                }
            }
            self.endue().0.insert(id.to_owned(), plugin);
        }
        self.register_endue_commands(id);
    }

    /// The plugin's instances as connector.list lists them; paused while the plugin is off.
    pub(crate) fn endue_instances(&self, id: &str) -> Vec<ConnectorInstance> {
        let running = self.running(id);
        let endue = self.endue();
        let instances = endue.0.get(id).into_iter().flat_map(|p| &p.instances);
        instances
            .map(|(name, i)| ConnectorInstance {
                connector: id.to_owned(),
                instance: name.clone(),
                title: None,
                settings: Some(settings(i)),
                status: if running || i.syncing {
                    i.status.clone()
                } else {
                    status(ConnectorState::Paused, i.last_sync_at.clone(), None)
                },
            })
            .collect()
    }

    /// connector.connect and connector.disconnect: an endue plugin's instances are the account's.
    pub(crate) fn endue_not_connected_here(&self, id: &str) -> Answer {
        let why = format!(
            "{id}'s instances are the endue account's connectors: connect or remove them on endue.ai"
        );
        Err(error(ErrorCode::Unsupported, why))
    }

    /// connector.sync: list the account again, then sync the instance before this answers.
    pub(crate) fn sync_endue_now(&self, id: &str, name: &str) -> Answer {
        if !self.running(id) {
            let why = format!("{id} is turned off; turn it on to sync {name}");
            return Err(error(ErrorCode::InvalidParams, why));
        }
        self.refresh_endue(id);
        if !self
            .endue()
            .0
            .get(id)
            .is_some_and(|p| p.instances.contains_key(name))
        {
            return Err(error(
                ErrorCode::NotFound,
                format!("{id} has no instance {name}"),
            ));
        }
        self.sync_endue(id, name);
        crate::handler::json(desk_bridge::ConnectorSyncNowResult {
            started: desk_bridge::True,
        })
    }

    /// Every endue plugin that is on: the account listed when due, then every due sync.
    pub(crate) fn tick_endue(&self) -> Vec<(String, String)> {
        let now = self.clock.now();
        let plugins: Vec<String> = self.endue().0.keys().cloned().collect();
        let mut ran = Vec::new();
        for id in plugins.into_iter().filter(|id| self.running(id)) {
            let refresh = self.endue().0.get(&id).and_then(|p| p.refresh);
            if refresh.is_some_and(|at| at <= now) {
                self.refresh_endue(&id);
            }
            let due: Vec<String> = {
                let endue = self.endue();
                let instances = endue.0.get(&id).into_iter().flat_map(|p| &p.instances);
                let due = instances.filter(|(_, i)| !i.syncing && i.due.is_some_and(|d| d <= now));
                due.map(|(name, _)| name.clone()).collect()
            };
            for name in due {
                self.sync_endue(&id, &name);
                ran.push((id.clone(), name));
            }
        }
        ran
    }

    /// The desk's key was turned on or off: every endue plugin lists the account at the next tick.
    pub(crate) fn endue_key_changed(&self) {
        let now = self.clock.now();
        for plugin in self.endue().0.values_mut() {
            plugin.refresh = Some(now);
        }
    }

    /// The plugin was turned on or off: its instances say so, and its commands come back when on.
    pub(crate) fn endue_toggled(&self, id: &str) {
        if self.running(id) {
            let now = self.clock.now();
            if let Some(plugin) = self.endue().0.get_mut(id) {
                plugin.refresh = Some(now);
                for instance in plugin.instances.values_mut() {
                    instance.due = Some(now);
                }
            }
            self.register_endue_commands(id);
        }
        for instance in self.endue_instances(id) {
            self.report(id, &instance.instance, instance.status);
        }
    }

    /// The plugin is being removed: its instances leave memory and their items the index.
    pub(crate) fn forget_endue(&self, id: &str) {
        let Some(plugin) = self.endue().0.remove(id) else {
            return;
        };
        let Ok(index) = self.index() else {
            return;
        };
        for name in plugin.instances.keys() {
            if let Err(why) = index.clear(&source(id, name)) {
                eprintln!("desk: the index kept {id}/{name}'s items: {}", why.message);
            }
        }
    }

    pub(crate) fn endue_title(&self, id: &str, name: &str) -> Option<String> {
        let endue = self.endue();
        let plugin = endue.0.get(id)?;
        plugin.instances.get(name).map(|i| i.title.clone())
    }

    /// The instances' records in the plugin's own store.
    pub(crate) fn persist_endue(&self, id: &str) {
        let records: Vec<Value> = {
            let endue = self.endue();
            let instances = endue.0.get(id).into_iter().flat_map(|p| &p.instances);
            instances
                .map(|(name, i)| {
                    json!({ "id": name, "settings": settings(i), "paused": false,
                        "lastSyncAt": i.last_sync_at, "title": i.title, "kind": i.kind, "tools": i.tools,
                        "risks": i.risks, "expired": i.expired })
                })
                .collect()
        };
        // A refused write leaves the instances in memory for this run.
        let _ = self.store_put(id, INSTANCES, Value::Array(records));
    }

    pub(crate) fn endue(&self) -> std::sync::MutexGuard<'_, EndueConnectors> {
        self.connectors
            .endue
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// `error` with reauth: the account connector must be connected again on endue.ai.
pub(crate) fn expired(title: &str, last_sync_at: Option<String>) -> ConnectorStatus {
    ConnectorStatus {
        state: ConnectorState::Error,
        last_sync_at,
        error: Some(ConnectorError {
            message: reconnect(title),
            reauth: Some(true),
        }),
    }
}

/// What connector.list shows as the instance's settings: the account connector it stands for, and
/// how many records its last sync skipped.
fn settings(i: &EndueInstance) -> serde_json::Map<String, Value> {
    let shown = json!({ "connector": i.connector, "skipped": i.skipped });
    shown.as_object().cloned().unwrap_or_default()
}

/// An instance from its stored record, due now.
fn stored(record: &Value, now: SystemTime) -> Option<(String, EndueInstance)> {
    let name = record["id"].as_str()?.to_owned();
    let connector = record["settings"]["connector"].as_str()?.to_owned();
    let tools = serde_json::from_value(record["tools"].clone()).ok()?;
    let risks = serde_json::from_value(record["risks"].clone()).unwrap_or_default();
    let title = record["title"].as_str().unwrap_or(&name).to_owned();
    let kind = record["kind"].as_str().unwrap_or_default().to_owned();
    let last = record["lastSyncAt"].as_str().map(str::to_owned);
    let expired = record["expired"].as_bool().unwrap_or(false);
    let instance = EndueInstance {
        status: if expired {
            self::expired(&title, last.clone())
        } else {
            status(ConnectorState::Connected, last.clone(), None)
        },
        connector,
        kind,
        title,
        tools,
        risks,
        expired,
        last_sync_at: last,
        skipped: record["settings"]["skipped"].as_u64().unwrap_or(0),
        due: Some(now),
        syncing: false,
    };
    Some((name, instance))
}
