//! Publishing to `endue.social` (plugins/social) with what can go wrong on the way: a picture from
//! a file goes up once through the endue account, only when the caller may read it and it is within
//! its size, and without where it was taken unless a person keeps it; an answer lost twice says the
//! post may be up.

mod endue_fixture;
mod layer;

use std::fs;
use std::path::PathBuf;

use desk_platform::fake::FakePlatform;
use endue_fixture::{connector, desk_with, queue, turn_on};
use layer::Desk;
use serde_json::{Value, json};

const TOOLS: [(&str, &str); 3] = [
    ("social_read", "read"),
    ("social_publish", "send"),
    ("social_delete", "destructive"),
];
const PUBLISH: &str = "endue.social.post.publish";

fn ok(data: Value) -> Value {
    json!({ "ok": true, "content": "", "data": data })
}

/// Two accounts of endue.social, Instagram and Reddit, on a desk that synced them once.
fn connected(tag: &str) -> (FakePlatform, Desk, String, String) {
    let fake = FakePlatform::start();
    let ig = connector(&fake, "instagram", "Studio on Instagram", &TOOLS);
    let rd = connector(&fake, "reddit", "Studio on Reddit", &TOOLS);
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../plugins/social/plugin.json");
    let manifest: Value = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
    let desk = desk_with(tag, &fake, "social", &manifest);
    turn_on(&desk);
    desk.tick();
    (fake, desk, ig, rd)
}

fn invoke(desk: &Desk, id: &str, args: Value) -> Value {
    let scope = json!({ "permission": "cmd:invoke", "ids": [id] });
    desk.grant("desk", scope.clone());
    let started = desk.ok(
        "desk",
        "cmd.invoke",
        json!({ "id": id, "args": args, "scope": scope }),
    );
    loop {
        let (_, data) = desk.wait_for("cmd.answered");
        if data["invocationId"] == started["invocationId"] {
            return data;
        }
    }
}

/// A JPEG whose EXIF holds where it was taken: IFD0 points to a GPS IFD with a latitude.
fn located_jpeg() -> Vec<u8> {
    let mut tiff = b"MM\0\x2a\0\0\0\x08\0\x01".to_vec();
    tiff.extend([0x88, 0x25, 0, 4, 0, 0, 0, 1, 0, 0, 0, 26, 0, 0, 0, 0]);
    tiff.extend([0, 1, 0, 2, 0, 5, 0, 0, 0, 1, 0, 0, 0, 44, 0, 0, 0, 0]);
    tiff.extend([0, 0, 0, 37, 0, 0, 0, 1]);
    let mut out = vec![0xFF, 0xD8, 0xFF, 0xE1];
    out.extend(u16::try_from(tiff.len() + 8).unwrap().to_be_bytes());
    out.extend(b"Exif\0\0");
    out.extend(tiff);
    out.extend([0xFF, 0xDA, 0, 2, 1, 2, 0xFF, 0xD9]);
    out
}

