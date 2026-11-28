//! Listing the endue account's connectors for an endue connector plugin (ADR 0408): one instance
//! per connector that offers every tool its block names, found by the tool's ending; a connector
//! that left takes its instance and items, an expired one says to reconnect on endue.ai, a refused
//! key turns the instances to paused, and a 429 holds every call of the plugin until its wait.

use std::collections::BTreeMap;
use std::time::SystemTime;

use desk_bridge::{ConnectorState, ConnectorStatus, EndueBinding};
use desk_platform::wire_connectors::{ConnectorStatus as AccountStatus, Risk};
use desk_platform::{ErrorKind, PlatformError};

use crate::core_connectors::status;
use crate::core_endue::{EndueInstance, expired, off};
use crate::core_http::{interval, source};
use crate::handler::Core;

impl Core {
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
                        kind: summary.kind,
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
}

enum Listing {
    Off,
    Wait(u64),
    Failed(String),
}

/// An account connector that offers every tool, as the listing found it.
struct Offered {
    connector: String,
    kind: String,
    title: String,
    tools: BTreeMap<String, String>,
    risks: BTreeMap<String, Risk>,
    expired: bool,
}

impl Offered {
    fn fresh(&self, now: SystemTime) -> EndueInstance {
        EndueInstance {
            connector: self.connector.clone(),
            kind: self.kind.clone(),
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
        self.kind = offered.kind;
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

/// The instance id of an account connector: its id in lowercase, when that is one.
fn instance_id(connector: &str) -> Option<String> {
    let name = connector.to_ascii_lowercase();
    desk_plugin_host::check_instance_id(&name)
        .ok()
        .map(|()| name)
}
