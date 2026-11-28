// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ManualClock } from "../clock";
import { Ticker } from "../shell/ticker";
import type { Point } from "./errand-thread";
import {
  FLIGHT_MS,
  FOLLOWERS,
  MAX_FLIGHTS,
  partsAt,
  RING_MS,
  ringAt,
  staggerOf,
  straight,
  Trails,
} from "./trail";

const xOf = (el: Element) =>
  Number(/translate\(([-\d.]+)px/.exec((el as HTMLElement).style.transform)?.[1]);

describe("the trail", () => {
  let host: HTMLDivElement;
  let clock: ManualClock;
  let reduced = false;
  let trails: Trails;
  /** Run `ms` of frames, letting each flight's next step start between them, as a page does. */
  const run = async (ms: number, step = 16) => {
    for (let t = 0; t < ms; t += step) {
      clock.advance(step);
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    }
  };

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    clock = new ManualClock();
    reduced = false;
    trails = new Trails(host, { ticker: new Ticker(clock), reduced: () => reduced });
  });
  afterEach(() => host.remove());

  it("followers_lag_the_head_by_their_share_of_the_way", () => {
    const parts = partsAt(0.5);
    expect(parts).toHaveLength(4);
    expect(parts[0]).toEqual({ t: 0.5, scale: 1, opacity: 1 });
    FOLLOWERS.forEach((f, i) => {
      expect(parts[i + 1]?.t).toBeCloseTo(0.5 - f.lag);
      expect(parts[i + 1]?.scale).toBe(f.size);
      expect(parts[i + 1]?.opacity).toBe(f.opacity);
    });
    // A follower that has not left yet is not drawn.
    expect(partsAt(0.05)[1]?.opacity).toBe(0);
  });

  it("the_trail_fades_over_the_last_part", () => {
    expect(partsAt(0.85)[0]?.opacity).toBe(1);
    expect(partsAt(0.925)[0]?.opacity).toBeCloseTo(0.5);
    expect(partsAt(1)[0]?.opacity).toBe(0);
    expect(partsAt(0.925)[1]?.opacity).toBeCloseTo(FOLLOWERS[0].opacity * 0.5);
    expect(ringAt(0, false)).toEqual({ scale: 1, opacity: 1 });
    expect(ringAt(1, false).scale).toBeCloseTo(3.4);
    expect(ringAt(1, false).opacity).toBe(0);
  });

  it("a_way_whose_end_moves_keeps_the_trail_joined", async () => {
    let end: Point = { x: 100, y: 0 };
    const flight = trails.fly(
      straight(
        () => ({ x: 0, y: 0 }),
        () => end,
      ),
    );
    await run(FLIGHT_MS / 2);
    end = { x: 300, y: 0 };
    await run(16);
    const head = host.querySelector(".trail-dot");
    // Half way (eased) on the way to the end where it is now, not where it was.
    expect(xOf(head as Element)).toBeGreaterThan(100);
    await run(FLIGHT_MS);
    const ring = host.querySelector<HTMLElement>(".trail-ring");
    expect(xOf(ring as Element)).toBe(300);
    await run(RING_MS + 32);
    await flight;
    expect(host.querySelector(".trail")).toBeNull();
  });

  it("twelve_flights_at_most_and_the_rest_wait", async () => {
    const way = straight(
      () => ({ x: 0, y: 0 }),
      () => ({ x: 10, y: 10 }),
    );
    const flights = Array.from({ length: MAX_FLIGHTS + 3 }, () => trails.fly(way));
    await Promise.resolve();
    expect(host.querySelectorAll(".trail")).toHaveLength(MAX_FLIGHTS);
    expect(host.querySelectorAll(".trail-dot, .trail-ring")).toHaveLength(MAX_FLIGHTS * 5);
    await run(FLIGHT_MS + RING_MS + 48);
    await Promise.resolve();
    await Promise.resolve();
    expect(host.querySelectorAll(".trail")).toHaveLength(3);
    await run(FLIGHT_MS + RING_MS + 48);
    await Promise.all(flights);
    expect(host.querySelectorAll(".trail")).toHaveLength(0);
  });

  it("several_flights_start_staggered", async () => {
    expect(staggerOf(1)).toBe(0);
    expect(staggerOf(2)).toBe(170);
    expect(staggerOf(11)).toBe(120);
    const way = straight(
      () => ({ x: 0, y: 0 }),
      () => ({ x: 10, y: 0 }),
    );
    const all = trails.several([way, way, way]);
    await Promise.resolve();
    expect(host.querySelectorAll(".trail")).toHaveLength(1);
    await run(176);
    await Promise.resolve();
    expect(host.querySelectorAll(".trail")).toHaveLength(2);
    expect(host.querySelector(".trail")?.getAttribute("data-tone")).toBe("muted");
    await run(3000);
    await all;
  });

  it("reduced_motion_shows_only_the_arrival", async () => {
    reduced = true;
    const flight = trails.fly(
      straight(
        () => ({ x: 0, y: 0 }),
        () => ({ x: 50, y: 0 }),
      ),
    );
    await Promise.resolve();
    const dots = [...host.querySelectorAll<HTMLElement>(".trail-dot")];
    expect(dots.every((dot) => dot.style.opacity === "0" && dot.style.transform === "")).toBe(true);
    await run(32);
    const ring = host.querySelector<HTMLElement>(".trail-ring");
    expect(ring?.style.transform).toContain("scale(1.000)");
    expect(host.querySelector(".trail")?.getAttribute("aria-hidden")).toBe("true");
    await run(RING_MS);
    await flight;
    expect(host.querySelector(".trail")).toBeNull();
  });

  it("skips a flight while the page is hidden", async () => {
    const hidden = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState");
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    try {
      await trails.fly(
        straight(
          () => ({ x: 0, y: 0 }),
          () => ({ x: 1, y: 1 }),
        ),
      );
      expect(host.querySelector(".trail")).toBeNull();
    } finally {
      delete (document as { visibilityState?: unknown }).visibilityState;
      if (hidden) expect(document.visibilityState).toBe("visible");
    }
  });
});
