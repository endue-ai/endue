use std::sync::Arc;
use std::sync::Mutex as Shared;

use serde_json::json;

use super::*;

/// endue AI as a script: whether she is there, and what her runs answer.
struct Fake {
    eris: Result<Option<ChatConversation>, PlatformError>,
    answer: (ChatState, Option<String>),
    sent: Arc<Shared<Vec<String>>>,
}

impl ErisPlatform for Fake {
    fn eris(&self) -> Result<Option<ChatConversation>, PlatformError> {
        self.eris.clone()
    }
    fn turn(
        &self,
        _: &ChatConversation,
        text: &str,
        _: &str,
    ) -> Result<(ChatState, Option<String>), PlatformError> {
        self.sent.lock().unwrap().push(text.to_owned());
        Ok((self.answer.0.clone(), self.answer.1.clone()))
    }
}

fn hers() -> ChatConversation {
    ChatConversation {
        id: "cnv_eris".into(),
        agent_id: "ag_eris".into(),
    }
}

fn eris(
    found: Result<Option<ChatConversation>, PlatformError>,
    answer: (ChatState, Option<String>),
) -> (EndueEris, Arc<Shared<Vec<String>>>) {
    let sent = Arc::new(Shared::new(Vec::new()));
    let fake = Fake {
        eris: found,
        answer,
        sent: Arc::clone(&sent),
    };
    (EndueEris::new(Box::new(fake)), sent)
}

#[test]
fn signed_in_her_run_answers_the_persons_last_line() {
    let (eris, sent) = eris(Ok(Some(hers())), (ChatState::Done, Some("Hello.".into())));
    assert!(eris.reachable().is_ok());
    let messages = [
        json!({ "role": "user", "content": "first" }),
        json!({ "role": "assistant", "content": "ok" }),
        json!({ "role": "user", "content": "hello" }),
    ];
    let mut said = String::new();
    let answer = eris
        .chat(&[], &messages, &mut |piece| {
            if let Piece::Text(text) = piece {
                said.push_str(text);
            }
        })
        .unwrap();
    assert_eq!(answer.text, "Hello.");
    assert_eq!(said, "Hello.");
    assert_eq!(*sent.lock().unwrap(), ["hello"]);
}

#[test]
fn signed_out_or_without_eris_she_cannot_be_reached() {
    let signed_out = PlatformError {
        kind: ErrorKind::SignedOut,
        status: None,
        code: None,
        message: "no token".into(),
    };
    let (eris, _) = eris(Err(signed_out), (ChatState::Done, None));
    assert!(matches!(
        eris.reachable(),
        Err(BrainFailure::Unreachable(_))
    ));
    let (eris, _) = eris_none();
    assert!(matches!(
        eris.reachable(),
        Err(BrainFailure::Unreachable(_))
    ));
}

fn eris_none() -> (EndueEris, Arc<Shared<Vec<String>>>) {
    eris(Ok(None), (ChatState::Done, None))
}

#[test]
fn a_turn_that_needs_the_desks_tools_goes_to_the_next_brain() {
    let (eris, sent) = eris(Ok(Some(hers())), (ChatState::Done, Some("x".into())));
    let messages = [
        json!({ "role": "system", "content": "call a tool" }),
        json!({ "role": "user", "content": "sort" }),
    ];
    let result = eris.chat(&[], &messages, &mut |_| {});
    assert!(matches!(result, Err(BrainFailure::Unreachable(_))));
    assert!(sent.lock().unwrap().is_empty());
}

#[test]
fn a_run_that_waits_for_the_person_says_so() {
    let (eris, _) = eris(Ok(Some(hers())), (ChatState::NeedsInput, None));
    let messages = [json!({ "role": "user", "content": "send it" })];
    let answer = eris.chat(&[], &messages, &mut |_| {}).unwrap();
    assert_eq!(answer.text, NEEDS_YOU_LINE);
}
