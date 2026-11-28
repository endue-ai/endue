//! audio.capture.start with `transcribe` (FT-02, ADR 0406) over a fake input and a scripted
//! recogniser (`desk_sys::speech::fake`), so no test opens a microphone or a real recogniser: the
//! caller alone hears `audio.heard`, the words so far and then the final words before `audio.ended`;
//! without a recogniser for the language nothing opens; and every end stops the recogniser too.

mod support;

use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::sync::mpsc::Receiver;

use desk_bridge::{BridgeError, ErrorCode, PluginStatus};
use desk_core::{Core, Delivery};
use desk_sys::audio::fake::FakeInput;
use desk_sys::audio::{Authorization, InputDevice};
use desk_sys::speech::fake::FakeRecogniser;
use desk_sys::{Error, ErrorCode as SysCode};
use serde_json::{Value, json};
use support::{Seen, call, drain, grant, home, plugin_manage, roots, set_enabled, wait_for};

const MIC: &str = "fake:mic";
const HELLO: &str = "example.hello";
const OTHER: &str = "example.other";
/// One 20 ms frame at 16 kHz.
const FRAME: usize = 320;

fn scope() -> Value {
    json!({ "permission": "audio:capture" })
}

fn fake_mic() -> FakeInput {
    FakeInput::new().with_devices(vec![InputDevice {
        id: MIC.to_owned(),
        name: "Fake mic".to_owned(),
        default: true,
        sample_rate: 16_000,
        channels: 1,
    }])
}

fn install(core: &Core, home: &Path, id: &str) {
    let dir = home.join("plugins").join(id);
    fs::create_dir_all(dir.join("ui")).unwrap();
    fs::write(dir.join("ui/index.html"), "<p>hello</p>").unwrap();
    let manifest = json!({
        "id": id, "version": "0.1.0", "kind": "ui", "entry": "ui/index.html",
        "surfaces": [{ "id": "main", "placement": "center" }],
        "permissions": [{ "permission": "audio:capture" }, { "permission": "ui:surface" }],
    });
    fs::write(dir.join("plugin.json"), manifest.to_string()).unwrap();
    let info = core.install_plugin(&dir, false);
    assert_eq!(info.status, PluginStatus::Ready, "{:?}", info.error);
}

fn core_with(input: &Arc<FakeInput>, words: Option<&Arc<FakeRecogniser>>) -> Core {
    let home = home("audio-words");
    let mut core = Core::new(roots(&home)).with_audio(input.clone());
    if let Some(words) = words {
        core = core.with_speech(words.clone());
    }
    install(&core, &home, HELLO);
    install(&core, &home, OTHER);
    grant(&core, HELLO, scope());
    core
}

fn start(core: &Core, lang: &str) -> Result<String, BridgeError> {
    let params = json!({ "scope": scope(), "transcribe": { "lang": lang } });
    call(core, HELLO, "audio.capture.start", params)
        .map(|started| started["captureId"].as_str().unwrap().to_owned())
}

fn stop(core: &Core, caller: &str, capture: &str) {
    let params = json!({ "captureId": capture, "scope": scope() });
    call(core, caller, "audio.capture.stop", params).unwrap();
}

fn frames(input: &FakeInput, n: usize) {
    input.push(MIC, &vec![0.25; FRAME * n]);
}

fn ended(deliveries: &Receiver<Delivery>, capture: &str) -> Seen {
    loop {
        let seen = wait_for(deliveries, "audio.ended");
        if seen.data()["captureId"] == capture {
            return seen;
        }
    }
}

