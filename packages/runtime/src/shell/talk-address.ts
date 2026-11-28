/**
 * What the next line on the talk line is about (FT-04, ADR 0407): one address, Eris by default. It
 * follows the window in use (`s.focused`) or the sweep's selection (ADR 0296) until the person pins
 * it, and Eris again once they clear it. A window address goes to Eris with `about`; an agent's
 * window sends the line to that agent instead. An address grants nothing: a line about a window
 * still asks every question it asks today.
 */
import { tabsOf } from "../surface/tree";
import { ENDUE_AGENT_VIEW } from "../system/endue-ids";
import { LOCAL_VIEW } from "../system/local-ids";
import { desktopId } from "./actions";
import type { DeskState } from "./state";

export type TalkAddress =
  | { kind: "eris" }
  | { kind: "window"; id: string }
  | { kind: "windows"; ids: string[] }
  /**
   * An agent's window: an endue agent's (`endue-agent:<id>`, `agent:<id>`), whose `view` it is, or a
   * local agent's screen (`local:<id>`).
   */
  | { kind: "agent"; agent: string; local: boolean; window: string; view: string };

export const ERIS: TalkAddress = { kind: "eris" };

/**
 * The event a line to an endue agent is sent as, on the document: `{ agent, view, text }`. The
 * agent's window takes it (and calls `preventDefault`) once it holds a conversation (FT-03).
 */
export const AGENT_LINE = "desk:talk-agent-line";

/** Where a window is: the desktop it is on, or `drawer`; undefined once it is closed. */
export function whereIs(s: DeskState, id: string): string | undefined {
  for (const [desktop, windows] of Object.entries(s.wm.windows)) {
    if (windows.some((w) => w.id === id)) return desktop;
  }
  return s.drawer.some((d) => d.placement?.id === id || d.id === id) ? "drawer" : undefined;
}

/** The window that shows surface `view`: one whose id it is, or one with a tab of it. */
export function windowShowing(s: DeskState, view: string): string | undefined {
  const all = Object.values(s.wm.windows).flat();
  return (all.find((w) => w.id === view) ?? all.find((w) => tabsOf(w).some((t) => t.view === view)))
    ?.id;
}

/** The address a window gives: an agent's window is that agent, any other is the window itself. */
export function addressOfWindow(s: DeskState, id: string, view = id): TalkAddress {
  for (const [prefix, local] of [
    [ENDUE_AGENT_VIEW, false],
    ["agent:", false],
    [LOCAL_VIEW, true],
  ] as const) {
    const shown = view.startsWith(prefix) ? view : id.startsWith(prefix) ? id : "";
    if (shown)
      return { kind: "agent", agent: shown.slice(prefix.length), local, window: id, view: shown };
  }
  return whereIs(s, id) ? { kind: "window", id } : ERIS;
}

/** The address that follows the desk: the sweep's selection, else the window in use, else Eris. */
export function followed(s: DeskState): TalkAddress {
  const selected = s.sweep.selected.filter((id) => whereIs(s, id));
  if (selected.length > 1) return { kind: "windows", ids: selected.slice(0, 16) };
  if (selected.length === 1) return addressOfWindow(s, selected[0] as string);
  if (!s.focused) return ERIS;
  const window = windowShowing(s, s.focused);
  return window ? addressOfWindow(s, window, s.focused) : ERIS;
}

/** The windows an address names. */
export function windowsOf(address: TalkAddress): string[] {
  if (address.kind === "window") return [address.id];
  if (address.kind === "windows") return address.ids;
  if (address.kind === "agent") return [address.window];
  return [];
}

/** Whether every window an address names is still open. */
export function stillOpen(s: DeskState, address: TalkAddress): boolean {
  return windowsOf(address).every((id) => whereIs(s, id) !== undefined);
}

/** Whether the address names a window on a desktop other than the one in front (or put away). */
export function elsewhere(s: DeskState, address: TalkAddress): boolean {
  const here = desktopId(s);
  return windowsOf(address).some((id) => whereIs(s, id) !== here);
}

/** The windows of the desktop in front, front to back, then Eris: what `Alt+Up` cycles through. */
export function cycleOf(s: DeskState): TalkAddress[] {
  // `front` is in desk order, the backmost first.
  const front = [...s.wm.front]
    .reverse()
    .map((w) => w.id)
    .filter((id) => whereIs(s, id) === desktopId(s));
  return [...front.map((id) => addressOfWindow(s, id)), ERIS];
}

export const sameAddress = (a: TalkAddress, b: TalkAddress) =>
  JSON.stringify(a) === JSON.stringify(b);

const books = new WeakMap<object, TalkAddressBook>();

/** The one address book of a desk's store: the talk line shows it and the composer sends by it. */
export function addressBook(store: object): TalkAddressBook {
  const known = books.get(store);
  if (known) return known;
  const book = new TalkAddressBook();
  books.set(store, book);
  return book;
}

/**
 * The talk line's address over time: it follows the desk, a pin holds it until it is cleared or its
 * window closes, and a clear makes it Eris until the window in use or the selection changes.
 */
export class TalkAddressBook {
  #pinned: TalkAddress | null = null;
  /** What the desk followed when the person cleared the address, which stays cleared meanwhile. */
  #cleared: TalkAddress | null = null;

  /** The address now. */
  current(s: DeskState): TalkAddress {
    if (this.#pinned && !stillOpen(s, this.#pinned)) this.#pinned = null;
    if (this.#pinned) return this.#pinned;
    const follow = followed(s);
    if (this.#cleared && sameAddress(this.#cleared, follow)) return ERIS;
    this.#cleared = null;
    return follow;
  }

  pinned(): boolean {
    return this.#pinned !== null;
  }

  /** Pin `address` (the current one by default), or unpin when it is pinned already. */
  pin(s: DeskState, address = this.current(s)): void {
    if (this.#pinned && sameAddress(this.#pinned, address)) this.#pinned = null;
    else this.#pinned = address.kind === "eris" ? null : address;
  }

  /** Back to Eris, until the desk gives another address. */
  clear(s: DeskState): void {
    this.#pinned = null;
    this.#cleared = followed(s);
  }

  /** The next address of `cycleOf`, pinned. */
  cycle(s: DeskState): void {
    const all = cycleOf(s);
    const now = this.current(s);
    const at = all.findIndex((a) => sameAddress(a, now));
    const next = all[(at + 1) % all.length] ?? ERIS;
    if (next.kind === "eris") this.clear(s);
    else this.#pinned = next;
  }
}
