//! The words side of a capture (ADR 0406): which recogniser serves a language, the OS's grant for
//! it, and `audio.heard` for the capture's caller.

use std::sync::Arc;

use desk_bridge::{AudioHeardData, AudioHeardEvent, BridgeError, BridgeEvent, ErrorCode};
use desk_sys::audio::Authorization;
use desk_sys::speech::{Recogniser, Recognition};

use crate::events::EventBus;
use crate::handler::{error, sys_error};

/// The recogniser for `lang`, before anything is asked or opened; `unsupported` without one.
pub(super) fn recogniser(
    speech: Option<&Arc<dyn Recogniser>>,
    lang: &str,
) -> Result<Arc<dyn Recogniser>, BridgeError> {
    match speech {
        Some(speech) if speech.supports(lang) => Ok(Arc::clone(speech)),
        _ => Err(error(
            ErrorCode::Unsupported,
            format!("this desk cannot turn speech into words in {lang} on this computer"),
        )),
    }
}

/// The OS's grant for speech recognition, asked once: a refusal is `forbidden`, the OS's own.
pub(super) fn allowed(speech: &dyn Recogniser) -> Result<(), BridgeError> {
    let mut authorization = speech.authorization();
    if authorization == Authorization::NotDetermined {
        authorization = speech.request_access().map_err(sys_error)?;
    }
    if authorization.can_capture() {
        return Ok(());
    }
    Err(error(
        ErrorCode::Forbidden,
        format!(
            "the OS does not allow speech recognition ({authorization:?}); turn it on in its \
             privacy settings"
        ),
    ))
}

/// `audio.heard` for a capture's caller.
pub(super) struct Heard {
    pub(super) capture_id: String,
    pub(super) caller: String,
    pub(super) events: EventBus,
}

impl Heard {
    /// A recognition whose words so far go to the caller.
    pub(super) fn start(
        &self,
        speech: &dyn Recogniser,
        lang: &str,
        sample_rate: u32,
    ) -> Result<Box<dyn Recognition>, BridgeError> {
        let heard = Heard {
            capture_id: self.capture_id.clone(),
            caller: self.caller.clone(),
            events: self.events.clone(),
        };
        let on_words = Box::new(move |text: String| heard.publish(text, false));
        speech.start(lang, sample_rate, on_words).map_err(sys_error)
    }

    pub(super) fn publish(&self, text: String, r#final: bool) {
        self.events.publish_to(
            vec![self.caller.clone()],
            BridgeEvent::AudioHeard(AudioHeardEvent {
                event: Default::default(),
                data: AudioHeardData {
                    capture_id: self.capture_id.clone(),
                    text,
                    r#final,
                },
            }),
        );
    }
}

/// The capture ended: its final words, then the recogniser ends.
pub(super) fn finish(
    capture_id: &str,
    caller: &str,
    events: &EventBus,
    words: Box<dyn Recognition>,
) {
    let heard = Heard {
        capture_id: capture_id.to_owned(),
        caller: caller.to_owned(),
        events: events.clone(),
    };
    heard.publish(words.finish(), true);
}
