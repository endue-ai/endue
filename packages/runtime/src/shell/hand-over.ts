/**
 * A window the person puts away is seen going, and one brought back is seen coming (FT-05, ADR
 * 0408): `stash` and `raise` (`actions.ts`) tell this store's hand-overs before their edit, and the
 * drawer, which knows the page, flies a muted trail (`eris/trail.ts`) from the window's middle to its
 * handle, or for an agent's window to that agent's row in the agent bar, and back from the handle to
 * where the window opens. Muted, not the star: nobody is at work. Windows put away in one go fly
 * together, staggered.
 */
import { type Box, centre, windowBox } from "../eris/errand-targets";
import type { Point } from "../eris/errand-thread";
import { straight, trailsOf, type Way } from "../eris/trail";
import type { ShellCtx } from "./context";
import { addressOfWindow } from "./talk-address";

export type HandOver = { act: "away"; window: string } | { act: "back"; item: string };

type Listener = (hand: HandOver) => void;

const books = new WeakMap<object, Set<Listener>>();

/** The hand-overs of `store`: what `actions.ts` tells and the drawer hears. */
export function handOvers(store: object) {
  let heard = books.get(store);
  if (!heard) {
    heard = new Set();
    books.set(store, heard);
  }
  const all = heard;
  return {
    tell(hand: HandOver): void {
      for (const listen of all) listen(hand);
    },
    hear(listen: Listener): () => void {
      all.add(listen);
      return () => all.delete(listen);
    },
  };
}

const middle = (b: Box): Point => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

/** An element laid out on screen. */
const shown = (el: Element | null): el is HTMLElement =>
  el instanceof HTMLElement && !el.hidden && el.getClientRects().length > 0;

/** Where an agent's window goes: its agent's row in the agent bar, if it is there. */
export function rowOf(host: ParentNode, s: ReturnType<ShellCtx["store"]["get"]>, id: string) {
  const address = addressOfWindow(s, id);
  if (address.kind !== "agent") return null;
  const key = CSS.escape(address.agent);
  const rows = address.local
    ? [`[data-local-agent="${key}"]`]
    : [`[data-endue-agent="${key}"]`, `[data-agent="${key}"]`];
  for (const row of rows.flatMap((q) => [...host.querySelectorAll(q)])) if (shown(row)) return row;
  return null;
}

/**
 * Fly what is handed over on `shell()`: to and from `handle` (the drawer's button). Returns what
 * stops hearing.
 */
export function mountHandOvers(
  shell: () => HTMLElement,
  handle: HTMLElement,
  ctx: ShellCtx,
): () => void {
  /** Windows put away in this task: they fly together. */
  let going: Way[] = [];
  const away = (id: string) => {
    const host = shell();
    const at = (el: HTMLElement) => () => centre(el, host);
    const box = windowBox(host, id, ctx);
    const row = rowOf(host, ctx.store.get(), id);
    const to = row ?? (shown(handle) ? handle : null);
    if (!box || !to) return;
    // The window leaves the desk with this edit, so its middle is where it was.
    const from = middle(box);
    going.push(straight(() => from, at(to)));
    if (going.length > 1) return;
    queueMicrotask(() => {
      const ways = going;
      going = [];
      void trailsOf(host, ctx).several(ways, "muted");
    });
  };
  const back = (item: string) => {
    const host = shell();
    const id = ctx.store.get().drawer.find((d) => d.id === item)?.placement?.id;
    if (!id || !shown(handle)) return;
    const from = centre(handle, host);
    // Where it opens, once the window manager has placed it; till then, still at the handle.
    const to = () => {
      const box = windowBox(host, id, ctx);
      return box ? middle(box) : from;
    };
    void trailsOf(host, ctx).fly(
      straight(() => from, to),
      "muted",
    );
  };
  return handOvers(ctx.store).hear((hand) => {
    if (hand.act === "away") away(hand.window);
    else back(hand.item);
  });
}
