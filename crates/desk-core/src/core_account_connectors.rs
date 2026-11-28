//! account.connectors.* (ADR 0407): "Use my endue connectors on this desk". Turning it on makes a
//! key for the desk with the session, read only, and keeps it in the OS keychain; publishing or
//! deleting for the first time replaces it with a wider one. Every connector call carries that key
//! and never the session. Turning it off, or signing out, revokes the key and forgets it; a revoke
//! endue AI cannot take now is tried again at the next start. Nothing is sent before the person
//! turns it on, and no answer carries the key.

use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use desk_bridge::{
    AccountConnectors, AccountConnectorsEnableParams, AccountParams, BridgeError, ErrorCode,
};
use desk_platform::wire_connectors::KeyScope;
use desk_platform::{Connectors, ErrorKind, Platform};

use crate::account::{Account, State};
use crate::account_connectors::{
    KeyStore, StoredKey, computer_name, key_name, no_keychain, powers, reconnect_url, shown, wanted,
};
use crate::core_studio::failed;
use crate::handler::{Answer, Core, error, json};
use crate::studio::map::cut;

const SIGN_IN: &str = "Sign in to endue to use your endue connectors on this desk.";
const REFUSED: &str =
    "endue no longer accepts this desk's key. Turn the connectors on again to make a new one.";
const REVOKE_LATER: &str = "endue could not be reached to revoke the desk's old key. The desk \
     forgot it and revokes it the next time it starts.";

fn off(problem: Option<String>) -> AccountConnectors {
    AccountConnectors {
        enabled: false,
        may: Vec::new(),
        key_name: None,
        created_at: None,
        connectors: Vec::new(),
        problem: problem.map(|p| cut(&p, 500)),
    }
}

impl Core {
    /// Keep the desk's key for the account's connectors in `keychain` (ADR 0407); without one,
    /// account.connectors.enable says that this computer cannot.
    pub fn with_account_connectors(
        mut self,
        keychain: Option<Arc<dyn crate::account::Keychain>>,
    ) -> Self {
        self.account_connectors = KeyStore::new(keychain);
        self
    }

    /// Revoke the keys a turn-off or sign-out could not revoke, now that the desk starts. It waits
    /// for endue; run it off the main thread.
    pub fn settle_account_connectors(&self) {
        if let Some(account) = &self.account {
            let _turn = self.account_connectors.turn();
            self.revoke_pending(account);
        }
    }

    /// The account's connectors through the desk's own key, and what the key may do; `None` while
    /// it is off.
    pub(crate) fn endue_connectors(&self) -> Option<(Connectors, Vec<KeyScope>)> {
        let account = self.account.as_ref()?;
        let key = self.account_connectors.key()?;
        let platform = self.studio.platform(Some(account))?;
        Some((platform.with_key(&key.secret), key.scopes))
    }

    /// endue refused the desk's key: forget it, once, and say so.
    pub(crate) fn endue_key_refused(&self) -> String {
        let _turn = self.account_connectors.turn();
        let _ = self.account_connectors.forget();
        REFUSED.to_owned()
    }

    pub(crate) fn account_connectors_status(&self, caller: &str, params: AccountParams) -> Answer {
        let account = Arc::clone(self.account_for(caller, params.scope)?);
        if !self.account_connectors.has_keychain() {
            return json(off(Some(no_keychain())));
        }
        {
            let _turn = self.account_connectors.turn();
            self.revoke_pending(&account);
        }
        json(self.connectors_now())
    }

    pub(crate) fn account_connectors_enable(
        &self,
        caller: &str,
        params: AccountConnectorsEnableParams,
    ) -> Answer {
        let account = Arc::clone(self.account_for(caller, params.scope)?);
        if !self.account_connectors.has_keychain() {
            return Err(error(ErrorCode::Unsupported, no_keychain()));
        }
        let platform = self.session_platform(&account)?;
        {
            let _turn = self.account_connectors.turn();
            self.revoke_pending(&account);
            let held = self.account_connectors.key();
            let held_scopes = held.as_ref().map_or(&[][..], |k| k.scopes.as_slice());
            let scopes = wanted(params.allow.as_deref().unwrap_or_default(), held_scopes);
            if held.as_ref().is_none_or(|k| k.scopes != scopes) {
                let name = key_name(&computer_name());
                let made = platform.create_key(&name, &scopes).map_err(failed)?;
                let key = StoredKey {
                    id: made.id,
                    secret: made.secret,
                    name: made.name.unwrap_or(name),
                    scopes: made.scopes,
                    created_at: self.now_ms(),
                };
                if let Err(why) = self.account_connectors.keep(&key) {
                    // A key the desk cannot keep must not stay at endue.
                    if platform.revoke_key(&key.id).is_err() {
                        self.later(&key.id);
                    }
                    return Err(error(ErrorCode::IoError, why));
                }
                // The wider key is kept first; the old one goes only then.
                if let Some(old) = held
                    && platform.revoke_key(&old.id).is_err()
                {
                    self.later(&old.id);
                }
            }
        }
        self.endue_key_changed();
        json(self.connectors_now())
    }

