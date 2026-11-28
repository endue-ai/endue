// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { borderPoint, windowBox } from "../eris/errand-targets";
import { SAY_TO_ERIS } from "../eris/look";
import type { LocalWindowManager } from "../wm/local";
import { testWindowManager } from "../wm/testing";
import { takeDesk } from "../wm/view";
import { mountComposer, wayOf } from "./Composer";
import type { ShellCtx } from "./context";
import { Store, sampleState } from "./state";
import { AGENT_LINE, addressBook } from "./talk-address";

/** Any desk snapshot: what the composer sends with every line. */
const DESK = expect.objectContaining({ screen: expect.any(Object), windows: expect.any(Array) });

describe("the talk line", () => {
  let root: HTMLDivElement;
  let input: HTMLInputElement;
  let dispose: () => void;
  let store: Store;
  let wm: LocalWindowManager;
  let ctx: ShellCtx;
  const brainSay = vi.fn();
  const notify = vi.fn();
  const erisSay = vi.fn();
  const commands = vi.fn(() => [] as { id: string; title: string; keywords: string[] }[]);

  beforeEach(() => {
    vi.clearAllMocks();
    brainSay.mockReset().mockResolvedValue({ text: "Hello" });
    commands.mockReset().mockReturnValue([]);
    store = new Store(sampleState("en", 0));
    wm = testWindowManager();
    wm.connect((published) => takeDesk(store, published));
    root = document.createElement("div");
    root.className = "shell";
    document.body.append(root);
    ctx = {
      store,
      wm,
      runtime: { commands: { list: commands, has: () => false }, notify },
      bridge: { brain: { say: brainSay } },
      eris: {
        say: erisSay,
        setState: (state: Parameters<ShellCtx["eris"]["setState"]>[0]) =>
          store.set((s) => ({ eris: { ...s.eris, state } })),
      },
      ticker: { animate: () => Promise.resolve() },
      reduced: () => true,
      keyOf: () => undefined,
      tr: (key: string) => `${store.get().lang}:${key}`,
    } as unknown as ShellCtx;
    dispose = mountComposer(root, ctx);
    input = root.querySelector("input") as HTMLInputElement;
  });

  afterEach(() => {
    dispose();
    root.remove();
  });

  function type(text: string) {
    input.focus();
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function key(key: string, init: KeyboardEventInit = {}) {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    input.dispatchEvent(event);
    return event;
  }

  for (const source of ["talk line", "describe handoff"] as const) {
    it(`returns to idle and shows one localized notice when the brain fails from the ${source}`, async () => {
      store.set({ lang: "ko" });
      brainSay.mockRejectedValueOnce(new Error("offline"));
      if (source === "talk line") {
        type("hello");
        key("Enter");
      } else {
        document.dispatchEvent(new CustomEvent(SAY_TO_ERIS, { detail: { text: "hello" } }));
      }
      expect(store.get().eris.state).toBe("thinking");
      await vi.waitFor(() => expect(store.get().eris.state).toBe("idle"));
      expect(brainSay).toHaveBeenCalledExactlyOnceWith("hello", expect.any(Function), DESK);
      expect(erisSay).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledOnce();
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ title: expect.stringMatching(/^ko:/) }),
      );
    });
  }

  for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
    it(`does not send Enter during composition (${JSON.stringify(init)})`, () => {
      type("hello");
      const event = key("Enter", init);
      expect(event.defaultPrevented).toBe(false);
      expect(brainSay).not.toHaveBeenCalled();
      expect(input.value).toBe("hello");
    });

    it(`leaves arrows and Escape to the IME (${JSON.stringify(init)})`, () => {
      commands.mockReturnValue([{ id: "hello", title: "Hello", keywords: ["hello"] }]);
      type("hello");
      for (const name of ["ArrowDown", "ArrowUp", "Escape"]) {
        expect(key(name, init).defaultPrevented).toBe(false);
        expect(store.get().composer).toEqual({ open: true, text: "hello", selected: 0 });
        expect(input.value).toBe("hello");
      }
    });
  }

  it("sends the line on a plain Enter", async () => {
    type("hello");
    expect(key("Enter").defaultPrevented).toBe(true);
    expect(input.value).toBe("");
    // Once desk-wm has answered the snapshot the line goes with.
    await vi.waitFor(() =>
      expect(brainSay).toHaveBeenCalledExactlyOnceWith("hello", expect.any(Function), DESK),
    );
  });

  it("sends the desk the person sees with the line: its screen and its windows (ADR 0109)", async () => {
    await wm.edit([{ op: "adopt", id: "endue.notes", title: "Notes" }]);
    type("what is in here?");
    key("Enter");
    await vi.waitFor(() => expect(brainSay).toHaveBeenCalledOnce());
    const desk = brainSay.mock.calls[0]?.[2];
    expect(desk.screen).toEqual({ w: expect.any(Number), h: expect.any(Number) });
    const notes = desk.windows.find((w: { id: string }) => w.id === "endue.notes");
    expect(notes.panes).toEqual([
      { id: "p1", view: "plugin:endue.notes", plugin: "endue.notes", title: "Notes" },
    ]);
  });

  it("keeps the empty talk line open when the Desk window loses focus", () => {
    input.focus();
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    try {
      input.dispatchEvent(new FocusEvent("blur"));
      expect(store.get().composer.open).toBe(true);
    } finally {
      hasFocus.mockRestore();
    }

    const button = document.createElement("button");
    root.append(button);
    button.focus();
    expect(store.get().composer.open).toBe(false);
  });

  it("navigates options with arrows and closes with Escape outside composition", () => {
    commands.mockReturnValue([{ id: "hello", title: "Hello", keywords: ["hello"] }]);
    type("hello");
    expect(key("ArrowDown").defaultPrevented).toBe(true);
    expect(store.get().composer.selected).toBe(1);
    expect(key("ArrowUp").defaultPrevented).toBe(true);
    expect(store.get().composer.selected).toBe(0);
    expect(key("Escape").defaultPrevented).toBe(true);
    expect(store.get().composer.open).toBe(false);
    expect(input.value).toBe("");
  });

  it("a_line_about_a_window_sends_about", async () => {
    await wm.edit([{ op: "adopt", id: "endue.notes", title: "Notes" }]);
    store.set({ focused: "endue.notes" });
    type("summarise this");
    key("Enter");
    await vi.waitFor(() => expect(brainSay).toHaveBeenCalledOnce());
    // An address grants nothing: the line and its permission are as before, with `about`.
    expect(brainSay.mock.calls[0]?.[0]).toBe("summarise this");
    expect(brainSay.mock.calls[0]?.[2].about).toEqual({ windows: ["endue.notes"] });
  });

  it("a_line_to_an_agent_does_not_reach_brain_say", async () => {
    await wm.edit([{ op: "adopt", id: "agent:mira", title: "Mira" }]);
    addressBook(store).pin(store.get(), {
      kind: "agent",
      agent: "mira",
      local: false,
      window: "agent:mira",
      view: "agent:mira",
    });
    const heard = vi.fn((e: Event) => e.preventDefault());
    document.addEventListener(AGENT_LINE, heard);
    try {
      type("are you there?");
      key("Enter");
      await vi.waitFor(() => expect(heard).toHaveBeenCalledOnce());
      const line = heard.mock.calls[0]?.[0] as CustomEvent | undefined;
      expect(line?.detail).toEqual({
        agent: "mira",
        view: "agent:mira",
        text: "are you there?",
      });
      expect(brainSay).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener(AGENT_LINE, heard);
    }
  });

  it("a_sent_line_flies_to_its_address", async () => {
    await wm.edit([{ op: "adopt", id: "endue.notes", title: "Notes" }]);
    store.set({ focused: "endue.notes" });
    type("summarise this");
    key("Enter");
    // The line fades where it stands; a trail in the star's colour leaves for the window.
    expect(root.querySelector(".absorb")).not.toBeNull();
    expect(root.querySelectorAll('.trail[data-tone="star"]')).toHaveLength(1);
    const from = { x: 0, y: 0 };
    const box = windowBox(root, "endue.notes", ctx);
    expect(box).toBeDefined();
    // It ends on the window's border facing the line, where the link's ring is.
    expect(wayOf(root, "endue.notes", from, ctx)(1)).toEqual(borderPoint(box as never, from));
    await vi.waitFor(() => expect(brainSay).toHaveBeenCalledOnce());
  });

  it("with_no_address_it_flies_to_eris", async () => {
    const body = document.createElement("div");
    body.className = "eris-body";
    const rect = { left: 600, top: 80, width: 40, height: 40, right: 640, bottom: 120 };
    body.getBoundingClientRect = () => ({ ...rect, x: 600, y: 80, toJSON: () => rect });
    root.append(body);
    type("hello");
    key("Enter");
    expect(root.querySelectorAll(".trail")).toHaveLength(1);
    expect(wayOf(root, undefined, { x: 0, y: 0 }, ctx)(1)).toEqual({ x: 620, y: 100 });
    await vi.waitFor(() => expect(brainSay).toHaveBeenCalledOnce());
  });
});
