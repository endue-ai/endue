---
status: accepted
date: 2026-11-29
decision-makers: Team endue
---

# Speech becomes words on the device, as an option of a capture

Continues ADR 0245 (microphone capture over the bridge), which left speech-to-text for later.

## Context and Problem Statement

In the 0.5.0 field test (#829, FT-02) a spoken line to Eris was answered with "I heard you. This is a
sample answer." CEF names no working speech recognition, so the runtime took the bridge's capture,
which reads the level only, and with no words Eris said a line written for a demonstration. Where
can speech become words, and how does a caller get them, without audio leaving the computer?

## Decision Drivers

* No audio leaves the computer for recognition, ever
* One capture is one thing the person sees and stops: the chrome's one Listen button
* A plugin gets what the runtime gets, under the same `audio:capture`
* Eris never answers with a placeholder: she says what happened

## Considered Options

* Web Speech in the page
* A recogniser in the core, fed with the capture's own frames, as an option of the capture
* A model shipped with the desk
* endue AI's voice service

## Decision Outcome

Chosen option: "a recogniser in the core", because it keeps one capture, one grant and one stop, and
the operating system already holds an on-device recogniser.

* `audio.capture.start` takes `transcribe: { lang }` (`ko`, `en`). While that capture runs, its
  caller, and no one else, hears `audio.heard { captureId, text, final }`: the words so far, then
  the final words once the capture stops, before `audio.ended`.
* The recogniser is `desk_sys::speech::Recogniser`, fed with each 20 ms frame. On macOS it is the
  Speech framework's `SFSpeechRecognizer` with `requiresOnDeviceRecognition` set: on-device
  recognition is required, not preferred, and a language whose recogniser cannot run on the device
  is not offered. Its results come on a queue of the desk's. Windows and Linux have none yet.
* Without a recogniser for the language, the start is `unsupported` and nothing opens. When the OS
  refuses speech recognition, the start is `forbidden` (the OS service refused the person) and
  nothing opens. The OS is asked once, after the desk's grant and the microphone's, with the
  bundle's `NSSpeechRecognitionUsageDescription`.
* Every end of the capture, whatever its reason, ends the recogniser with it.
* Eris's ear asks for `transcribe`. A turn sends the heard words to the brain as a typed line; a
  voice without words is "I didn't catch that"; with no recogniser she says once that she cannot
  turn speech into words here and opens the talk line; a failed answer is the turn's own line
  (ADR 0405). The sample lines leave the catalogues. She speaks aloud only when the profile's
  `eris.manner.voice` is on.

### Consequences

* Good, because a spoken line on a Mac is answered as the same line typed, and no audio leaves it.
* Good, because a plugin that captures can ask for words with the grant it already has.
* Bad, because Windows and Linux hear no words yet; Eris says so and takes typing.
* Bad, because `capture.stop` waits up to 1.5 s for the final words.
* Bad, because the OS refusal has no button to its privacy settings yet: the sentence says where.
* Neutral: a model shipped with the desk, or endue AI's voice service, can stand behind the same
  `audio.heard` later. The wake word stays `unsupported`.

### Confirmation

`crates/desk-core/tests/audio_words.rs`, `apps/desk/src/shell-bridge.audio.test.ts`,
`packages/runtime/src/eris/{ear-capture,talk,mouth,said}.test.ts`, the e2e test "a spoken line is
answered" (`packages/runtime/e2e/shell-eris.spec.ts`, on the stub's scripted recogniser), and the
spec vectors `audio-capture-start-transcribe`, `audio-capture-start-transcribe-unknown-lang` and
`audio-heard-event`. Not yet confirmed on an installed build: the macOS recogniser itself
(`crates/desk-sys/src/speech/macos.rs`) has no automated test, as no test opens a real recogniser.
