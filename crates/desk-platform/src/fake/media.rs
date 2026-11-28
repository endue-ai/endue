//! The fake's media uploads (`POST /api/public/v1/connectors/media`), answered as endue AI answers
//! them: the raw bytes of a picture or a video with their `Content-Type` and `Content-Length`, kept
//! for a publish to name by `media_id`. 411 without a length, 415 for another type, 413 over the
//! size; a tool call naming a `media_id` it never made is refused `invalid`.

use serde_json::{Value, json};

use super::routes::{Answer, error};
use super::{Seen, State};

/// The largest picture and video endue AI takes.
pub const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
pub const MAX_VIDEO_BYTES: usize = 50 * 1024 * 1024;
const IMAGES: [&str; 4] = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const VIDEOS: [&str; 2] = ["video/mp4", "video/quicktime"];

/// One file the fake kept.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FakeUpload {
    pub media_id: String,
    pub mime: String,
    pub bytes: Vec<u8>,
}

pub(super) fn upload(state: &mut State, seen: &Seen) -> Answer {
    let Some(length) = seen.headers.get("content-length") else {
        return error(411, "LENGTH_REQUIRED", "Content-Length is required");
    };
    if length.parse::<usize>().ok() != Some(seen.raw.len()) {
        return error(
            400,
            "VALIDATION_ERROR",
            "Content-Length does not match the body",
        );
    }
    let mime = seen
        .headers
        .get("content-type")
        .map(|t| {
            t.split(';')
                .next()
                .unwrap_or_default()
                .trim()
                .to_ascii_lowercase()
        })
        .unwrap_or_default();
    let max = if IMAGES.contains(&mime.as_str()) {
        MAX_IMAGE_BYTES
    } else if VIDEOS.contains(&mime.as_str()) {
        MAX_VIDEO_BYTES
    } else {
        return error(
            415,
            "UNSUPPORTED_MEDIA_TYPE",
            "This type of file cannot be posted",
        );
    };
    if seen.raw.len() > max {
        return error(413, "PAYLOAD_TOO_LARGE", "The file is too large");
    }
    let uploads = &mut state.connectors.uploads;
    let media_id = format!("cm_{:032x}", uploads.len() + 1);
    uploads.push(FakeUpload {
        media_id: media_id.clone(),
        mime: mime.clone(),
        bytes: seen.raw.clone(),
    });
    let body = json!({
        "media_id": media_id,
        "mime": mime,
        "size": seen.raw.len(),
        // Not a digest: the fake only says which upload it was.
        "sha256": format!("{:064x}", uploads.len()),
        "expires_at": "2026-12-01T00:00:00Z",
    });
    (201, Some(json!({ "success": true, "data": body })))
}

/// The tool's refusal when its `media` names an id the fake never made, as endue AI refuses it.
pub(super) fn unknown_media(state: &State, arguments: &Value) -> Option<Value> {
    let media = arguments["media"].as_array()?;
    let unknown = media
        .iter()
        .filter_map(|m| m["media_id"].as_str())
        .find(|id| !state.connectors.uploads.iter().any(|u| u.media_id == *id))?;
    Some(json!({
        "ok": false,
        "content": format!("No media {unknown}"),
        "error": { "reason": "invalid", "message": format!("No media {unknown}: upload it again.") },
    }))
}
