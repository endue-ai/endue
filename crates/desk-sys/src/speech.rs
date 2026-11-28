//! Speech into words, on this computer (FT-02, ADR 0406): a recogniser fed with a capture's own 20 ms
//! frames, which reports the words so far while it hears and the final words once the audio ends.
//! Who may capture is decided above this crate, as for `audio`; the recogniser asks the OS for its
//! own grant, and never sends audio off the computer: an OS recogniser that would is not offered.
//!
//! `os()` is the operating system's on-device recognition on macOS (`macos`), with on-device
//! recognition required; there is none on Windows and Linux yet. `fake` is a scripted recogniser
//! for tests, here and in the crates above.

use std::time::Duration;

use crate::Error;
pub use crate::audio::Authorization;

pub mod fake;
#[cfg(all(feature = "speech", target_os = "macos"))]
mod macos;

/// How long `Recognition::finish` waits for the final words once the audio ended.
pub const FINAL_WAIT: Duration = Duration::from_millis(1500);
/// The most characters a recognition reports; the rest is cut.
pub const MAX_CHARS: usize = 8000;

/// What a recognition calls with the words so far, on a thread of its own.
pub type OnWords = Box<dyn FnMut(String) + Send>;

/// Turns speech into words on this computer.
pub trait Recogniser: Send + Sync {
    /// Whether it recognises `lang` (`ko`, `en`) on this device, without sending audio anywhere.
    fn supports(&self, lang: &str) -> bool;
    /// The OS's speech-recognition grant. Never prompts.
    fn authorization(&self) -> Authorization;
    /// Ask the OS once, showing its prompt if the person was never asked, and block until it
    /// answers. Returns the authorization afterwards.
    fn request_access(&self) -> Result<Authorization, Error>;
    /// Start recognising mono LINEAR16 at `sample_rate` in `lang`: `unsupported` for a language
    /// `supports` refuses, `permission_denied` unless the grant is `Authorized`. `on_words` hears the
    /// words so far until `finish` returns.
    fn start(
        &self,
        lang: &str,
        sample_rate: u32,
        on_words: OnWords,
    ) -> Result<Box<dyn Recognition>, Error>;
}

/// One running recognition. Dropping it without `finish` cancels it.
pub trait Recognition: Send {
    /// The next frame of the capture.
    fn feed(&mut self, samples: &[i16]);
    /// No more audio: the final words, waited for up to `FINAL_WAIT` (the words so far when the
    /// recogniser is slower). `on_words` is not called after this returns.
    fn finish(self: Box<Self>) -> String;
}

/// The OS recogniser: on-device speech recognition on macOS. `None` elsewhere. The app needs
/// `NSSpeechRecognitionUsageDescription` in its Info.plist before it calls `request_access` there.
#[cfg(feature = "speech")]
pub fn os() -> Option<Box<dyn Recogniser>> {
    #[cfg(target_os = "macos")]
    {
        Some(Box::new(macos::System))
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// Words cut to `MAX_CHARS` characters, without surrounding space.
pub fn cut(words: &str) -> String {
    words.trim().chars().take(MAX_CHARS).collect()
}
