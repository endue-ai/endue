//! The rules of views and plugin manifests that a JSON Schema cannot say: the names a document uses
//! must resolve inside it. `SCHEMAS` checks shapes; these check names (`specs/view/v0`,
//! `specs/connector/v0`). Every problem starts with the JSON pointer of the value it is about.

use serde_json::Value;

use crate::{EndueRisk, PluginManifest, PluginView, View, ViewNode};

/// Every `$name` source of a binding that is not one of the view's `requires`, and every
/// `{params.<name>}` a template reads that is not one of its `params`, sorted.
pub fn view_problems(view: &View) -> Vec<String> {
    let mut sources = Vec::new();
    let mut templates = vec![("/title".to_owned(), view.title.clone())];
    walk(&view.layout, "/layout", &mut sources, &mut templates);
    let required = |name: &str| view.requires.as_ref().is_some_and(|r| r.contains_key(name));
    let declared = |name: &str| view.params.as_ref().is_some_and(|p| p.contains_key(name));
    let mut problems = Vec::new();
    for (at, source) in sources {
        if let Some(name) = source.strip_prefix('$')
            && !required(name)
        {
            problems.push(format!("{at}: {source} is not one of the view's requires"));
        }
    }
    for (at, text) in templates {
        for name in params_read(&text) {
            if !declared(&name) {
                problems.push(format!(
                    "{at}: {{params.{name}}} reads a param the view does not declare"
                ));
            }
        }
    }
    problems.sort();
    problems
}

/// The problems of an inline item view (under `/view`; a universal view's are the core's), every action of a connector resource that is not
/// a command the plugin declares in `contributes.commands`, and the names an http block uses that
/// do not resolve (`http_names`), and those of an endue block (`endue_problems`), sorted.
pub fn manifest_problems(manifest: &PluginManifest) -> Vec<String> {
    let mut problems: Vec<String> = manifest
        .view
        .iter()
        .filter_map(|view| match view {
            PluginView::View(view) => Some(view),
            PluginView::Universal(_) | PluginView::UniversalPage(_) => None,
        })
        .flat_map(view_problems)
        .map(|problem| format!("/view{problem}"))
        .collect();
    if let Some(connector) = &manifest.connector {
        let commands = manifest
            .contributes
            .as_ref()
            .and_then(|c| c.commands.as_ref());
        let declared = |id: &str| commands.is_some_and(|cs| cs.iter().any(|c| c.id == id));
        for (r, resource) in connector.resources.iter().enumerate() {
            for (a, id) in resource.actions.iter().flatten().enumerate() {
                if !declared(id) {
                    problems.push(format!(
                        "/connector/resources/{r}/actions/{a}: {id} is not in contributes.commands"
                    ));
                }
            }
        }
        problems.extend(crate::http_names::http_problems(connector));
        problems.extend(endue_problems(manifest));
    }
    problems.sort();
    problems
}

/// The names an endue block (specs/connector/v0 `EndueBinding`, ADR 0409) uses that do not resolve:
/// each tool a request or action names is one of its tools, each request's map one of its maps, each
/// map makes a kind the connector lists with an id and a title, each action is a command the plugin
/// declares, and an action on a send or destructive tool is an irreversible command.
fn endue_problems(manifest: &PluginManifest) -> Vec<String> {
    let Some(connector) = &manifest.connector else {
        return Vec::new();
    };
    let Some(endue) = &connector.endue else {
        return Vec::new();
    };
    let at = "/connector/endue";
    let mut problems = Vec::new();
    let tool = |name: &str, here: String, problems: &mut Vec<String>| {
        if !endue.tools.iter().any(|t| t == name) {
            problems.push(format!(
                "{here}: {name} is not one of the endue block's tools"
            ));
        }
    };
    for (r, request) in endue.requests.iter().enumerate() {
        tool(
            &request.tool,
            format!("{at}/requests/{r}/tool"),
            &mut problems,
        );
        if !endue.maps.contains_key(&request.map) {
            let map = &request.map;
            problems.push(format!(
                "{at}/requests/{r}/map: {map} is not one of the endue block's maps"
            ));
        }
    }
    for (name, map) in &endue.maps {
        if !connector.resources.iter().any(|r| r.kind == map.kind) {
            let kind = serde_json::to_value(map.kind).unwrap_or_default();
            problems.push(format!(
                "{at}/maps/{name}/kind: {kind} is not a kind in resources"
            ));
        }
        for field in ["id", "title"] {
            if !map.fields.contains_key(field) {
                problems.push(format!("{at}/maps/{name}/fields: no {field}"));
            }
        }
    }
    let commands = manifest
        .contributes
        .as_ref()
        .and_then(|c| c.commands.as_ref());
    for (id, action) in endue.actions.iter().flatten() {
        let here = format!("{at}/actions/{id}");
        tool(&action.tool, format!("{here}/tool"), &mut problems);
        let Some(command) = commands.and_then(|cs| cs.iter().find(|c| &c.id == id)) else {
            problems.push(format!("{here}: {id} is not in contributes.commands"));
            continue;
        };
        let lasting = matches!(action.risk, EndueRisk::Send | EndueRisk::Destructive);
        if lasting && command.irreversible != Some(true) {
            problems.push(format!(
                "{here}/risk: {id} calls a send or destructive tool, so it must be irreversible"
            ));
        }
    }
    problems
}

