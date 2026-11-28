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
use desk_platform::wire_connectors::{ConnectorStatus as AccountStatus, Risk};
use desk_platform::{ErrorKind, PlatformError};
use serde_json::{Value, json};

use crate::core_connectors::{INSTANCES, status};
use crate::core_http::{interval, source};
use crate::handler::{Answer, Core, error};

/// One instance: the account connector it stands for and what the last sync left.
pub(crate) struct EndueInstance {
    /// The account connector's id.
    pub(crate) connector: String,
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

    /// List the account's connectors and keep one instance per connector that offers every tool.
    /// While the desk's key is off, the instances stay and say how to turn it on.
    pub(crate) fn refresh_endue(&self, id: &str) {
        let Some((connector, binding)) = self.endue_manifest(id) else {
            return;
        };
        let now = self.clock.now();
        let every = interval(&connector);
        if let Some(plugin) = self.endue().0.get_mut(id) {
            plugin.refresh = every.map(|e| now + e);
        }
        let found = match self.account_offering(&binding) {
            Ok(found) => found,
            Err(Listing::Off) => return self.endue_off(id),
            Err(Listing::Wait(wait)) => return self.endue_wait(id, wait),
            Err(Listing::Failed(why)) => {
                eprintln!("desk: {id} kept its instances: {why}");
                return;
            }
        };
        let (added, removed) = {
            let mut endue = self.endue();
            let plugin = endue.0.entry(id.to_owned()).or_default();
            let removed: Vec<String> = plugin
                .instances
                .keys()
                .filter(|name| !found.contains_key(*name))
                .cloned()
                .collect();
            for name in &removed {
                plugin.instances.remove(name);
            }
            let mut added = Vec::new();
            for (name, offered) in found {
                let instance = plugin.instances.entry(name.clone()).or_insert_with(|| {
                    added.push(name.clone());
                    offered.fresh(now)
                });
                instance.update(offered);
            }
            (added, removed)
        };
        for name in &removed {
            if let Ok(index) = self.index() {
                let _ = index.clear(&source(id, name));
            }
            self.set_title(id, name, None);
            self.announce_disconnected(id, name);
        }
        self.persist_endue(id);
        let listed = self.endue_instances(id);
        for instance in listed {
            let title = self.endue_title(id, &instance.instance);
            self.set_title(id, &instance.instance, title);
            if added.contains(&instance.instance) {
                self.announce_connected(id, &instance.instance, instance.status);
            } else {
                self.report(id, &instance.instance, instance.status);
            }
        }
    }

    /// endue AI asked the desk to wait: nothing of the plugin calls it before then.
    fn endue_wait(&self, id: &str, wait: u64) {
        let until = self.clock.now() + std::time::Duration::from_secs(wait);
        if let Some(plugin) = self.endue().0.get_mut(id) {
            plugin.refresh = Some(until);
            for instance in plugin.instances.values_mut() {
                instance.due = instance.due.map(|due| due.max(until));
            }
        }
    }

    /// The desk's key is off: every instance paused, saying how to turn it on.
    pub(crate) fn endue_off(&self, id: &str) {
        let changed: Vec<(String, ConnectorStatus)> = {
            let mut endue = self.endue();
            let instances = endue
                .0
                .get_mut(id)
                .into_iter()
                .flat_map(|p| &mut p.instances);
            instances
                .map(|(name, i)| {
                    i.status = status(
                        ConnectorState::Paused,
                        i.last_sync_at.clone(),
                        Some(off(&i.title)),
                    );
                    (name.clone(), i.status.clone())
                })
                .collect()
        };
        for (name, changed) in changed {
            self.report(id, &name, changed);
        }
    }

    /// The account connectors that offer every tool of `binding`, by instance id.
    fn account_offering(
        &self,
        binding: &EndueBinding,
    ) -> Result<BTreeMap<String, Offered>, Listing> {
        let (connectors, _) = self.endue_connectors().ok_or(Listing::Off)?;
        let listed = connectors.list().map_err(|e| self.listing_failed(e))?.value;
        let mut found = BTreeMap::new();
        for summary in listed {
            let tools = connectors.tools(&summary.connector_id);
            let tools = tools.map_err(|e| self.listing_failed(e))?.value;
            let mut by_ending = BTreeMap::new();
            let mut risks = BTreeMap::new();
            for ending in &binding.tools {
                let tail = format!("__{ending}");
                if let Some(tool) = tools.iter().find(|t| t.name.ends_with(&tail)) {
                    by_ending.insert(ending.clone(), tool.name.clone());
                    if let Some(risk) = tool.risk {
                        risks.insert(ending.clone(), risk);
                    }
                }
            }
            let Some(name) = instance_id(&summary.connector_id) else {
                continue;
            };
            if by_ending.len() == binding.tools.len() {
                let title = summary
                    .display_name
                    .or(summary.name)
                    .unwrap_or_else(|| name.clone());
                let expired = summary.status == AccountStatus::Expired;
                let connector = summary.connector_id;
                let tools = by_ending;
                found.insert(
                    name,
                    Offered {
                        connector,
                        title,
                        tools,
                        risks,
                        expired,
                    },
                );
            }
        }
        Ok(found)
    }

    fn listing_failed(&self, e: PlatformError) -> Listing {
        match e.kind {
            ErrorKind::SignedOut => {
                self.endue_key_refused();
                Listing::Off
            }
            ErrorKind::RateLimited { wait_secs } => Listing::Wait(wait_secs),
            _ => Listing::Failed(e.message),
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
                        "lastSyncAt": i.last_sync_at, "title": i.title, "tools": i.tools, "risks": i.risks,
                        "expired": i.expired })
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

enum Listing {
    Off,
    Wait(u64),
    Failed(String),
}

/// An account connector that offers every tool, as the listing found it.
struct Offered {
    connector: String,
    title: String,
    tools: BTreeMap<String, String>,
    risks: BTreeMap<String, Risk>,
    expired: bool,
}

impl Offered {
    fn fresh(&self, now: SystemTime) -> EndueInstance {
        EndueInstance {
            connector: self.connector.clone(),
            title: self.title.clone(),
            tools: self.tools.clone(),
            risks: self.risks.clone(),
            expired: self.expired,
            last_sync_at: None,
            skipped: 0,
            status: status(ConnectorState::Connected, None, None),
            due: Some(now),
            syncing: false,
        }
    }
}

impl EndueInstance {
    /// What the listing says now: its title, tools and whether it must be connected again.
    fn update(&mut self, offered: Offered) {
        self.title = offered.title;
        self.tools = offered.tools;
        self.risks = offered.risks;
        self.expired = offered.expired;
        if self.expired {
            self.status = expired(&self.title, self.last_sync_at.clone());
        } else if self
            .status
            .error
            .as_ref()
            .is_some_and(|e| e.reauth == Some(true))
            || self.status.state == ConnectorState::Paused
        {
            self.status = status(ConnectorState::Connected, self.last_sync_at.clone(), None);
        }
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
    let last = record["lastSyncAt"].as_str().map(str::to_owned);
    let expired = record["expired"].as_bool().unwrap_or(false);
    let instance = EndueInstance {
        status: if expired {
            self::expired(&title, last.clone())
        } else {
            status(ConnectorState::Connected, last.clone(), None)
        },
        connector,
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

/// The instance id of an account connector: its id in lowercase, when that is one.
fn instance_id(connector: &str) -> Option<String> {
    let name = connector.to_ascii_lowercase();
    desk_plugin_host::check_instance_id(&name)
        .ok()
        .map(|()| name)
}
