//! The desk's own key for the endue account's connectors (ADR 0407), as the OS keychain keeps it:
//! one entry with the key and what it may do, and one with the keys still to revoke. No file holds
//! either, no answer carries the key and no `Debug` prints it.

use std::collections::BTreeSet;
use std::fmt;
use std::sync::{Arc, Mutex, MutexGuard};

use desk_bridge::{
    AccountConnector, AccountConnectorGrant, AccountConnectorPower, AccountConnectorState,
};
use desk_platform::wire_connectors::{ConnectorStatus, ConnectorSummary, KeyScope};
use desk_sys::keychain::Keychain;
use serde::{Deserialize, Serialize};

use crate::studio::map::cut;

/// The keychain entry of the key.
pub(crate) const KEY_ENTRY: &str = "endue-connectors";
/// The keychain entry of the key ids still to revoke.
pub(crate) const REVOKE_ENTRY: &str = "endue-connectors-revoke";
/// Where endue.ai reconnects a connector, under its web host.
const RECONNECT_PATH: &str = "/resources/connectors";
const ENDUE_WEB: &str = "https://endue.ai";

/// The key as the keychain keeps it.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoredKey {
    pub id: String,
    pub secret: String,
    pub name: String,
    pub scopes: Vec<KeyScope>,
    /// Milliseconds since the epoch.
    pub created_at: u64,
}

impl fmt::Debug for StoredKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("StoredKey")
            .field("id", &self.id)
            .field("name", &self.name)
            .field("scopes", &self.scopes)
            .finish_non_exhaustive()
    }
}

/// The keychain the key lives in, and one lock so that two turns on or off do not interleave.
#[derive(Debug, Default)]
pub(crate) struct KeyStore {
    keychain: Option<Arc<dyn Keychain>>,
    turn: Mutex<()>,
}

impl KeyStore {
    pub(crate) fn new(keychain: Option<Arc<dyn Keychain>>) -> Self {
        Self {
            keychain,
            turn: Mutex::new(()),
        }
    }

    pub(crate) fn has_keychain(&self) -> bool {
        self.keychain.is_some()
    }

    /// Hold while reading and changing the key.
    pub(crate) fn turn(&self) -> MutexGuard<'_, ()> {
        self.turn.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// The key kept, if one is; one the keychain cannot read is none.
    pub(crate) fn key(&self) -> Option<StoredKey> {
        let text = self.keychain.as_ref()?.get(KEY_ENTRY).ok()??;
        serde_json::from_str(&text).ok()
    }

    pub(crate) fn keep(&self, key: &StoredKey) -> Result<(), String> {
        let keychain = self.keychain.as_ref().ok_or_else(no_keychain)?;
        let text = serde_json::to_string(key).map_err(|e| e.to_string())?;
        keychain
            .set(KEY_ENTRY, &text)
            .map_err(|e| format!("The keychain did not keep the desk's key: {}", e.message))
    }

    pub(crate) fn forget(&self) -> Result<(), String> {
        let Some(keychain) = &self.keychain else {
            return Ok(());
        };
        keychain
            .delete(KEY_ENTRY)
            .map_err(|e| format!("The keychain did not forget the desk's key: {}", e.message))
    }

    /// The key ids still to revoke.
    pub(crate) fn to_revoke(&self) -> BTreeSet<String> {
        let Some(keychain) = &self.keychain else {
            return BTreeSet::new();
        };
        let text = keychain.get(REVOKE_ENTRY).ok().flatten();
        text.and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }

    pub(crate) fn set_to_revoke(&self, ids: &BTreeSet<String>) {
        let Some(keychain) = &self.keychain else {
            return;
        };
        // A list that cannot be kept leaves a key endue AI still has; the person can revoke it on
        // endue.ai, where it carries the desk's name.
        let _ = if ids.is_empty() {
            keychain.delete(REVOKE_ENTRY)
        } else {
            let text = serde_json::to_string(ids).unwrap_or_default();
            keychain.set(REVOKE_ENTRY, &text)
        };
    }
}

pub(crate) fn no_keychain() -> String {
    "This computer has no keychain the desk can keep a key in, so it cannot use the endue \
     account's connectors."
        .to_owned()
}

/// What `scopes` let the desk do, as the bridge says it.
pub(crate) fn powers(scopes: &[KeyScope]) -> Vec<AccountConnectorPower> {
    let mut out = Vec::new();
    for (scope, power) in [
        (KeyScope::Read, AccountConnectorPower::Read),
        (KeyScope::Send, AccountConnectorPower::Publish),
        (KeyScope::Delete, AccountConnectorPower::Delete),
    ] {
        if scopes.contains(&scope) {
            out.push(power);
        }
    }
    out
}