/// Collect the binding sources and the templates of `node` and its children, with their pointers.
fn walk(
    node: &ViewNode,
    at: &str,
    sources: &mut Vec<(String, String)>,
    templates: &mut Vec<(String, String)>,
) {
    match node {
        ViewNode::ViewContainer(container) => {
            if let Some(title) = &container.title {
                templates.push((format!("{at}/title"), title.clone()));
            }
            for (i, child) in container.children.iter().enumerate() {
                walk(child, &format!("{at}/children/{i}"), sources, templates);
            }
        }
        ViewNode::ViewComponent(component) => {
            if let Some(title) = &component.title {
                templates.push((format!("{at}/title"), title.clone()));
            }
            if let Some(binding) = &component.binding {
                for (i, source) in binding.sources.iter().flatten().enumerate() {
                    sources.push((format!("{at}/binding/sources/{i}"), source.clone()));
                }
                for (i, condition) in binding.r#where.iter().flatten().enumerate() {
                    let value = condition.value.as_ref().unwrap_or(&Value::Null);
                    strings(value, &format!("{at}/binding/where/{i}/value"), templates);
                }
            }
            for (i, field) in component.fields.iter().flatten().enumerate() {
                templates.push((format!("{at}/fields/{i}/value"), field.value.clone()));
            }
            for (i, action) in component.actions.iter().flatten().enumerate() {
                let args = action.args.as_ref().unwrap_or(&Value::Null);
                strings(args, &format!("{at}/actions/{i}/args"), templates);
            }
            if let Some(text) = &component.text {
                templates.push((format!("{at}/text"), text.clone()));
            }
        }
    }
}

/// Every string inside `value`, with its pointer.
fn strings(value: &Value, at: &str, out: &mut Vec<(String, String)>) {
    match value {
        Value::String(text) => out.push((at.to_owned(), text.clone())),
        Value::Array(items) => {
            for (i, item) in items.iter().enumerate() {
                strings(item, &format!("{at}/{i}"), out);
            }
        }
        Value::Object(map) => {
            for (key, item) in map {
                strings(item, &format!("{at}/{key}"), out);
            }
        }
        _ => {}
    }
}

/// The params a template reads (`{params.days}` reads `days`); `{{` and `}}` are literal braces.
fn params_read(text: &str) -> Vec<String> {
    let text = text.replace("{{", "").replace("}}", "");
    text.split('{')
        .skip(1)
        .filter_map(|rest| {
            let mut parts = rest.split(['}', '|']).next()?.split('.');
            (parts.next() == Some("params"))
                .then(|| parts.next())
                .flatten()
        })
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A connector plugin of the endue binding with made-up tools, whose problems are none.
    fn fixture() -> Value {
        json!({
            "id": "fixture.gadget", "name": "Gadget", "version": "0.1.0", "kind": "connector",
            "contributes": { "commands": [
                { "id": "fixture.gadget.thing.send", "title": "Send a thing", "irreversible": true }
            ] },
            "connector": {
                "binding": "endue", "auth": { "kind": "endue" },
                "resources": [{ "kind": "entry", "actions": ["fixture.gadget.thing.send"] }],
                "sync": { "mode": "pull" },
                "endue": {
                    "tools": ["thing_read", "thing_send"],
                    "requests": [{ "tool": "thing_read", "items": "/items", "map": "thing" }],
                    "maps": { "thing": { "kind": "entry", "fields": { "id": "/id", "title": "/text" } } },
                    "actions": { "fixture.gadget.thing.send": { "tool": "thing_send", "risk": "send" } }
                }
            }
        })
    }

    fn problems(manifest: Value) -> Vec<String> {
        manifest_problems(&serde_json::from_value(manifest).unwrap())
    }

    #[test]
    fn the_endue_fixture_has_no_problems() {
        assert_eq!(problems(fixture()), Vec::<String>::new());
    }

    #[test]
    fn an_endue_action_on_a_send_or_destructive_tool_must_be_irreversible() {
        for risk in ["send", "destructive"] {
            let mut manifest = fixture();
            manifest["contributes"]["commands"][0]["irreversible"] = json!(false);
            manifest["connector"]["endue"]["actions"]["fixture.gadget.thing.send"]["risk"] =
                json!(risk);
            assert_eq!(
                problems(manifest),
                [
                    "/connector/endue/actions/fixture.gadget.thing.send/risk: fixture.gadget.thing.send calls a send or destructive tool, so it must be irreversible"
                ]
            );
        }
        let mut write = fixture();
        write["contributes"]["commands"][0]["irreversible"] = json!(false);
        write["connector"]["endue"]["actions"]["fixture.gadget.thing.send"]["risk"] =
            json!("write");
        assert!(
            problems(write).is_empty(),
            "a write need not be irreversible"
        );
    }

    #[test]
    fn an_endue_request_names_a_map_of_a_declared_kind() {
        let mut manifest = fixture();
        manifest["connector"]["endue"]["requests"][0]["map"] = json!("other");
        manifest["connector"]["endue"]["requests"][0]["tool"] = json!("thing_list");
        manifest["connector"]["endue"]["maps"]["thing"]["kind"] = json!("metric");
        assert_eq!(
            problems(manifest),
            [
                "/connector/endue/maps/thing/kind: \"metric\" is not a kind in resources",
                "/connector/endue/requests/0/map: other is not one of the endue block's maps",
                "/connector/endue/requests/0/tool: thing_list is not one of the endue block's tools",
            ]
        );
    }

    #[test]
    fn an_endue_action_is_a_declared_command() {
        let mut manifest = fixture();
        let action = json!({ "tool": "thing_send", "risk": "read" });
        manifest["connector"]["endue"]["actions"]["fixture.gadget.thing.forget"] = action;
        assert_eq!(
            problems(manifest),
            [
                "/connector/endue/actions/fixture.gadget.thing.forget: fixture.gadget.thing.forget is not in contributes.commands"
            ]
        );
    }
}
