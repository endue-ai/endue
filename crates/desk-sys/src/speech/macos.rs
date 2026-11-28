//! The OS's speech recognition on macOS: Speech's `SFSpeechRecognizer` with on-device recognition
//! required (`requiresOnDeviceRecognition`), so no audio leaves the computer; a language whose
//! recogniser cannot run on the device is not offered. A capture's frames are appended to an
//! `SFSpeechAudioBufferRecognitionRequest` as float buffers; partial results are the words so far,
//! and the final result comes after `endAudio`.
//!
//! Like `audio/avfoundation.rs`, this module is allowed `unsafe` (the workspace denies it everywhere
//! else): objc2 marks every Speech and AVFAudio method `unsafe`. Each block calls a method with the
//! arguments the framework documents, and nothing unsafe leaves the module.
//!
//! The app needs `NSSpeechRecognitionUsageDescription` in its Info.plist before `request_access`;
//! without it macOS ends the process. Reading the status never prompts.
#![allow(unsafe_code)]

use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, MutexGuard};

use block2::RcBlock;
use objc2::AnyThread;
use objc2::rc::Retained;
use objc2_avf_audio::{AVAudioFormat, AVAudioPCMBuffer};
use objc2_foundation::{NSError, NSLocale, NSOperationQueue, NSString};
use objc2_speech::{
    SFSpeechAudioBufferRecognitionRequest, SFSpeechRecognitionResult, SFSpeechRecognitionTask,
    SFSpeechRecognizer, SFSpeechRecognizerAuthorizationStatus,
};

use super::{Authorization, FINAL_WAIT, OnWords, Recogniser, Recognition, cut};
use crate::{Error, ErrorCode};

pub(super) struct System;

/// The locale a desk language is recognised in.
fn locale(lang: &str) -> Option<&'static str> {
    match lang {
        "ko" => Some("ko-KR"),
        "en" => Some("en-US"),
        _ => None,
    }
}

/// A recogniser for `lang` that runs on the device, or `None`.
fn recogniser(lang: &str) -> Option<Retained<SFSpeechRecognizer>> {
    let id = NSString::from_str(locale(lang)?);
    let locale = NSLocale::localeWithLocaleIdentifier(&id);
    // SAFETY: an initialiser with a locale; nil when the locale has no recogniser.
    let recogniser =
        unsafe { SFSpeechRecognizer::initWithLocale(SFSpeechRecognizer::alloc(), &locale) }?;
    // SAFETY: reads a property of a live recogniser.
    unsafe { recogniser.supportsOnDeviceRecognition() }.then_some(recogniser)
}

impl Recogniser for System {
    fn supports(&self, lang: &str) -> bool {
        recogniser(lang).is_some()
    }

    fn authorization(&self) -> Authorization {
        // SAFETY: a class method that reads the grant.
        let status = unsafe { SFSpeechRecognizer::authorizationStatus() };
        match status {
            SFSpeechRecognizerAuthorizationStatus::NotDetermined => Authorization::NotDetermined,
            SFSpeechRecognizerAuthorizationStatus::Denied => Authorization::Denied,
            SFSpeechRecognizerAuthorizationStatus::Authorized => Authorization::Authorized,
            _ => Authorization::Restricted,
        }
    }

    fn request_access(&self) -> Result<Authorization, Error> {
        let before = self.authorization();
        if before != Authorization::NotDetermined {
            return Ok(before);
        }
        let (sender, receiver) = mpsc::channel::<()>();
        let handler = RcBlock::new(move |_status: SFSpeechRecognizerAuthorizationStatus| {
            let _ = sender.send(());
        });
        // SAFETY: `handler` is a live block of the handler's signature, which Speech copies and calls
        // once on a queue of its own.
        unsafe { SFSpeechRecognizer::requestAuthorization(&handler) };
        drop(handler);
        receiver.recv().map_err(|_| {
            Error::new(
                ErrorCode::IoError,
                "Speech dropped the recognition request without answering",
            )
        })?;
        Ok(self.authorization())
    }

