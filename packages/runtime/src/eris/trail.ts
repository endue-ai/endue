/**
 * What is handed over is seen going (FT-05, ADR 0408): a head and three fading followers run along a
 * way from where a thing leaves to where it arrives, and the arrival answers with one ring. The way
 * is a function of 0..1 read again on every frame, so a way whose ends move (a dragged window, a
 * pan) stays joined. It runs once, because of an act of the person or a step of an agent: nothing
 * loops and nothing idles. The parts are elements on the shell moved by `transform` and `opacity`
 * only, `aria-hidden`; what happened is said in words where it is said today.
 */
import { cubicBezier } from "../ease";
import { IDLE, type Ticker } from "../shell/ticker";
import type { Point } from "./errand-thread";

/** A way: where along it a thing is, `t` of the way (0 to 1), in the host's coordinates. */
export type Way = (t: number) => Point;

/** The star: an agent takes up work. Muted: nobody is at work (a window put away by the person). */
export type Tone = "star" | "muted";

export const FLIGHT_MS = 720;
/** Each flight of several at once. */
export const SEVERAL_MS = 950;
export const RING_MS = 560;
export const MAX_FLIGHTS = 12;
/** How far behind the head each follower is, how big and how clear. */
export const FOLLOWERS = [
  { lag: 0.06, size: 0.7, opacity: 0.55 },
  { lag: 0.12, size: 0.55, opacity: 0.4 },
  { lag: 0.18, size: 0.4, opacity: 0.25 },
] as const;
/** The trail fades over the last share of the way. */
const FADE = 0.15;
const RING_TO = 3.4;

/** The errand's ease. */
export const trailEase = cubicBezier(0.45, 0, 0.2, 1);

/** The start of each of `n` flights at once, in ms after the first. */
export function staggerOf(n: number): number {
  return n <= 1 ? 0 : Math.min(170, 1200 / (n - 1));
}

/** The head, then the followers, `p` of the way along (eased): where on the way, how big, how clear. */
export function partsAt(p: number): { t: number; scale: number; opacity: number }[] {
  const fade = p > 1 - FADE ? Math.max(0, (1 - p) / FADE) : 1;
  return [
    { t: p, scale: 1, opacity: fade },
    ...FOLLOWERS.map((f) => ({
      t: Math.max(0, p - f.lag),
      scale: f.size,
      opacity: p > f.lag ? f.opacity * fade : 0,
    })),
  ];
}

/** The arrival's ring, `t` of its time (0 to 1): how big and how clear; still with reduced motion. */
export function ringAt(t: number, reduced: boolean): { scale: number; opacity: number } {
  return { scale: reduced ? 1 : 1 + (RING_TO - 1) * t, opacity: 1 - t };
}

interface Seen {
  ticker: Pick<Ticker, "add" | "now" | "animate">;
  reduced(): boolean;
}

const at = (el: HTMLElement, p: Point, scale: number, opacity: number) => {
  el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) translate(-50%, -50%) scale(${scale.toFixed(3)})`;
  el.style.opacity = opacity.toFixed(3);
};

/** The trails of one host: at most `MAX_FLIGHTS` at once; the rest wait for one to end. */
export class Trails {
  readonly #host: HTMLElement;
  readonly #ctx: Seen;
  #running = 0;
  readonly #waiting: (() => void)[] = [];

  constructor(host: HTMLElement, ctx: Seen) {
    this.#host = host;
    this.#ctx = ctx;
  }

  /** Flights under way now. */
  get running(): number {
    return this.#running;
  }

  /**
   * One flight along `way`; `arrived` runs as its head gets there (at once when it is skipped), and
   * it resolves once its ring has gone. The flight and the ring are one animation, so a clock that
   * runs many frames in one go draws the ring on the frames after the flight.
   */
  async fly(way: Way, tone: Tone = "star", ms = FLIGHT_MS, arrived?: () => void): Promise<void> {
    const doc = this.#host.ownerDocument;
    // A flight that starts while its page is hidden is skipped: nobody would see it.
    if (doc.visibilityState === "hidden") return arrived?.();
    if (this.#running >= MAX_FLIGHTS) await new Promise<void>((go) => this.#waiting.push(go));
    this.#running += 1;
    const el = doc.createElement("div");
    el.className = "trail";
    el.dataset.tone = tone;
    el.setAttribute("aria-hidden", "true");
    const dots = Array.from({ length: 1 + FOLLOWERS.length }, () => {
      const dot = doc.createElement("span");
      dot.className = "trail-dot";
      return dot;
    });
    const ring = doc.createElement("span");
    ring.className = "trail-ring";
    ring.style.opacity = "0";
    el.append(...dots, ring);
    this.#host.append(el);
    // With reduced motion nothing flies: the arrival's ring alone, still.
    const reduced = this.#ctx.reduced();
    const flight = reduced ? 0 : ms;
    let there = false;
    const arrive = () => {
      if (there) return;
      there = true;
      for (const dot of dots) dot.style.opacity = "0";
      arrived?.();
    };
    try {
      await this.#ctx.ticker.animate(
        flight + RING_MS,
        (t) => t,
        (t) => {
          const now = t * (flight + RING_MS);
          if (now < flight) {
            partsAt(trailEase(now / flight)).forEach((part, i) => {
              const dot = dots[i];
              if (dot) at(dot, way(part.t), part.scale, part.opacity);
            });
            return;
          }
          arrive();
          const r = ringAt(Math.min(1, (now - flight) / RING_MS), reduced);
          at(ring, way(1), r.scale, r.opacity);
        },
      );
    } finally {
      arrive();
      el.remove();
      this.#running -= 1;
      this.#waiting.shift()?.();
    }
  }

  /**
   * Several flights at once, staggered, each `SEVERAL_MS` long; `arrived` runs once every head is
   * there.
   */
  async several(ways: Way[], tone: Tone = "muted", arrived?: () => void): Promise<void> {
    const gap = staggerOf(ways.length);
    let left = ways.length;
    const one = () => {
      left -= 1;
      if (left === 0) arrived?.();
    };
    if (!ways.length) arrived?.();
    await Promise.all(
      ways.map(async (way, i) => {
        if (i > 0) await this.#wait(gap * i);
        return this.fly(way, tone, ways.length > 1 ? SEVERAL_MS : FLIGHT_MS, one);
      }),
    );
  }

  /** Wait `ms` on the ticker's clock, so tests drive it. */
  #wait(ms: number): Promise<void> {
    const until = this.#ctx.ticker.now() + ms;
    return new Promise((done) => {
      let over = false;
      let off: (() => void) | undefined;
      off = this.#ctx.ticker.add((now) => {
        if (over) return IDLE;
        if (now < until) return;
        over = true;
        off?.();
        done();
        return IDLE;
      });
      if (over) off();
    });
  }
}

/** A straight way from `from` to `to`, read again on every frame. */
export function straight(from: () => Point, to: () => Point): Way {
  return (t) => {
    const a = from();
    const b = to();
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  };
}

const trails = new WeakMap<HTMLElement, Trails>();

/** The one trails of `host` (the shell). */
export function trailsOf(host: HTMLElement, ctx: Seen): Trails {
  const known = trails.get(host);
  if (known) return known;
  const made = new Trails(host, ctx);
  trails.set(host, made);
  return made;
}
