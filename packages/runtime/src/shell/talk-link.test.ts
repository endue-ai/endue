// @vitest-environment jsdom
// The link from the talk line to the window its next line is about (FT-04, ADR 0407).
import { afterEach, describe, expect, it } from "vitest";
import { ManualClock } from "../clock";
import type { SurfacePlacement } from "../modes/types";
import { Settings } from "../settings";
import type { ShellCtx } from "./context";
import { emptyState, Store } from "./state";
import type { TalkAddress } from "./talk-address";
import { LINK, linkEnds, linkOf, mountTalkLink, shapeLink, strengthOf } from "./talk-link";
import { Ticker } from "./ticker";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const off of cleanups.splice(0)) off();
  document.body.replaceChildren();
});

describe("the talk link", () => {
  it("the_link_ends_on_the_windows_border", () => {
    const pill = { x: 500, y: 840, w: 440, h: 40 };
    const window = { x: 100, y: 100, w: 400, h: 300 };
    const { from, to } = linkEnds(pill, window);
    // The ring lies on the window's border: on one of its four edges, inside its span.
    const onX = Math.abs(to.x - window.x) < 0.01 || Math.abs(to.x - window.x - window.w) < 0.01;
    const onY = Math.abs(to.y - window.y) < 0.01 || Math.abs(to.y - window.y - window.h) < 0.01;
    expect(onX || onY).toBe(true);
    expect(to.x).toBeGreaterThanOrEqual(window.x - 0.01);
    expect(to.x).toBeLessThanOrEqual(window.x + window.w + 0.01);
    // The dot lies on the talk line's top edge, which faces the window.
    expect(from.y).toBeCloseTo(pill.y);
  });

  it("it_is_laid_again_only_when_an_end_moved", () => {
    const svg = linkOf(document);
    expect(shapeLink(svg, { x: 0, y: 0 }, { x: 100, y: 50 })).toBe(true);
    const d = svg.querySelector("path")?.getAttribute("d");
    expect(shapeLink(svg, { x: 0, y: 0 }, { x: 100, y: 50 })).toBe(false);
    expect(svg.querySelector("path")?.getAttribute("d")).toBe(d);
    expect(shapeLink(svg, { x: 0, y: 0 }, { x: 120, y: 50 })).toBe(true);
  });

  it("is 60% at rest, whole when lit, and follows desk.shell.talk-link", () => {
    expect(strengthOf("always", false)).toBe("rest");
    expect(strengthOf("always", true)).toBe("full");
    expect(strengthOf("hover", false)).toBe("hidden");
    expect(strengthOf("hover", true)).toBe("full");
    expect(strengthOf("off", true)).toBe("hidden");
  });

  it("no_link_for_a_window_on_another_desktop", () => {
    const host = document.createElement("div");
    host.className = "shell";
    document.body.append(host);
    const pill = document.createElement("div");
    host.append(pill);
    pill.getClientRects = () => [new DOMRect(500, 840, 440, 40)] as unknown as DOMRectList;
    pill.getBoundingClientRect = () => new DOMRect(500, 840, 440, 40);
    const win = (id: string) => ({ id, plugin: id, x: 0, y: 0, w: 1, h: 1 }) as SurfacePlacement;
    const s = emptyState("en");
    const store = new Store({
      ...s,
      wm: {
        ...s.wm,
        windows: { "1": [win("notes")], "2": [win("files")] },
        front: [{ id: "notes", z: 0, rect: { x: 100, y: 100, w: 400, h: 300 } }],
      },
    } as unknown as typeof s);
    const ticker = new Ticker(new ManualClock());
    const settings = new Settings();
    const ctx = { store, ticker, runtime: { settings } } as unknown as ShellCtx;
    let address: TalkAddress = { kind: "window", id: "notes" };
    const link = mountTalkLink(host, ctx, { pill, address: () => address, lit: () => false });
    cleanups.push(link.dispose, () => ticker.dispose());
    const svg = host.querySelector<SVGSVGElement>(".talk-link");
    link.draw();
    ticker.add(() => {});
    expect(svg?.hasAttribute("hidden")).toBe(false);
    expect(svg?.dataset.strength).toBe("rest");

    address = { kind: "window", id: "files" };
    store.set({ focused: "files" });
    expect(svg?.hasAttribute("hidden")).toBe(true);

    address = { kind: "window", id: "notes" };
    settings.set(LINK, "off");
    store.set({ focused: "notes" });
    expect(svg?.hasAttribute("hidden")).toBe(true);
  });
});
