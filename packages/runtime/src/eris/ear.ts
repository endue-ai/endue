/**
 * Eris's ear for a spoken turn: the bridge's microphone with the core's on-device recognition
 * (`ear-capture.ts`, ADR 0406) wherever the desk has a core; else, in a plain page, the microphone
 * through Web Audio (an AnalyserNode, fftSize 256, into the nine sound bands) with the page's own
 * speech recognition. A page without recognition opens no microphone: it would hear no words.
 */
import type { ShellBridge } from "../bridge/types";
import { captureEar, MAX_DB, MIN_DB, type NoEar } from "./ear-capture";
import type { Ear, TalkLang } from "./talk";
import { bandsFromSpectrum } from "./voice";

/** After asking recognition to stop, its final words are awaited this long. */
const FINAL_WORDS_MS = 900;
const LOCALE: Record<TalkLang, string> = { ko: "ko-KR", en: "en-US" };

/**
 * An AudioContext made inside the click, so the page lets it run; undefined without Web Audio or
 * without a microphone to feed it (no audio machinery is started for nothing).
 */
export function audioContext(): AudioContext | undefined {
  if (typeof AudioContext === "undefined") return undefined;
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return undefined;
  try {
    return new AudioContext();
  } catch {
    return undefined;
  }
}

interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
}

/** The page's speech recognition, if it has one. */
function recognition(): (new () => Recognition) | undefined {
  const w = globalThis as unknown as Record<string, (new () => Recognition) | undefined>;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

/** The platform's speech recognition, listening in `lang`; null when the page has none. */
function recognise(lang: TalkLang): { stop(): Promise<string>; interim(): string } | null {
  const Make = recognition();
  if (!Make) return null;
  let text = "";
  let ended = false;
  let finish: (() => void) | undefined;
  try {
    const r = new Make();
    r.lang = LOCALE[lang];
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (e) => {
      text = Array.from(e.results, (alt) => alt[0]?.transcript ?? "").join(" ");
    };
    r.onerror = () => {};
    r.onend = () => {
      ended = true;
      finish?.();
    };
    r.start();
    return {
      interim: () => text.trim(),
      stop: () =>
        new Promise<string>((resolve) => {
          finish = () => resolve(text.trim());
          if (ended) return finish();
          setTimeout(finish, FINAL_WORDS_MS);
          try {
            r.stop();
          } catch {
            finish();
          }
        }),
    };
  } catch {
    return null;
  }
}

/**
 * The microphone and its words; null when there is none or it was refused; `unheard` when nothing
 * here turns speech into words (no microphone is opened); `speech-refused` when the OS refused
 * recognition. CEF may name Web Speech without serving it, so the bridge's capture comes first.
 */
export async function openMic(
  lang: TalkLang,
  audio: AudioContext | undefined,
  bridge?: ShellBridge["audio"],
): Promise<Ear | NoEar | null> {
  if (bridge?.capture) {
    void audio?.close();
    return captureEar(bridge.capture, lang);
  }
  if (!recognition()) {
    void audio?.close();
    return "unheard";
  }
  const devices = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
  if (!audio || !devices?.getUserMedia) {
    void audio?.close();
    return null;
  }
  let stream: MediaStream;
  try {
    stream = await devices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch {
    void audio.close();
    return null;
  }
  void audio.resume().catch(() => {});
  const analyser = audio.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0;
  analyser.minDecibels = MIN_DB;
  analyser.maxDecibels = MAX_DB;
  audio.createMediaStreamSource(stream).connect(analyser);
  const bins = new Uint8Array(analyser.frequencyBinCount);
  const words = recognise(lang);
  let closed = false;
  return {
    live: true,
    words: words !== null,
    interim: () => words?.interim() ?? "",
    bands() {
      if (closed) return [0, 0, 0, 0, 0, 0, 0, 0, 0];
      analyser.getByteFrequencyData(bins);
      return bandsFromSpectrum(bins, audio.sampleRate);
    },
    async close() {
      if (closed) return "";
      closed = true;
      for (const track of stream.getTracks()) track.stop();
      void audio.close().catch(() => {});
      return (await words?.stop()) ?? "";
    },
  };
}
