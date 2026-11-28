// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { testWindowManager } from "../wm/testing";
import { takeDesk } from "../wm/view";
import { openSurface, stash } from "./actions";
import type { ShellCtx } from "./context";
import { mountHandOvers } from "./hand-over";
import { Store, sampleState } from "./state";
import { surfaceTitle } from "./titles";

const epoch = Date.parse("2026-10-28T09:00:00.000Z");

/** A store over the sample state, desk-wm under it and the copy keys as titles, no runtime. */
function ctx() {
  const store = new Store(sampleState("en", epoch));
  const wm = testWindowManager();
  wm.connect((published) => takeDesk(store, published));
  return {
    store,
    wm,
    runtime: undefined as never,
    bridge: undefined as never,
    now: () => 1000,
    wall: () => epoch + 1000,
    tr: (key: string, vars?: Record<string, string | number>) =>
      vars ? `${key} ${Object.values(vars).join(" ")}` : key,
  };
}

describe("surfaceTitle", () => {
  it("names the sample views, the launcher windows and the agent screens as people see them", () => {
    const c = ctx();
    expect(surfaceTitle(c, "calendar")).toBe("surfaceCalendar");
    expect(surfaceTitle(c, "window-1")).toBe("launcherTitle");
    c.store.set({ agents: [{ id: "ag_1", name: "Theo", slug: "theo", status: "idle" }] as never });
    expect(surfaceTitle(c, "agent:ag_1")).toBe("agentScreen Theo");
  });
});

describe("the drawer", () => {
  // Where it goes and how long it stays is desk-wm's (crates/desk-wm/tests/drawer.rs); the name
  // and the wall clock it is dated from are the runtime's.
  it("names a put-away surface after its title and dates it from the wall clock", async () => {
    const c = ctx();
    await openSurface(c, "calendar");
    await stash(c, "calendar");
    expect(c.store.get().drawer[0]).toMatchObject({
      kind: "surface",
      name: "surfaceCalendar",
      at: epoch + 1000,
    });
  });
});

/** An element laid out at `rect` in jsdom, which lays nothing out by itself. */
function laid<T extends HTMLElement>(
  el: T,
  rect: { left: number; top: number; width: number; height: number },
) {
  const box = { ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height };
  el.getBoundingClientRect = () => ({ ...box, x: box.left, y: box.top, toJSON: () => box });
  el.getClientRects = () => [box] as unknown as DOMRectList;
  return el;
}

describe("what is put away is seen going (FT-05)", () => {
  /** The shell, the drawer's handle and where each trail's arrival ring is. */
  function seen() {
    const c = ctx();
    const shell = laid(document.createElement("div"), {
      left: 0,
      top: 0,
      width: 1440,
      height: 900,
    });
    shell.className = "shell";
    document.body.append(shell);
    const handle = laid(document.createElement("button"), {
      left: 20,
      top: 860,
      width: 32,
      height: 32,
    });
    shell.append(handle);
    const ends: { tone?: string; at: string }[] = [];
    const ticker = {
      now: () => 0,
      add: () => () => {},
      animate: (_ms: number, _ease: unknown, update: (t: number) => void) => {
        update(1);
        const ring = shell.querySelector<HTMLElement>(".trail .trail-ring");
        if (ring) ends.push({ tone: ring.parentElement?.dataset.tone, at: ring.style.transform });
        return Promise.resolve();
      },
    };
    const shellCtx = { ...c, ticker, reduced: () => false } as unknown as ShellCtx;
    const off = mountHandOvers(() => shell, handle, shellCtx);
    return {
      c,
      shell,
      ends,
      done: () => {
        off();
        shell.remove();
      },
    };
  }

  it("a_window_put_away_flies_to_the_drawer", async () => {
    const { c, ends, done } = seen();
    await openSurface(c, "calendar");
    await stash(c, "calendar");
    await new Promise((go) => setTimeout(go, 0));
    // Muted, since nobody is at work, and it ends on the handle's middle (36, 876).
    expect(ends[0]).toEqual({
      tone: "muted",
      at: expect.stringContaining("translate(36.0px, 876.0px)"),
    });
    done();
  });

  it("an_agents_window_flies_to_its_row", async () => {
    const { c, shell, ends, done } = seen();
    const row = laid(document.createElement("div"), {
      left: 1400,
      top: 200,
      width: 40,
      height: 40,
    });
    row.dataset.agent = "ag_1";
    shell.append(row);
    await openSurface(c, "agent:ag_1");
    await stash(c, "agent:ag_1");
    await new Promise((go) => setTimeout(go, 0));
    expect(ends[0]?.at).toContain("translate(1420.0px, 220.0px)");
    done();
  });
});
