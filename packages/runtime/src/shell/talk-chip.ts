/**
 * The talk line's chip (FT-04, ADR 0407): `→ <window title>` names what the next line is about, at
 * rest too. A press pins it (`aria-pressed`), its close button clears it to Eris. Its accessible
 * name is "About <title>" or "To <agent>"; a window on another desktop says so.
 */
import { shownTab } from "../surface/tree";
import { agentName } from "../system/agents";
import { localName } from "../system/local-ids";
import type { ShellCtx } from "./context";
import { h } from "./dom";
import { icon } from "./icons";
import { addressBook, elsewhere, type TalkAddress, whereIs, windowsOf } from "./talk-address";
import { surfaceTitle } from "./titles";

/** What an address is called: the window's title, the agent's name, or how many windows. */
export function addressName(ctx: ShellCtx, address: TalkAddress): string {
  const s = ctx.store.get();
  if (address.kind === "eris") return ctx.tr("composerLabel");
  if (address.kind === "windows") return ctx.tr("talkWindows", { n: String(address.ids.length) });
  // The line goes to the agent, so the chip names it, not its screen.
  if (address.kind === "agent") {
    if (address.local) return localName(s.localAgents, address.agent);
    if (address.view.startsWith("agent:")) return agentName(s, address.agent);
    return surfaceTitle(ctx, address.view);
  }
  const all = Object.values(s.wm.windows).flat();
  const window = all.find((w) => w.id === address.id);
  return surfaceTitle(ctx, window ? shownTab(window).view : address.id);
}

/** Where an address's window is, when not on the desktop in front: "on desktop 2", "put away". */
function whereSaid(ctx: ShellCtx, address: TalkAddress): string {
  const s = ctx.store.get();
  if (address.kind === "eris" || !elsewhere(s, address)) return "";
  const id = windowsOf(address)[0];
  const desktop = id ? whereIs(s, id) : undefined;
  if (desktop === "drawer") return ctx.tr("talkPutAway");
  const at = s.wm.desktops.findIndex((d) => d.id === desktop);
  return ctx.tr("talkOnDesktop", { n: String(at + 1) });
}

/** Mount the chip into `parent`; `changed` runs after a pin or a clear. */
export function talkChip(ctx: ShellCtx, changed: () => void) {
  const book = addressBook(ctx.store);
  const text = h("span", { class: "talk-chip-text" });
  const mark = h("span", { class: "talk-chip-mark", "aria-hidden": "true" });
  const where = h("span", { class: "talk-chip-where" });
  const pin = h(
    "button",
    {
      class: "desk-chip talk-chip-pin",
      type: "button",
      onClick: (e: Event) => {
        e.stopPropagation();
        book.pin(ctx.store.get());
        changed();
      },
    },
    mark,
    text,
    where,
  );
  const clear = h(
    "button",
    {
      class: "icon-button talk-chip-clear",
      type: "button",
      onClick: (e: Event) => {
        e.stopPropagation();
        book.clear(ctx.store.get());
        changed();
      },
    },
    icon("close", 12),
  );
  const el = h("span", { class: "talk-chip" }, pin, clear);
  const draw = () => {
    const s = ctx.store.get();
    const address = book.current(s);
    clear.setAttribute("aria-label", ctx.tr("talkClear"));
    el.hidden = address.kind === "eris";
    if (el.hidden) {
      // Hidden, it still names itself: what a line goes to with no address.
      pin.setAttribute("aria-label", ctx.tr("composerLabel"));
      return address;
    }
    const name = addressName(ctx, address);
    const agent = address.kind === "agent";
    text.textContent = name;
    pin.dataset.kind = address.kind;
    const said = whereSaid(ctx, address);
    where.textContent = said ? ` · ${said}` : "";
    pin.setAttribute("aria-pressed", String(book.pinned()));
    // Pinned, a pin; following the window in use, an arrow.
    mark.replaceChildren(book.pinned() ? icon("pin", 12) : "→");
    pin.setAttribute(
      "aria-label",
      [ctx.tr(agent ? "talkTo" : "talkAbout", { x: name }), said].filter(Boolean).join(", "),
    );
    pin.title = name;
    return address;
  };
  return { el, draw };
}