#[test]
fn a_capture_that_transcribes_sends_its_caller_what_it_heard() {
    let input = Arc::new(fake_mic());
    let words = Arc::new(FakeRecogniser::new().with_script(&[(2, "what"), (4, "what time is it")]));
    let core = core_with(&input, Some(&words));
    let deliveries = core.events().subscribe_addressed();
    let capture = start(&core, "en").unwrap();
    frames(&input, 5);
    stop(&core, HELLO, &capture);

    let seen = drain(&deliveries);
    let heard: Vec<&Seen> = seen.iter().filter(|s| s.name() == "audio.heard").collect();
    let said: Vec<(String, bool)> = heard
        .iter()
        .map(|s| {
            let data = s.data();
            assert_eq!(data["captureId"], capture);
            assert_eq!(
                s.to,
                Some(vec![HELLO.to_owned()]),
                "only the caller hears it"
            );
            (
                data["text"].as_str().unwrap().to_owned(),
                data["final"].as_bool().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        said,
        [
            ("what".to_owned(), false),
            ("what time is it".to_owned(), false),
            ("what time is it".to_owned(), true),
        ]
    );
    let names: Vec<&str> = seen.iter().map(Seen::name).collect();
    let last_heard = names.iter().rposition(|n| *n == "audio.heard").unwrap();
    let end = names.iter().position(|n| *n == "audio.ended").unwrap();
    assert!(
        last_heard < end,
        "the final words come before the end: {names:?}"
    );
    assert_eq!(words.running(), 0);
}

#[test]
fn transcribe_without_a_recogniser_is_unsupported_and_the_capture_does_not_start() {
    let input = Arc::new(fake_mic());
    let core = core_with(&input, None);
    let refused = start(&core, "en").unwrap_err();
    assert_eq!(refused.code, ErrorCode::Unsupported, "{refused:?}");
    assert_eq!(input.captures_opened(MIC), 0, "no microphone opens");

    let english_only = Arc::new(FakeRecogniser::new().with_langs(&["en"]));
    let core = core_with(&input, Some(&english_only));
    let refused = start(&core, "ko").unwrap_err();
    assert_eq!(refused.code, ErrorCode::Unsupported, "{refused:?}");
    assert_eq!(input.captures_opened(MIC), 0);
    assert_eq!(english_only.started(), 0);
}

#[test]
fn an_os_that_refuses_recognition_is_forbidden_and_opens_nothing() {
    let input = Arc::new(fake_mic());
    let words = Arc::new(
        FakeRecogniser::new()
            .with_authorization(Authorization::NotDetermined)
            .with_answer(Authorization::Denied),
    );
    let core = core_with(&input, Some(&words));
    let refused = start(&core, "en").unwrap_err();
    assert_eq!(refused.code, ErrorCode::Forbidden, "{refused:?}");
    assert_eq!(input.captures_opened(MIC), 0);
    assert_eq!(words.started(), 0);
}

#[test]
fn stopping_a_capture_ends_its_recogniser() {
    let words = Arc::new(FakeRecogniser::new().with_script(&[(1, "hello")]));
    let check = |core: &Core, deliveries: &Receiver<Delivery>, capture: &str, reason: &str| {
        let end = ended(deliveries, capture);
        assert_eq!(end.data()["reason"], reason);
        assert_eq!(words.running(), 0, "{reason}: the recogniser ended with it");
        assert_eq!(core.capture_count(), 0);
    };

    // The caller stops it, and the runtime stops it for the person.
    for (caller, reason) in [(HELLO, "stopped"), ("desk", "stopped_by_person")] {
        let input = Arc::new(fake_mic());
        let core = core_with(&input, Some(&words));
        grant(&core, "desk", scope());
        let deliveries = core.events().subscribe_addressed();
        let capture = start(&core, "en").unwrap();
        frames(&input, 1);
        assert_eq!(words.running(), 1);
        stop(&core, caller, &capture);
        check(&core, &deliveries, &capture, reason);
    }

    // The plugin stops.
    let input = Arc::new(fake_mic());
    let core = core_with(&input, Some(&words));
    grant(&core, "desk", plugin_manage());
    let deliveries = core.events().subscribe_addressed();
    let capture = start(&core, "en").unwrap();
    set_enabled(&core, HELLO, false);
    check(&core, &deliveries, &capture, "plugin_stopped");

    // Its grant goes.
    let input = Arc::new(fake_mic());
    let home = home("audio-words-revoke");
    let core = Core::new(roots(&home))
        .with_audio(input.clone())
        .with_speech(words.clone());
    install(&core, &home, HELLO);
    let grant_id = grant(&core, HELLO, scope());
    let deliveries = core.events().subscribe_addressed();
    let capture = start(&core, "en").unwrap();
    call(&core, HELLO, "perm.revoke", json!({ "grantId": grant_id })).unwrap();
    check(&core, &deliveries, &capture, "revoked");

    // The caller leaves, its last surface closing.
    let input = Arc::new(fake_mic());
    let core = core_with(&input, Some(&words));
    let deliveries = core.events().subscribe_addressed();
    let capture = start(&core, "en").unwrap();
    core.caller_left(HELLO);
    check(&core, &deliveries, &capture, "plugin_stopped");

    // The device fails.
    let input = Arc::new(fake_mic());
    let core = core_with(&input, Some(&words));
    let deliveries = core.events().subscribe_addressed();
    let capture = start(&core, "en").unwrap();
    input.fail(
        MIC,
        Error::new(SysCode::IoError, "the input device is gone"),
    );
    check(&core, &deliveries, &capture, "device");
}

#[test]
fn a_capture_without_transcribe_hears_no_words() {
    let input = Arc::new(fake_mic());
    let words = Arc::new(FakeRecogniser::new().with_script(&[(1, "hello")]));
    let core = core_with(&input, Some(&words));
    let deliveries = core.events().subscribe_addressed();
    let params = json!({ "scope": scope() });
    let capture = call(&core, HELLO, "audio.capture.start", params).unwrap()["captureId"]
        .as_str()
        .unwrap()
        .to_owned();
    frames(&input, 2);
    stop(&core, HELLO, &capture);
    assert!(drain(&deliveries).iter().all(|s| s.name() != "audio.heard"));
    assert_eq!(words.started(), 0);
}
