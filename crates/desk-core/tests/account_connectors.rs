//! account.connectors.* (ADR 0407): the desk's own key for the endue account's connectors, against
//! the in-process fake platform and an in-memory keychain. Nothing is sent before the person turns
//! it on; the key is read only until publishing asks for more, lives in the keychain alone, and is
//! revoked and forgotten when it is turned off or the desk signs out.

mod support;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use desk_bridge::ErrorCode;
use desk_core::account::{Account, AccountOptions, Keychain, NetIdClient};
use desk_core::{Core, studio_tokens};
use desk_platform::Platform;
use desk_platform::fake::FakePlatform;
use desk_sys::keychain::fake::FakeKeychain;
use serde_json::{Value, json};
use support::*;

struct Desk {
    core: Core,
    home: PathBuf,
}

fn account(home: &Path, fake: &FakePlatform) -> Arc<Account> {
    let dir = home.join("data");
    fs::create_dir_all(&dir).unwrap();
    let file = dir.join("account.json");
    if !file.exists() {
        let saved = json!({ "version": 2, "note": "test", "accessToken": "token-1",
            "refreshCookie": "rt-1", "issuedAt": 1_767_225_300_u64, "expiresAt": 4_102_444_800_u64 });
        fs::write(&file, saved.to_string()).unwrap();
    }
    let mut options = AccountOptions::new(fake.url(), "http://127.0.0.1:9");
    options.file = Some(file);
    options.retry = vec![Duration::from_millis(5); 3];
    Account::open(options, NetIdClient)
}

/// A desk signed in to `fake`, keeping its key in `keychain` (none: no keychain at all).
fn desk_at(home: &Path, fake: &FakePlatform, keychain: Option<&Arc<FakeKeychain>>) -> Desk {
    let account = account(home, fake);
    let platform = Platform::new(fake.url(), studio_tokens(&account)).unwrap();
    let mut core = Core::new(roots(home))
        .with_account(account)
        .with_platform(platform);
    if let Some(keychain) = keychain {
        core = core.with_account_connectors(Some(Arc::clone(keychain) as Arc<dyn Keychain>));
    }
    grant(&core, "desk", json!({ "permission": "account:manage" }));
    Desk {
        core,
        home: home.to_path_buf(),
    }
}

fn desk(tag: &str, fake: &FakePlatform, keychain: &Arc<FakeKeychain>) -> Desk {
    desk_at(&home(tag), fake, Some(keychain))
}

fn ask(desk: &Desk, method: &str, mut params: Value) -> Result<Value, desk_bridge::BridgeError> {
    params["scope"] = json!({ "permission": "account:manage" });
    call(&desk.core, "desk", method, params)
}

fn enable(desk: &Desk, allow: &[&str]) -> Value {
    let params = if allow.is_empty() {
        json!({})
    } else {
        json!({ "allow": allow })
    };
    ask(desk, "account.connectors.enable", params).unwrap()
}

fn status(desk: &Desk) -> Value {
    ask(desk, "account.connectors.status", json!({})).unwrap()
}

/// The key the keychain keeps, as JSON.
fn kept(keychain: &FakeKeychain) -> Option<Value> {
    let text = keychain.secrets().get("endue-connectors")?.clone();
    Some(serde_json::from_str(&text).unwrap())
}

/// Every file under `dir`, read as bytes.
fn files(dir: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    let mut out = Vec::new();
    for entry in fs::read_dir(dir).unwrap().flatten() {
        let path = entry.path();
        if path.is_dir() {
            out.extend(files(&path));
        } else if let Ok(bytes) = fs::read(&path) {
            out.push((path, bytes));
        }
    }
    out
}

fn connector_calls(fake: &FakePlatform) -> usize {
    fake.seen()
        .iter()
        .filter(|s| s.path.starts_with("/api/public/v1/connectors"))
        .count()
}

