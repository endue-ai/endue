// Eris's ear through the bridge's microphone (#311, ADR 0406): inside CEF she listens through
// audio.capture, shows the input level, and hears the words the core's on-device recogniser makes.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CaptureFrame, CaptureOptions, MicCapture, ShellBridge } from "../bridge/types";
import { openMic } from "./ear";
import { FINAL_WORDS_MS } from "./ear-capture";
import type { Ear } from "./talk";

type Refusal = "unheard" | "speech-refused" | null;

/** A bridge microphone the test plays: it hands frames and words to the ear's listeners. */
function fakeMic(refuse: Refusal | false = false) {
  let onFrame: ((frame: CaptureFrame) => void) | undefined;
  let onEnded: (() => void) | undefined;
  let options: CaptureOptions | undefined;
  const stop = vi.fn(async () => {});
  const audio: ShellBridge["audio"] = {
    levels: () => ({ user: [], eris: [] }),
    capture: vi.fn(
      async (listener: (frame: CaptureFrame) => void, ended?: () => void, o?: CaptureOptions) => {
        if (refuse !== false) return refuse;
        onFrame = listener;
        onEnded = ended;
        options = o;
        return { captureId: "c1", stop } satisfies MicCapture;
      },
    ),
  };
  const frame = (samples: Int16Array, rmsDb: number) =>
    onFrame?.({ samples, sampleRate: 16000, rmsDb, peakDb: rmsDb + 3, atMs: 0 });
  const heard = (text: string, final = false) => options?.onHeard?.(text, final);
  return { audio, stop, frame, heard, end: () => onEnded?.(), options: () => options };
}

/** 20 ms of a 500 Hz tone at `amplitude` (0..1), 16 kHz. */
const tone = (amplitude: number) =>
  Int16Array.from({ length: 320 }, (_, i) =>
    Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * 500 * i) / 16000)),
  );

const sum = (bands: readonly number[]) => bands.reduce((a, b) => a + b, 0);

/** The ear `openMic` gave, which these tests expect to be one. */
const asEar = (opened: unknown): Ear => {
  expect(typeof opened).toBe("object");
  expect(opened).not.toBeNull();
  return opened as Ear;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Eris's ear through audio.capture", () => {
  it("the ear listens through audio.capture and asks for words in the desk's language", async () => {
    const mic = fakeMic();
    const ear = asEar(await openMic("ko", undefined, mic.audio));
    expect(ear.live).toBe(true);
    expect(ear.words).toBe(true);
    expect(mic.audio.capture).toHaveBeenCalledTimes(1);
    expect(mic.options()?.transcribe).toEqual({ lang: "ko" });

    mic.frame(tone(0.5), -9);
    expect(sum(ear.bands(0))).toBeGreaterThan(0);
    mic.frame(new Int16Array(320), -100);
    expect(sum(ear.bands(20))).toBe(0);
  });

  it("the_ear_closes_with_the_final_words", async () => {
    const mic = fakeMic();
    const ear = asEar(await openMic("en", undefined, mic.audio));
    mic.heard("what");
    expect(ear.interim()).toBe("what");
    mic.heard("what time is");
    expect(ear.interim()).toBe("what time is");
    const closed = ear.close();
    mic.heard("what time is it", true);
    await expect(closed).resolves.toBe("what time is it");
    expect(mic.stop).toHaveBeenCalledTimes(1);
  });

  it("without final words in time, the ear closes with the words so far", async () => {
    vi.useFakeTimers();
    const mic = fakeMic();
    const ear = asEar(await openMic("en", undefined, mic.audio));
    mic.heard("hello there");
    const closed = ear.close();
    await vi.advanceTimersByTimeAsync(FINAL_WORDS_MS + 10);
    await expect(closed).resolves.toBe("hello there");
  });

  it("an_ear_without_a_recogniser_says_it_hears_no_words", async () => {
    const mic = fakeMic("unheard");
    await expect(openMic("en", undefined, mic.audio)).resolves.toBe("unheard");
    const refused = fakeMic("speech-refused");
    await expect(openMic("en", undefined, refused.audio)).resolves.toBe("speech-refused");
    // A page with no core and no recognition of its own opens no microphone either.
    vi.stubGlobal("SpeechRecognition", undefined);
    vi.stubGlobal("webkitSpeechRecognition", undefined);
    await expect(openMic("en", undefined, undefined)).resolves.toBe("unheard");
  });

  it("an ended capture goes silent at once", async () => {
    const mic = fakeMic();
    const ear = asEar(await openMic("en", undefined, mic.audio));
    mic.frame(tone(0.5), -9);
    expect(sum(ear.bands(0))).toBeGreaterThan(0);
    mic.end();
    expect(sum(ear.bands(20))).toBe(0);
  });

  it("a refused capture is no ear", async () => {
    const mic = fakeMic(null);
    await expect(openMic("en", undefined, mic.audio)).resolves.toBeNull();
    expect(mic.audio.capture).toHaveBeenCalledTimes(1);
  });

  it("the bridge's capture comes first even where the page names Web Speech", async () => {
    vi.stubGlobal(
      "SpeechRecognition",
      class {
        start() {}
        stop() {}
      },
    );
    const mic = fakeMic();
    asEar(await openMic("en", undefined, mic.audio));
    expect(mic.audio.capture).toHaveBeenCalledTimes(1);
  });

  it("with recognition but no microphone anywhere there is no ear", async () => {
    vi.stubGlobal("SpeechRecognition", class {});
    await expect(openMic("en", undefined, undefined)).resolves.toBeNull();
  });
});