    fn start(
        &self,
        lang: &str,
        sample_rate: u32,
        on_words: OnWords,
    ) -> Result<Box<dyn Recognition>, Error> {
        let recogniser = recogniser(lang).ok_or_else(|| {
            Error::new(
                ErrorCode::Unsupported,
                format!("this Mac cannot recognise {lang} on the device"),
            )
        })?;
        if !self.authorization().can_capture() {
            return Err(Error::new(
                ErrorCode::PermissionDenied,
                "speech recognition needs the OS's permission",
            ));
        }
        // SAFETY: reads a property of a live recogniser.
        if !unsafe { recogniser.isAvailable() } {
            return Err(Error::new(
                ErrorCode::Unsupported,
                "speech recognition is not available right now",
            ));
        }
        // SAFETY: a standard (float, non-interleaved) format of one channel at the capture's rate.
        let format = unsafe {
            AVAudioFormat::initStandardFormatWithSampleRate_channels(
                AVAudioFormat::alloc(),
                f64::from(sample_rate),
                1,
            )
        }
        .ok_or_else(|| Error::new(ErrorCode::IoError, "no audio format at that rate"))?;
        // SAFETY: a new request, set up before any audio is appended.
        let request = unsafe { SFSpeechAudioBufferRecognitionRequest::new() };
        unsafe {
            request.setRequiresOnDeviceRecognition(true);
            request.setShouldReportPartialResults(true);
        }
        let (finals, finished) = mpsc::channel();
        let shared = Arc::new(Shared {
            words: Mutex::new(String::new()),
            on_words: Mutex::new(Some(on_words)),
            finals: Mutex::new(Some(finals)),
        });
        let handler = {
            let shared = Arc::clone(&shared);
            RcBlock::new(
                move |result: *mut SFSpeechRecognitionResult, error: *mut NSError| {
                    shared.heard(result, !error.is_null());
                },
            )
        };
        // Results come on a queue of the desk's, never the main thread, which may be the one
        // waiting in `finish`.
        // SAFETY: sets the queue of a live recogniser before its task starts; then starts the task
        // with a live request and a block of the handler's signature, which Speech copies.
        let task = unsafe {
            recogniser.setQueue(&NSOperationQueue::new());
            recogniser.recognitionTaskWithRequest_resultHandler(&request, &handler)
        };
        drop(handler);
        Ok(Box::new(Running {
            _recogniser: recogniser,
            request,
            task,
            format,
            shared,
            finished,
        }))
    }
}

/// What the result handler shares with the recognition.
struct Shared {
    words: Mutex<String>,
    on_words: Mutex<Option<OnWords>>,
    finals: Mutex<Option<Sender<String>>>,
}

impl Shared {
    fn heard(&self, result: *mut SFSpeechRecognitionResult, failed: bool) {
        let mut done = failed;
        if !result.is_null() {
            // SAFETY: Speech passes a live result, or nil (checked above).
            let (text, last) = unsafe {
                let result = &*result;
                (
                    result.bestTranscription().formattedString().to_string(),
                    result.isFinal(),
                )
            };
            let text = cut(&text);
            *lock(&self.words) = text.clone();
            done |= last;
            if !last && let Some(on_words) = lock(&self.on_words).as_mut() {
                on_words(text);
            }
        }
        if done && let Some(finals) = lock(&self.finals).take() {
            let _ = finals.send(lock(&self.words).clone());
        }
    }
}

struct Running {
    _recogniser: Retained<SFSpeechRecognizer>,
    request: Retained<SFSpeechAudioBufferRecognitionRequest>,
    task: Retained<SFSpeechRecognitionTask>,
    format: Retained<AVAudioFormat>,
    shared: Arc<Shared>,
    finished: Receiver<String>,
}

// SAFETY: a recognition is fed from the capture's one thread at a time; Speech documents appending
// to a buffer request from an audio thread, and `endAudio` and `cancel` from any thread. The
// recogniser and the format are only kept alive here.
unsafe impl Send for Running {}

impl Recognition for Running {
    fn feed(&mut self, samples: &[i16]) {
        let Ok(count) = u32::try_from(samples.len()) else {
            return;
        };
        // SAFETY: a PCM buffer of the request's float format with room for `count` frames, filled
        // through its one channel's pointer, which holds `count` floats, then appended.
        unsafe {
            let Some(buffer) = AVAudioPCMBuffer::initWithPCMFormat_frameCapacity(
                AVAudioPCMBuffer::alloc(),
                &self.format,
                count,
            ) else {
                return;
            };
            buffer.setFrameLength(count);
            let channels = buffer.floatChannelData();
            if channels.is_null() {
                return;
            }
            let channel = (*channels).as_ptr();
            for (i, sample) in samples.iter().enumerate() {
                *channel.add(i) = f32::from(*sample) / 32768.0;
            }
            self.request.appendAudioPCMBuffer(&buffer);
        }
    }

    fn finish(self: Box<Self>) -> String {
        // SAFETY: ends the request's audio, once.
        unsafe { self.request.endAudio() };
        // `self` drops on return, so no words follow.
        self.finished
            .recv_timeout(FINAL_WAIT)
            .unwrap_or_else(|_| lock(&self.shared.words).clone())
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        // No words after this: the handler holds the lock while it calls.
        lock(&self.shared.on_words).take();
        // SAFETY: cancels a live task; a finished one ignores it.
        unsafe { self.task.cancel() };
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}