/// The scopes a key needs for read and what `allow` adds, with what `held` already has.
pub(crate) fn wanted(allow: &[AccountConnectorGrant], held: &[KeyScope]) -> Vec<KeyScope> {
    let mut scopes: BTreeSet<KeyScope> = held.iter().copied().collect();
    scopes.insert(KeyScope::Read);
    for grant in allow {
        scopes.insert(match grant {
            AccountConnectorGrant::Publish => KeyScope::Send,
            AccountConnectorGrant::Delete => KeyScope::Delete,
        });
    }
    scopes.into_iter().collect()
}

/// The key's name on endue.ai: the desk and the computer it runs on.
pub(crate) fn key_name(computer: &str) -> String {
    let computer = computer.trim();
    let computer = if computer.is_empty() {
        "this computer"
    } else {
        computer
    };
    cut(&format!("endue Desk on {computer}"), 80)
}

/// This computer's name, as the person named it where the OS lets them.
pub(crate) fn computer_name() -> String {
    #[cfg(target_os = "macos")]
    {
        let named = std::process::Command::new("/usr/sbin/scutil")
            .args(["--get", "ComputerName"])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned());
        if let Some(name) = named.filter(|n| !n.is_empty()) {
            return name;
        }
    }
    for var in ["COMPUTERNAME", "HOSTNAME"] {
        if let Ok(name) = std::env::var(var)
            && !name.trim().is_empty()
        {
            return name.trim().to_owned();
        }
    }
    std::fs::read_to_string("/etc/hostname")
        .map(|n| n.trim().to_owned())
        .unwrap_or_default()
}

/// The page of endue.ai that reconnects a connector, for the platform at `base`:
/// `https://platform.dev.endue.ai` → `https://dev.endue.ai/resources/connectors`. A platform that
/// is not one of endue's points to endue.ai's.
pub(crate) fn reconnect_url(base: &str) -> String {
    let web = base
        .strip_prefix("https://platform.")
        .filter(|host| {
            let host = host.trim_end_matches('/');
            host == "endue.ai" || host.ends_with(".endue.ai")
        })
        .map(|host| format!("https://{}", host.trim_end_matches('/')))
        .unwrap_or_else(|| ENDUE_WEB.to_owned());
    format!("{web}{RECONNECT_PATH}")
}

/// One connector as the bridge shows it.
pub(crate) fn shown(summary: ConnectorSummary, reconnect: &str) -> AccountConnector {
    let state = match summary.status {
        ConnectorStatus::Active => AccountConnectorState::Active,
        ConnectorStatus::Expired => AccountConnectorState::Expired,
    };
    AccountConnector {
        id: cut(&summary.connector_id, 128),
        r#type: cut(&summary.kind, 128),
        name: summary.name.map(|n| cut(&n, 200)),
        title: summary.display_name.map(|n| cut(&n, 200)),
        reconnect_url: (state == AccountConnectorState::Expired).then(|| reconnect.to_owned()),
        state,
        tools: summary.tool_count.unwrap_or(0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_reconnect_page_is_endue_ais_beside_its_platform() {
        assert_eq!(
            reconnect_url("https://platform.endue.ai"),
            "https://endue.ai/resources/connectors"
        );
        assert_eq!(
            reconnect_url("https://platform.dev.endue.ai/"),
            "https://dev.endue.ai/resources/connectors"
        );
        assert_eq!(
            reconnect_url("http://127.0.0.1:4000"),
            "https://endue.ai/resources/connectors"
        );
        assert_eq!(
            reconnect_url("https://platform.example.com"),
            "https://endue.ai/resources/connectors"
        );
    }

    #[test]
    fn a_wider_key_keeps_what_the_old_one_had() {
        let held = [KeyScope::Read, KeyScope::Delete];
        let scopes = wanted(&[AccountConnectorGrant::Publish], &held);
        assert_eq!(scopes, [KeyScope::Read, KeyScope::Send, KeyScope::Delete]);
        assert_eq!(
            powers(&scopes),
            [
                AccountConnectorPower::Read,
                AccountConnectorPower::Publish,
                AccountConnectorPower::Delete
            ]
        );
        assert_eq!(key_name(" "), "endue Desk on this computer");
        assert_eq!(key_name(&"m".repeat(100)).chars().count(), 80);
    }

    #[test]
    fn a_stored_keys_debug_leaves_the_secret_out() {
        let key = StoredKey {
            id: "key_1".to_owned(),
            secret: "sk_secret".to_owned(),
            name: "desk".to_owned(),
            scopes: vec![KeyScope::Read],
            created_at: 1,
        };
        assert!(!format!("{key:?}").contains("sk_secret"));
    }
}
