//! A record mapped into an item by a binding's maps (specs/connector/v0 `HttpItemMap`, ADR 0106 and
//! ADR 0408): pointers, shaped reads, constants, objects of values, the instance's values and the
//! first of several. The http and endue bindings share it.

use desk_bridge::{HttpInstanceField, HttpItemMap, HttpRead, HttpValue, Item, ItemSource};
use serde_json::{Map, Value};

/// The instance a record came from, for the `{ instance }` values of a map.
#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct Here<'a> {
    pub(crate) id: &'a str,
    pub(crate) title: Option<&'a str>,
    /// The endue account connector's type; none for the other bindings.
    pub(crate) kind: Option<&'a str>,
    /// When this sync began (RFC 3339).
    pub(crate) synced_at: &'a str,
}

/// The record's item, keyed by its id, or none when it does not fit specs/item/v0.
pub(crate) fn item_of(
    map: &HttpItemMap,
    record: &Value,
    source: &ItemSource,
    here: &Here<'_>,
) -> Option<(String, Item)> {
    let mut item = Map::new();
    for (field, value) in &map.fields {
        if let Some(found) = read(record, value, here) {
            item.insert(field.clone(), found);
        }
    }
    item.insert("kind".into(), serde_json::to_value(map.kind).ok()?);
    item.insert("source".into(), serde_json::to_value(source).ok()?);
    let id = item.get("id")?.as_str()?.to_owned();
    let item = serde_json::from_value::<Item>(Value::Object(item)).ok()?;
    Some((id, item))
}

/// One field's value from the record: none for null or missing, unless a default gives one.
fn read(record: &Value, value: &HttpValue, here: &Here<'_>) -> Option<Value> {
    match value {
        HttpValue::JsonPointer(at) => pointer(record, at).filter(|v| !v.is_null()).cloned(),
        HttpValue::HttpConst(constant) => Some(constant.r#const.clone()),
        HttpValue::HttpRead(rule) => shaped(record, rule).or_else(|| rule.default.clone()),
        HttpValue::HttpObject(object) => {
            let kept: Map<String, Value> = object
                .object
                .iter()
                .filter_map(|(name, value)| Some((name.clone(), read(record, value, here)?)))
                .collect();
            (!kept.is_empty()).then_some(Value::Object(kept))
        }
        HttpValue::HttpInstance(value) => match value.instance {
            HttpInstanceField::Id => Some(here.id),
            HttpInstanceField::Title => here.title,
            HttpInstanceField::Type => here.kind,
            HttpInstanceField::SyncedAt => Some(here.synced_at),
        }
        .map(|text| Value::String(text.to_owned())),
        HttpValue::HttpFirst(values) => values
            .first
            .iter()
            .filter_map(|value| read(record, value, here))
            .find(|v| v.as_str() != Some("")),
    }
}

fn shaped(record: &Value, rule: &HttpRead) -> Option<Value> {
    let mut found = pointer(record, &rule.pointer)
        .filter(|v| !v.is_null())?
        .clone();
    if let Some(after) = &rule.after {
        let text = found.as_str()?;
        let cut = text.rfind(after.as_str())?;
        found = Value::String(text[cut + after.len()..].to_owned());
    }
    if let Some(before) = &rule.before {
        let text = found.as_str()?;
        let cut = text.find(before.as_str()).unwrap_or(text.len());
        found = Value::String(text[..cut].to_owned());
    }
    if let Some(values) = &rule.values {
        let key = match &found {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        };
        found = values.get(&key)?.clone();
    }
    Some(found)
}

/// RFC 6901: the value at `at` in `value`; the empty pointer is the value itself.
pub(crate) fn pointer<'a>(value: &'a Value, at: &str) -> Option<&'a Value> {
    if at.is_empty() {
        return Some(value);
    }
    value.pointer(at)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_instance_value_reads_the_instance_and_type_is_missing_outside_endue() {
        let value = |v: Value| serde_json::from_value::<HttpValue>(v).unwrap();
        let here = Here {
            id: "work",
            title: Some("Work"),
            kind: None,
            synced_at: "2026-11-29T00:00:00Z",
        };
        let object = value(serde_json::json!({ "object": {
            "id": { "instance": "id" }, "title": { "instance": "title" },
            "type": { "instance": "type" } } }));
        let instance = read(&Value::Null, &object, &here);
        assert_eq!(
            instance,
            Some(serde_json::json!({ "id": "work", "title": "Work" }))
        );
        let first = serde_json::json!({ "first": ["/title", "/text", { "instance": "syncedAt" }] });
        let first = value(first);
        let record = serde_json::json!({ "title": "", "text": "Hello" });
        let hello = Some(Value::String("Hello".into()));
        assert_eq!(
            read(&record, &first, &here),
            hello,
            "the empty text reads nothing"
        );
        let at = Some(Value::String("2026-11-29T00:00:00Z".into()));
        assert_eq!(read(&Value::Null, &first, &here), at);
    }
}
