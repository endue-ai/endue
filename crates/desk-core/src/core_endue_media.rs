//! The files an endue action sends (specs/connector/v0 README, endue binding, `{ file }`). A
//! `{ file }` argument holds a path, or objects with `path`: each file the caller may read is checked
//! (a picture or a video endue AI takes, within its size), its location taken out unless a person's
//! plugin keeps it, uploaded with the desk's key and named by the `media_id` endue AI answers. The
//! same bytes are uploaded once while their id has an hour left, so one picture published to several
//! accounts goes up once.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, SystemTime};

use desk_bridge::{EndueAction, EndueActionArgument, FsReadPermission, Permission};
use desk_platform::Connectors;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::agents::agent_of;
use crate::handler::Core;

const IMAGE_MAX: u64 = 10 * 1024 * 1024;
const VIDEO_MAX: u64 = 50 * 1024 * 1024;
/// endue AI keeps an upload a day: one with less than an hour left is not named again.
const REUSE: Duration = Duration::from_secs(23 * 60 * 60);
/// One upload at a time, so the invocations of one publish to several accounts upload a file once.
static UPLOADING: Mutex<()> = Mutex::new(());

/// The desk's uploads by their type and SHA-256: the `media_id` and when it was made.
#[derive(Default)]
pub(crate) struct Uploaded(BTreeMap<String, (String, SystemTime)>);

/// The type endue AI takes for a file, by its extension, and its largest size.
fn kind_of(file: &Path) -> Option<(&'static str, u64)> {
    let extension = file.extension()?.to_str()?.to_ascii_lowercase();
    Some(match extension.as_str() {
        "jpg" | "jpeg" => ("image/jpeg", IMAGE_MAX),
        "png" => ("image/png", IMAGE_MAX),
        "webp" => ("image/webp", IMAGE_MAX),
        "gif" => ("image/gif", IMAGE_MAX),
        "mp4" | "m4v" => ("video/mp4", VIDEO_MAX),
        "mov" => ("video/quicktime", VIDEO_MAX),
        _ => return None,
    })
}

fn megabytes(bytes: u64) -> String {
    let tenths = (bytes * 10).div_ceil(1024 * 1024);
    format!("{}.{} MB", tenths / 10, tenths % 10)
}

impl Core {
    /// Upload the files the action's `{ file }` arguments name and put their `media_id` in place.
    pub(crate) fn endue_files(
        &self,
        caller: &str,
        action: &EndueAction,
        arguments: &mut Map<String, Value>,
        connectors: &Connectors,
    ) -> Result<(), String> {
        for (name, argument) in action.arguments.iter().flatten() {
            if !matches!(argument, EndueActionArgument::EndueFile(_)) {
                continue;
            }
            let Some(value) = arguments.get_mut(name) else {
                continue;
            };
            *value = match value.take() {
                Value::String(path) => {
                    Value::String(self.endue_upload(caller, &path, false, connectors)?)
                }
                Value::Array(items) => Value::Array(
                    items
                        .into_iter()
                        .map(|item| self.endue_item(caller, item, connectors))
                        .collect::<Result<_, _>>()?,
                ),
                item @ Value::Object(_) => self.endue_item(caller, item, connectors)?,
                _ => return Err(format!("{name} must name a file.")),
            };
        }
        Ok(())
    }

    /// One `{ path, alt?, keepLocation? }` item as `{ media_id, alt? }`; one without `path` as it is.
    fn endue_item(
        &self,
        caller: &str,
        item: Value,
        connectors: &Connectors,
    ) -> Result<Value, String> {
        let Value::Object(mut item) = item else {
            return Err("Each medium is an object with a path or a url.".into());
        };
        let keep = item.remove("keepLocation").and_then(|k| k.as_bool()) == Some(true);
        if let Some(path) = item.remove("path") {
            let path = path.as_str().ok_or("A medium's path is text.")?;
            let id = self.endue_upload(caller, path, keep, connectors)?;
            item.insert("media_id".to_owned(), Value::String(id));
        }
        Ok(Value::Object(item))
    }

    /// The `media_id` of the file at `path`, uploaded unless the same bytes went up lately. Only a
    /// person's plugin keeps the location: an agent's never does.
    fn endue_upload(
        &self,
        caller: &str,
        path: &str,
        keep: bool,
        connectors: &Connectors,
    ) -> Result<String, String> {
        let scope = Permission::FsRead(FsReadPermission {
            permission: Default::default(),
            paths: vec![path.to_owned()],
        });
        let file = self
            .authorize(caller, &scope, path)
            .map_err(|e| e.message)?;
        let name = file
            .file_name()
            .map_or_else(|| path.to_owned(), |n| n.to_string_lossy().into_owned());
        let (mime, max) = kind_of(&file).ok_or_else(|| {
            format!("{name} is not a picture or a video endue AI takes: JPEG, PNG, WebP, GIF, MP4 or QuickTime.")
        })?;
        let size = std::fs::metadata(&file)
            .map_err(|e| format!("{name} cannot be read: {e}"))?
            .len();
        if size > max {
            let what = if max == IMAGE_MAX { "picture" } else { "video" };
            return Err(format!(
                "{name} is {}; endue AI takes a {what} up to {}.",
                megabytes(size),
                megabytes(max)
            ));
        }
        let mut bytes = std::fs::read(&file).map_err(|e| format!("{name} cannot be read: {e}"))?;
        if !keep || agent_of(caller).is_some() {
            bytes = crate::exif_location::without_location(bytes, mime);
        }
        let digest: String = Sha256::digest(&bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        let key = format!("{mime} {digest}");
        let _one = UPLOADING.lock().unwrap_or_else(PoisonError::into_inner);
        let now = self.clock.now();
        let lately = |at: &SystemTime| now.duration_since(*at).is_ok_and(|age| age < REUSE);
        if let Some((id, _)) = self.endue().1.0.get(&key).filter(|(_, at)| lately(at)) {
            return Ok(id.clone());
        }
        let uploaded = connectors
            .upload_media(bytes, mime)
            .map_err(|e| format!("{name} was not uploaded: {}", self.endue_call_failed(e)))?
            .value;
        self.endue()
            .1
            .0
            .insert(key, (uploaded.media_id.clone(), now));
        Ok(uploaded.media_id)
    }
}