    pub(crate) fn account_connectors_disable(&self, caller: &str, params: AccountParams) -> Answer {
        let account = Arc::clone(self.account_for(caller, params.scope)?);
        let problem = self.forget_endue_key(&account)?;
        self.endue_key_changed();
        json(off(problem))
    }

    /// Forget the desk's key and revoke it with the session, before a sign-out ends the session.
    /// A revoke that cannot go through now is kept for the next start, and said.
    pub(crate) fn forget_endue_key(
        &self,
        account: &Arc<Account>,
    ) -> Result<Option<String>, BridgeError> {
        let _turn = self.account_connectors.turn();
        let Some(key) = self.account_connectors.key() else {
            return Ok(None);
        };
        self.account_connectors
            .forget()
            .map_err(|why| error(ErrorCode::IoError, why))?;
        let revoked = self
            .session_platform(account)
            .ok()
            .is_some_and(|platform| platform.revoke_key(&key.id).is_ok());
        if revoked {
            return Ok(None);
        }
        self.later(&key.id);
        Ok(Some(REVOKE_LATER.to_owned()))
    }

    /// What account.connectors.status answers now: the key's powers and the connectors it sees.
    fn connectors_now(&self) -> AccountConnectors {
        let Some(key) = self.account_connectors.key() else {
            return off(None);
        };
        let Some((connectors, _)) = self.endue_connectors() else {
            return off(Some(SIGN_IN.to_owned()));
        };
        let mut answer = AccountConnectors {
            enabled: true,
            may: powers(&key.scopes),
            key_name: Some(cut(&key.name, 80)),
            created_at: Some(key.created_at),
            connectors: Vec::new(),
            problem: None,
        };
        match connectors.list() {
            Ok(list) => {
                let reconnect = self
                    .studio
                    .platform(self.account.as_ref())
                    .map_or_else(|| reconnect_url(""), |p| reconnect_url(p.base_url()));
                answer.connectors = list
                    .value
                    .into_iter()
                    .take(500)
                    .map(|c| shown(c, &reconnect))
                    .collect();
            }
            Err(e) if e.kind == ErrorKind::SignedOut => return off(Some(self.endue_key_refused())),
            Err(e) => answer.problem = Some(cut(&e.message, 500)),
        }
        answer
    }

    /// The platform with the session, once the desk is signed in.
    fn session_platform(&self, account: &Arc<Account>) -> Result<Arc<Platform>, BridgeError> {
        let signed_out = || error(ErrorCode::SignedOut, SIGN_IN.to_owned());
        if account.status().state != State::SignedIn {
            return Err(signed_out());
        }
        self.studio.platform(Some(account)).ok_or_else(signed_out)
    }

    /// Revoke the keys kept for later, while signed in; the ones endue AI still cannot take stay.
    fn revoke_pending(&self, account: &Arc<Account>) {
        let pending = self.account_connectors.to_revoke();
        if pending.is_empty() {
            return;
        }
        let Ok(platform) = self.session_platform(account) else {
            return;
        };
        let left: BTreeSet<String> = pending
            .into_iter()
            .filter(|id| platform.revoke_key(id).is_err())
            .collect();
        self.account_connectors.set_to_revoke(&left);
    }

    fn later(&self, id: &str) {
        let mut pending = self.account_connectors.to_revoke();
        pending.insert(id.to_owned());
        self.account_connectors.set_to_revoke(&pending);
    }

    fn now_ms(&self) -> u64 {
        self.clock
            .now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
    }
}
