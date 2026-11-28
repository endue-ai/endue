//! A scripted recogniser, for tests here and in the crates above: it hears the words of its script
//! once it has been fed so many frames, says them as the words so far, and finishes with the last
//! words it reached. It follows the OS recogniser's rules: an unknown language is `unsupported`,
//! and nothing starts before the grant.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use super::{Authorization, OnWords, Recogniser, Recognition, cut};
use crate::{Error, ErrorCode};

/// A `Recogniser` over a script of `(frames, words)`: after that many frames, the words so far are
/// `words`. Starts `Authorized` for `ko` and `en`.
pub struct FakeRecogniser {
    langs: Vec<String>,
    authorization: Mutex<Authorization>,
    answer: Authorization,
    script: Vec<(usize, String)>,
    running: Arc<AtomicUsize>,
    started: AtomicUsize,
}

impl FakeRecogniser {
    pub fn new() -> Self {
        Self {
            langs: vec!["ko".to_owned(), "en".to_owned()],
            authorization: Mutex::new(Authorization::Authorized),
            answer: Authorization::Authorized,
            script: Vec::new(),
            running: Arc::default(),
            started: AtomicUsize::new(0),
        }
    }

    /// The words it hears, by how many frames it was fed first.
    pub fn with_script(mut self, script: &[(usize, &str)]) -> Self {
        self.script = script.iter().map(|(n, w)| (*n, (*w).to_owned())).collect();
        self
    }

    pub fn with_langs(mut self, langs: &[&str]) -> Self {
        self.langs = langs.iter().map(|l| (*l).to_owned()).collect();
        self
    }

    pub fn with_authorization(self, authorization: Authorization) -> Self {
        *lock(&self.authorization) = authorization;
        self
    }

    /// What the person answers the prompt `request_access` shows.
    pub fn with_answer(mut self, answer: Authorization) -> Self {
        self.answer = answer;
        self
    }

    /// Recognitions started and not yet finished or dropped.
    pub fn running(&self) -> usize {
        self.running.load(Ordering::SeqCst)
    }

    /// Recognitions ever started.
    pub fn started(&self) -> usize {
        self.started.load(Ordering::SeqCst)
    }
}

impl Default for FakeRecogniser {
    fn default() -> Self {
        Self::new()
    }
}

impl Recogniser for FakeRecogniser {
    fn supports(&self, lang: &str) -> bool {
        self.langs.iter().any(|l| l == lang)
    }

    fn authorization(&self) -> Authorization {
        *lock(&self.authorization)
    }

    fn request_access(&self) -> Result<Authorization, Error> {
        let mut authorization = lock(&self.authorization);
        if *authorization == Authorization::NotDetermined {
            *authorization = self.answer;
        }
        Ok(*authorization)
    }

    fn start(
        &self,
        lang: &str,
        _sample_rate: u32,
        on_words: OnWords,
    ) -> Result<Box<dyn Recognition>, Error> {
        if !self.supports(lang) {
            return Err(Error::new(
                ErrorCode::Unsupported,
                format!("no recogniser for {lang}"),
            ));
        }
        if !self.authorization().can_capture() {
            return Err(Error::new(
                ErrorCode::PermissionDenied,
                "speech recognition needs the OS's permission",
            ));
        }
        self.started.fetch_add(1, Ordering::SeqCst);
        self.running.fetch_add(1, Ordering::SeqCst);
        Ok(Box::new(Scripted {
            script: self.script.clone(),
            fed: 0,
            words: String::new(),
            on_words,
            running: Arc::clone(&self.running),
        }))
    }
}

struct Scripted {
    script: Vec<(usize, String)>,
    fed: usize,
    words: String,
    on_words: OnWords,
    running: Arc<AtomicUsize>,
}

impl Recognition for Scripted {
    fn feed(&mut self, _samples: &[i16]) {
        self.fed += 1;
        let reached = self
            .script
            .iter()
            .rev()
            .find(|(n, _)| *n <= self.fed)
            .map(|(_, w)| cut(w));
        if let Some(words) = reached
            && words != self.words
        {
            self.words = words.clone();
            (self.on_words)(words);
        }
    }

    fn finish(self: Box<Self>) -> String {
        self.words.clone()
    }
}

impl Drop for Scripted {
    fn drop(&mut self) {
        self.running.fetch_sub(1, Ordering::SeqCst);
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}
