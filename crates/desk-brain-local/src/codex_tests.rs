use serde_json::json;

use super::*;

fn tool(name: &str) -> Value {
    json!({ "type": "function", "function": { "name": name, "description": "Does it.",
        "parameters": { "type": "object" } } })
}

fn ran() -> Output {
    Output {
        success: true,
        stdout: String::new(),
        stderr: String::new(),
    }
}

#[test]
fn codex_runs_read_only_reads_stdin_and_names_its_answer_file() {
    let args = arguments(&CodexOptions::new("/bin/codex").with_model("o4"), true);
    assert_eq!(args[0], "exec");
    assert!(args.windows(2).any(|w| w == ["--sandbox", "read-only"]));
    assert!(args.contains(&"--skip-git-repo-check".to_owned()));
    assert!(
        args.windows(2)
            .any(|w| w == ["--output-last-message", LAST])
    );
    assert!(args.windows(2).any(|w| w == ["--output-schema", SCHEMA]));
    assert!(args.windows(2).any(|w| w == ["--model", "o4"]));
    assert_eq!(
        args.last().map(String::as_str),
        Some("-"),
        "the prompt is stdin"
    );
    let plain = arguments(&CodexOptions::new("/bin/codex"), false);
    assert!(!plain.contains(&"--output-schema".to_owned()));
    assert!(!plain.contains(&"--model".to_owned()));
}

#[test]
fn the_schema_is_strict_and_arguments_are_json_text() {
    assert_eq!(schema(&[], false), None, "no tools, no schema");
    let schema: Value = serde_json::from_str(&schema(&[tool("a")], true).unwrap()).unwrap();
    assert_eq!(schema["additionalProperties"], false);
    let item = &schema["properties"]["calls"]["items"];
    assert_eq!(item["additionalProperties"], false);
    assert_eq!(item["properties"]["arguments"]["type"], "string");
    assert_eq!(schema["properties"]["calls"]["minItems"], 1);
}

#[test]
fn an_answer_is_words_or_calls_and_a_silent_run_says_why() {
    let words = read(&ran(), "Hello.\n", true).unwrap();
    assert_eq!(
        (words.text.as_str(), words.stop),
        ("Hello.", StopReason::EndTurn)
    );

    let calls = json!({ "say": "", "calls": [{ "tool": "a", "arguments": "{\"x\":1}" }] });
    let answer = read(&ran(), &calls.to_string(), false).unwrap();
    assert_eq!(answer.stop, StopReason::ToolCall);
    assert_eq!(answer.calls[0].arguments["x"], 1);

    let signed_out = Output {
        success: false,
        stdout: String::new(),
        stderr: "Error: not logged in\n".to_owned(),
    };
    match read(&signed_out, "", true) {
        Err(BrainFailure::Refused { status, .. }) => assert_eq!(status, 401),
        other => panic!("{other:?}"),
    }
    assert!(matches!(
        read(&ran(), "", true),
        Err(BrainFailure::Unreachable(_))
    ));
}

#[test]
fn the_prompt_carries_who_eris_is_and_the_conversation() {
    let messages = [json!({ "role": "user", "content": "hello" })];
    let text = prompt(&[], &messages);
    assert!(text.starts_with("You are Eris"));
    assert!(text.contains("hello"));
}