#[test]
fn nothing_is_sent_without_consent() {
    let fake = FakePlatform::start();
    let keychain = Arc::new(FakeKeychain::new());
    let desk = desk("connectors-consent", &fake, &keychain);

    let stranger = call(
        &desk.core,
        "endue.notes",
        "account.connectors.status",
        json!({ "scope": { "permission": "account:manage" } }),
    );
    assert_eq!(stranger.unwrap_err().code, ErrorCode::PermissionDenied);

    let now = status(&desk);
    assert_eq!(now["enabled"], false);
    assert_eq!(now["may"], json!([]));
    assert_eq!(now["connectors"], json!([]));
    let disabled = ask(&desk, "account.connectors.disable", json!({})).unwrap();
    assert_eq!(disabled["enabled"], false);
    assert!(fake.seen().is_empty(), "nothing reached endue");
    assert!(keychain.secrets().is_empty());

    // Without a keychain the desk says it cannot, and still sends nothing.
    let bare = desk_at(&home("connectors-no-keychain"), &fake, None);
    let refused = ask(&bare, "account.connectors.enable", json!({})).unwrap_err();
    assert_eq!(refused.code, ErrorCode::Unsupported);
    assert!(refused.message.contains("keychain"), "{}", refused.message);
    assert!(
        status(&bare)["problem"]
            .as_str()
            .unwrap()
            .contains("keychain")
    );
    assert!(fake.seen().is_empty());
}

#[test]
fn enable_makes_a_read_key_kept_only_in_the_keychain() {
    let fake = FakePlatform::start();
    fake.state()
        .connectors
        .add("instagram", "@ada.studio", &["read", "send", "destructive"]);
    let keychain = Arc::new(FakeKeychain::new());
    let desk = desk("connectors-enable", &fake, &keychain);

    let on = enable(&desk, &[]);
    assert_eq!(on["enabled"], true);
    assert_eq!(on["may"], json!(["read"]));
    assert!(
        on["keyName"]
            .as_str()
            .unwrap()
            .starts_with("endue Desk on ")
    );
    assert!(on["createdAt"].as_u64().unwrap() > 0);
    assert_eq!(on["connectors"][0]["type"], "instagram");
    assert_eq!(on["connectors"][0]["title"], "@ada.studio");
    assert_eq!(on["connectors"][0]["state"], "active");
    assert_eq!(on["connectors"][0]["tools"], 3);
    assert!(on["connectors"][0].get("reconnectUrl").is_none());

    // endue made a read key with the session.
    let made = fake.seen_at("POST", "/api/v1/me/api-keys");
    assert_eq!(made.len(), 1);
    assert_eq!(made[0].headers["authorization"], "Bearer token-1");
    assert_eq!(made[0].body["scopes"], json!(["connectors:read"]));

    // The keychain alone keeps its secret; no file, no answer and no request header but the
    // connector API's carries it.
    let key = kept(&keychain).expect("the keychain keeps the key");
    let secret = key["secret"].as_str().unwrap().to_owned();
    assert_eq!(key["id"], "key_1");
    assert!(!on.to_string().contains(&secret));
    assert!(!status(&desk).to_string().contains(&secret));
    for (path, bytes) in files(&desk.home) {
        let text = String::from_utf8_lossy(&bytes);
        assert!(!text.contains(&secret), "{} holds the key", path.display());
    }
    for seen in fake.seen() {
        let bearer = &seen.headers["authorization"];
        if seen.path.starts_with("/api/public/v1/connectors") {
            assert_eq!(*bearer, format!("Bearer {secret}"), "{}", seen.path);
        } else {
            assert_eq!(bearer, "Bearer token-1", "{}", seen.path);
        }
    }
}

#[test]
fn publishing_widens_the_key_by_replacing_it() {
    let fake = FakePlatform::start();
    fake.state()
        .connectors
        .add("threads", "@ada", &["read", "send"]);
    let keychain = Arc::new(FakeKeychain::new());
    let desk = desk("connectors-widen", &fake, &keychain);
    enable(&desk, &[]);

    let wider = enable(&desk, &["publish"]);
    assert_eq!(wider["may"], json!(["read", "publish"]));
    let made = fake.seen_at("POST", "/api/v1/me/api-keys");
    assert_eq!(made.len(), 2);
    assert_eq!(
        made[1].body["scopes"],
        json!(["connectors:read", "connectors:send"])
    );
    assert_eq!(kept(&keychain).unwrap()["id"], "key_2");
    // The old key went only after the new one was kept.
    assert_eq!(fake.seen_at("DELETE", "/api/v1/me/api-keys/key_1").len(), 1);
    let live: Vec<String> = fake
        .state()
        .connectors
        .live_keys()
        .iter()
        .map(|k| k.id.clone())
        .collect();
    assert_eq!(live, ["key_2"]);

    // A key that already may publish is kept; delete widens it again and keeps publish.
    enable(&desk, &["publish"]);
    assert_eq!(fake.seen_at("POST", "/api/v1/me/api-keys").len(), 2);
    let widest = enable(&desk, &["delete"]);
    assert_eq!(widest["may"], json!(["read", "publish", "delete"]));
    assert_eq!(kept(&keychain).unwrap()["id"], "key_3");
}

