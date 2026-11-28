/**
 * The browser stub's microphone (ADR 0406): the recorded sample voice as 20 ms frames on the page's
 * clock, and a scripted recogniser that hears its words at set times, then says the last of them
 * as the final words once the capture stops. It lives in the stub only, never in the app; frames
 * are made when the shell reads the levels, once a frame, so tests drive it with their clock.
 */
import type { Envelope } from "./browser";
import type { CaptureOptions, MicCapture, ShellBridge } from "./types";

/** What the scripted recogniser hears, by milliseconds since the capture started. */
export interface ScriptedWord {
  at: number;
  text: string;
}

/** What it hears unless told otherwise: a greeting, the words so far, then all of them. */
export const SAMPLE_WORDS: readonly ScriptedWord[] = [
  { at: 600, text: "Hello" },
  { at: 1200, text: "Hello Eris" },
];

const FRAME_MS = 20;
const RATE = 16000;

interface Open {
  start: number;
  sent: number;
  words: string;
  onFrame: (frame: Parameters<Parameters<Capture>[0]>[0]) => void;
  options: CaptureOptions | undefined;
}

type Capture = NonNullable<ShellBridge["audio"]["capture"]>;

/** Deterministic noise in -1..1, so the same frames come every run. */
function noise(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 2 ** 31 - 1;
  };
}

export function scriptedMic(
  now: () => number,
  envelope: () => Envelope,
  sample: (envelope: Envelope, t: number) => readonly number[],
  words: () => readonly ScriptedWord[] = () => SAMPLE_WORDS,
): { capture: Capture; pump(): void } {
  const open = new Set<Open>();
  let captures = 0;
  const pump = () => {
    const t = now();
    for (const c of open) {
      while (c.sent + FRAME_MS <= t - c.start) {
        const bands = sample(envelope(), c.sent);
        const level = bands.reduce((a, b) => a + b, 0) / Math.max(1, bands.length);
        const next = noise(c.sent + 1);
        const samples = Int16Array.from({ length: RATE / 50 }, () =>
          Math.round(next() * level * 0.6 * 32767),
        );
        c.onFrame({ samples, sampleRate: RATE, rmsDb: -100, peakDb: -100, atMs: c.sent });
        c.sent += FRAME_MS;
        const heard =
          words()
            .filter((w) => w.at <= c.sent)
            .at(-1)?.text ?? "";
        if (c.options?.transcribe && heard !== c.words) {
          c.words = heard;
          c.options.onHeard?.(heard, false);
        }
      }
    }
  };
  const capture: Capture = async (onFrame, _onEnded, options) => {
    const c: Open = { start: now(), sent: 0, words: "", onFrame, options };
    open.add(c);
    captures += 1;
    const mic: MicCapture = {
      captureId: `stub-${captures}`,
      async stop() {
        if (!open.delete(c)) return;
        if (c.options?.transcribe) c.options.onHeard?.(c.words, true);
      },
    };
    return mic;
  };
  return { capture, pump };
}
