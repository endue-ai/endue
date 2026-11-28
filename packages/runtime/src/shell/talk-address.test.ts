// What the next line is about (FT-04, ADR 0407): the window in use, a pin, the sweep's selection,
// an agent's window, and Eris when there is none.
import { describe, expect, it } from "vitest";
import type { SurfacePlacement } from "../modes/types";
import type { DeskState } from "./state";
import { emptyState } from "./state";
import { cycleOf, elsewhere, followed, TalkAddressBook } from "./talk-address";

const win = (id: string, view?: string): SurfacePlacement =>
  ({
    id,
    plugin: id,
    x: 0,
    y: 0,
    w: 400,
    h: 300,
    pinned: false,
    ...(view ? { tabs: [{ id: `${id}-t`, view }] } : {}),
  }) as SurfacePlacement;

function desk(over: Partial<DeskState> = {}, windows: Record<string, SurfacePlacement[]> = {}) {
  const s = emptyState("en");
  const all = { "1": [win("notes"), win("mail")], "2": [win("files")], ...windows };
  return {
    ...s,
    ...over,
    wm: {
      ...s.wm,
      windows: all,
      front: (all["1"] ?? []).map((w) => ({ id: w.id, z: 0, rect: { x: 0, y: 0, w: 1, h: 1 } })),
    },
  } as unknown as DeskState;
}

describe("the talk line's address", () => {
  it("the_address_follows_the_window_in_use", () => {
    const book = new TalkAddressBook();
    expect(book.current(desk())).toEqual({ kind: "eris" });
    expect(book.current(desk({ focused: "notes" }))).toEqual({ kind: "window", id: "notes" });
    expect(book.current(desk({ focused: "mail" }))).toEqual({ kind: "window", id: "mail" });
  });

  it("a_pinned_address_stays_when_focus_moves", () => {
    const book = new TalkAddressBook();
    book.pin(desk({ focused: "notes" }));
    expect(book.pinned()).toBe(true);
    expect(book.current(desk({ focused: "mail" }))).toEqual({ kind: "window", id: "notes" });
    // A second press unpins it.
    book.pin(desk({ focused: "mail" }), { kind: "window", id: "notes" });
    expect(book.current(desk({ focused: "mail" }))).toEqual({ kind: "window", id: "mail" });
  });

  it("closing_the_addressed_window_clears_it", () => {
    const book = new TalkAddressBook();
    book.pin(desk({ focused: "notes" }));
    const closed = desk({ focused: null }, { "1": [win("mail")] });
    expect(book.current(closed)).toEqual({ kind: "eris" });
    expect(book.pinned()).toBe(false);
  });

  it("a cleared address is Eris until the window in use changes", () => {
    const book = new TalkAddressBook();
    const s = desk({ focused: "notes" });
    book.clear(s);
    expect(book.current(s)).toEqual({ kind: "eris" });
    expect(book.current(desk({ focused: "mail" }))).toEqual({ kind: "window", id: "mail" });
  });

  it("the_sweeps_selection_is_the_address", () => {
    const sweep = { mode: "select" as const, selected: ["notes", "mail"], context: null };
    expect(followed(desk({ focused: "notes", sweep }))).toEqual({
      kind: "windows",
      ids: ["notes", "mail"],
    });
    const one = { ...sweep, selected: ["mail"] };
    expect(followed(desk({ focused: "notes", sweep: one }))).toEqual({
      kind: "window",
      id: "mail",
    });
  });

  it("an_agent_window_makes_the_line_go_to_that_agent", () => {
    const s = desk(
      { focused: "agent:mira" },
      { "1": [win("agent:mira"), win("w9", "local:claude")] },
    );
    expect(followed(s)).toEqual({
      kind: "agent",
      agent: "mira",
      local: false,
      window: "agent:mira",
      view: "agent:mira",
    });
    expect(followed({ ...s, focused: "local:claude" })).toEqual({
      kind: "agent",
      agent: "claude",
      local: true,
      window: "w9",
      view: "local:claude",
    });
  });

  it("a window on another desktop is elsewhere, and Alt+Up cycles the desktop in front then Eris", () => {
    const s = desk({ focused: "files" });
    expect(followed(s)).toEqual({ kind: "window", id: "files" });
    expect(elsewhere(s, followed(s))).toBe(true);
    expect(cycleOf(s).map((a) => (a.kind === "window" ? a.id : a.kind))).toEqual([
      "mail",
      "notes",
      "eris",
    ]);
    const book = new TalkAddressBook();
    book.cycle(desk());
    expect(book.current(desk())).toEqual({ kind: "window", id: "mail" });
    book.cycle(desk());
    book.cycle(desk());
    expect(book.current(desk())).toEqual({ kind: "eris" });
  });
});