#[test]
fn turning_off_and_signing_out_revoke_and_forget_the_key() {
    let fake = FakePlatform::start();
    let keychain = Arc::new(FakeKeychain::new());
    let desk = desk("connectors-off", &fake, &keychain);
    enable(&desk, &[]);

    let off = ask(&desk, "account.connectors.disable", json!({})).unwrap();
    assert_eq!(off["enabled"], false);
    assert!(off.get("problem").is_none(), "{off}");
    assert!(keychain.secrets().is_empty(), "the keychain forgot it");
    assert!(fake.state().connectors.live_keys().is_empty());

    enable(&desk, &[]);
    assert_eq!(kept(&keychain).unwrap()["id"], "key_2");
    ask(&desk, "account.signOut", json!({})).unwrap();
    let revoked = fake.seen_at("DELETE", "/api/v1/me/api-keys/key_2");
    assert_eq!(revoked[0].headers["authorization"], "Bearer token-1");
    assert!(keychain.secrets().is_empty());
    assert!(fake.state().connectors.live_keys().is_empty());
}

#[test]
fn an_unreachable_revoke_is_said_and_retried_at_the_next_start() {
    let fake = FakePlatform::start();
    let keychain = Arc::new(FakeKeychain::new());
    let home = home("connectors-later");
    let desk = desk_at(&home, &fake, Some(&keychain));
    enable(&desk, &[]);

    let path = "/api/v1/me/api-keys/key_1";
    fake.state()
        .fail_at(path, 503, "SERVICE_UNAVAILABLE", "try later");
    let off = ask(&desk, "account.connectors.disable", json!({})).unwrap();
    assert_eq!(off["enabled"], false);
    assert!(
        off["problem"].as_str().unwrap().contains("next time"),
        "{off}"
    );
    assert!(kept(&keychain).is_none(), "the key itself is forgotten");
    assert!(keychain.secrets().contains_key("endue-connectors-revoke"));
    assert_eq!(fake.state().connectors.live_keys().len(), 1);

    // The next start revokes it, once endue answers.
    fake.state().fail_at.clear();
    let next = desk_at(&home, &fake, Some(&keychain));
    next.core.settle_account_connectors();
    assert!(fake.state().connectors.live_keys().is_empty());
    assert!(keychain.secrets().is_empty());
}

#[test]
fn a_refused_key_is_forgotten_once() {
    let fake = FakePlatform::start();
    fake.state().connectors.add("bluesky", "@ada", &["read"]);
    let keychain = Arc::new(FakeKeychain::new());
    let desk = desk("connectors-refused", &fake, &keychain);
    enable(&desk, &[]);
    let before = connector_calls(&fake);

    // Revoked on endue.ai: the next status hears 401 and forgets the key, without retrying.
    fake.state().connectors.keys[0].revoked = true;
    let now = status(&desk);
    assert_eq!(now["enabled"], false);
    assert!(
        now["problem"]
            .as_str()
            .unwrap()
            .contains("no longer accepts"),
        "{now}"
    );
    assert!(keychain.secrets().is_empty());
    assert_eq!(connector_calls(&fake), before + 1);

    let again = status(&desk);
    assert_eq!(again["enabled"], false);
    assert!(again.get("problem").is_none());
    assert_eq!(connector_calls(&fake), before + 1, "nothing more is sent");
}

#[test]
fn expired_connectors_point_to_the_page_that_reconnects_them() {
    let fake = FakePlatform::start();
    {
        let mut state = fake.state();
        state.connectors.add("instagram", "@ada.studio", &["read"]);
        state.connectors.add("threads", "@ada", &["read"]);
        state.connectors.connectors[1].expired = true;
    }
    let keychain = Arc::new(FakeKeychain::new());
    let desk = desk("connectors-expired", &fake, &keychain);

    let on = enable(&desk, &[]);
    let connectors = on["connectors"].as_array().unwrap();
    assert_eq!(connectors.len(), 2);
    assert!(connectors[0].get("reconnectUrl").is_none());
    assert_eq!(connectors[1]["state"], "expired");
    // A platform that is not one of endue's points to endue.ai's own page.
    assert_eq!(
        connectors[1]["reconnectUrl"],
        "https://endue.ai/resources/connectors"
    );
}