#[test]
fn a_picture_from_a_file_goes_up_once_without_where_it_was_taken() {
    let (fake, desk, ig, rd) = connected("endue-social-media");
    fs::write(desk.home.join("jacket.jpg"), located_jpeg()).unwrap();
    fs::write(desk.home.join("notes.pdf"), b"%PDF-1.7").unwrap();
    let publish = PUBLISH;
    let done = |id: &str| vec![ok(json!({ "id": id, "status": "published" }))];
    queue(&fake, &ig, "instagram__social_publish", done("18040"));
    queue(&fake, &rd, "reddit__social_publish", done("t3_n"));
    let media = json!([{ "path": "~/jacket.jpg", "alt": "A green jacket" }]);
    let args = |instance: &str| json!({ "instance": instance, "text": "Autumn", "media": media });

    let refused = invoke(&desk, publish, args(&ig));
    assert_eq!(
        refused["ok"], false,
        "a file the caller may not read: {refused}"
    );
    assert!(
        fake.state().connectors.uploads.is_empty(),
        "nothing went up"
    );

    desk.grant("desk", json!({ "permission": "fs:read", "paths": ["~/*"] }));
    for instance in [&ig, &rd] {
        let answered = invoke(&desk, publish, args(instance));
        assert_eq!(answered["ok"], true, "{answered}");
    }
    let uploads = fake.state().connectors.uploads.clone();
    assert_eq!(uploads.len(), 1, "one upload serves both accounts");
    assert_eq!(uploads[0].mime, "image/jpeg");
    assert!(
        !uploads[0].bytes.windows(2).any(|w| w == [0x88, 0x25]),
        "the GPS pointer is gone"
    );
    assert!(
        uploads[0]
            .bytes
            .ends_with(&[0xFF, 0xDA, 0, 2, 1, 2, 0xFF, 0xD9])
    );
    let sent = fake.seen_at(
        "POST",
        &format!("/api/public/v1/connectors/{ig}/tools/instagram__social_publish/call"),
    );
    let media_id = uploads[0].media_id.clone();
    assert_eq!(
        sent.last().unwrap().body["arguments"]["media"],
        json!([{ "media_id": media_id, "alt": "A green jacket" }])
    );

    let pdf = json!({ "instance": ig, "media": [{ "path": "~/notes.pdf" }] });
    let answered = invoke(&desk, publish, pdf);
    assert!(
        answered
            .to_string()
            .contains("notes.pdf is not a picture or a video"),
        "{answered}"
    );
    assert_eq!(fake.state().connectors.uploads.len(), 1);
}

#[test]
fn a_picture_too_big_goes_nowhere_and_a_person_may_keep_where_one_was_taken() {
    let (fake, desk, ig, _rd) = connected("endue-social-kept");
    desk.grant("desk", json!({ "permission": "fs:read", "paths": ["~/*"] }));
    fs::write(
        desk.home.join("poster.png"),
        vec![0u8; 10 * 1024 * 1024 + 1],
    )
    .unwrap();
    let big = json!({ "instance": ig, "media": [{ "path": "~/poster.png" }] });
    let answered = invoke(&desk, PUBLISH, big);
    assert!(
        answered
            .to_string()
            .contains("poster.png is 10.1 MB; endue AI takes a picture up to 10.0 MB"),
        "{answered}"
    );
    assert!(fake.state().connectors.uploads.is_empty(), "checked before");

    fs::write(desk.home.join("jacket.jpg"), located_jpeg()).unwrap();
    queue(
        &fake,
        &ig,
        "instagram__social_publish",
        vec![ok(json!({ "id": "18041", "status": "published" }))],
    );
    let kept = json!([{ "path": "~/jacket.jpg", "keepLocation": true }]);
    let answered = invoke(&desk, PUBLISH, json!({ "instance": ig, "media": kept }));
    assert_eq!(answered["ok"], true, "{answered}");
    let uploads = fake.state().connectors.uploads.clone();
    assert_eq!(
        uploads[0].bytes,
        located_jpeg(),
        "the person kept it as it was"
    );
}

#[test]
fn an_answer_lost_twice_says_the_post_may_be_up() {
    let (fake, desk, ig, _rd) = connected("endue-social-lost");
    fake.state().connectors.lost = 2;
    let answered = invoke(&desk, PUBLISH, json!({ "instance": ig, "text": "Autumn" }));
    assert_eq!(answered["ok"], false, "{answered}");
    assert!(
        answered.to_string().contains("it may have gone through"),
        "{answered}"
    );
    let sent = fake.seen_at(
        "POST",
        &format!("/api/public/v1/connectors/{ig}/tools/instagram__social_publish/call"),
    );
    assert_eq!(sent.len(), 2, "tried once more, with the same key");
    assert_eq!(
        sent[0].headers["idempotency-key"],
        sent[1].headers["idempotency-key"]
    );
}
