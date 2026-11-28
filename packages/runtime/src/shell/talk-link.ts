/**
 * The link from the talk line to what its next line is about (FT-04, ADR 0407): a dashed curve
 * from a dot on the talk line's edge to a small ring on the nearest point of the addressed window's
 * border, in the page over the windows, like an errand's thread (`eris/errand-thread.ts`). Nobody is
 * at work, so it is muted, not the star, and its dashes stand still. It is laid again only on a
 * frame where the talk line, the window or the pan moved, and its tick never keeps the frame loop
 * running (ADR 0164). `desk.shell.talk-link` shows it always (60% at rest), under the pointer only,
 * or never.
 */
import { type Box, borderPoint, windowBox } from "../eris/errand-targets";
import type { Point } from "../eris/errand-thread";
import type { ShellCtx } from "./context";
import { listen } from "./dom";
import { elsewhere, type TalkAddress, windowsOf } from "./talk-address";
import { IDLE } from "./ticker";

export const LINK = "desk.shell.talk-link";
export type LinkMode = "always" | "hover" | "off";

const SVG = "http://www.w3.org/2000/svg";
/** Room around the curve for the ring and the line's width. */
const ROOM = 8;

export function linkMode(value: unknown): LinkMode {
  return value === "hover" || value === "off" ? value : "always";
}

const middle = (b: Box): Point => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

/** The link's ends: the talk line's edge facing the window, and the window's border facing that. */
export function linkEnds(pill: Box, target: Box): { from: Point; to: Point } {
  const from = borderPoint(pill, middle(target));
  return { from, to: borderPoint(target, from) };
}

/** A point `t` of the way along the link's shallow curve. */
export function bend(from: Point, to: Point, t: number): Point {
  const lift = Math.sin(Math.PI * t) * Math.min(48, Math.hypot(to.x - from.x, to.y - from.y) / 6);
  return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t - lift };
}

export function linkOf(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS(SVG, "svg");
  svg.setAttribute("class", "talk-link");
  svg.setAttribute("aria-hidden", "true");
  for (const [tag, part] of [
    ["path", "talk-link-line"],
    ["circle", "talk-link-dot"],
    ["circle", "talk-link-ring"],
  ] as const) {
    const el = doc.createElementNS(SVG, tag);
    el.setAttribute("class", part);
    svg.append(el);
  }
  return svg;
}

/** Lay `svg` from `from` to `to`; false, and nothing touched, when neither end moved. */
export function shapeLink(svg: SVGSVGElement, from: Point, to: Point): boolean {
  const key = [from.x, from.y, to.x, to.y].map((n) => n.toFixed(1)).join(" ");
  if (svg.dataset.way === key) return false;
  svg.dataset.way = key;
  const peak = bend(from, to, 0.5);
  const xs = [from.x, to.x, peak.x];
  const ys = [from.y, to.y, peak.y];
  const left = Math.min(...xs) - ROOM;
  const top = Math.min(...ys) - ROOM;
  svg.setAttribute("width", (Math.max(...xs) + ROOM - left).toFixed(1));
  svg.setAttribute("height", (Math.max(...ys) + ROOM - top).toFixed(1));
  svg.style.left = `${left.toFixed(1)}px`;
  svg.style.top = `${top.toFixed(1)}px`;
  const at = (p: Point) => `${(p.x - left).toFixed(1)} ${(p.y - top).toFixed(1)}`;
  // A quadratic curve through the peak: its control point lies twice as far off the chord.
  const control = { x: 2 * peak.x - (from.x + to.x) / 2, y: 2 * peak.y - (from.y + to.y) / 2 };
  const [line, dot, ring] = svg.children;
  line?.setAttribute("d", `M${at(from)}Q${at(control)} ${at(to)}`);
  for (const [el, p, r] of [
    [dot, from, 2.5],
    [ring, to, 4],
  ] as const) {
    const [cx, cy] = at(p).split(" ");
    el?.setAttribute("cx", cx ?? "0");
    el?.setAttribute("cy", cy ?? "0");
    el?.setAttribute("r", String(r));
  }
  return true;
}

/** How strong the link is now: hidden, at rest (60%), or whole. */
export type Strength = "hidden" | "rest" | "full";

export function strengthOf(mode: LinkMode, lit: boolean): Strength {
  if (mode === "off") return "hidden";
  if (lit) return "full";
  return mode === "always" ? "rest" : "hidden";
}

interface Talk {
  pill: HTMLElement;
  address(): TalkAddress;
  /** Under the pointer, open or pinned. */
  lit(): boolean;
}

/** Mount the link on `host` (the shell); call the returned `draw` when the talk line changed. */
export function mountTalkLink(host: HTMLElement, ctx: ShellCtx, talk: Talk) {
  const svg = linkOf(host.ownerDocument);
  svg.setAttribute("hidden", "");
  host.append(svg);
  const settings = ctx.runtime.settings;
  /** Keep laying it until then: the pill grows over `motion-base`. */
  let until = 0;
  const lay = () => {
    const address = talk.address();
    const s = ctx.store.get();
    const ids = windowsOf(address);
    const strength = strengthOf(linkMode(settings.get(LINK, "always")), talk.lit());
    const target =
      ids.length && strength !== "hidden" && !elsewhere(s, address)
        ? windowBox(host, ids[0] as string, ctx)
        : undefined;
    // SVG has no `hidden` property; the attribute hides it (errand.css).
    svg.toggleAttribute("hidden", !target || talk.pill.getClientRects().length === 0);
    if (!target || svg.hasAttribute("hidden")) return;
    svg.dataset.strength = strength;
    const f = host.getBoundingClientRect();
    const r = talk.pill.getBoundingClientRect();
    const pill = { x: r.left - f.left, y: r.top - f.top, w: r.width, h: r.height };
    const { from, to } = linkEnds(pill, target);
    shapeLink(svg, from, to);
  };
  const tick = (now: number) => {
    lay();
    return now < until ? undefined : IDLE;
  };
  const draw = () => {
    lay();
    until = ctx.ticker.now() + 400;
    ctx.ticker.wake();
  };
  const offs = [
    ctx.ticker.add(tick),
    ctx.store.watch((s) => [s.wm, s.pan, s.focused, s.sweep.selected, s.desktop], draw),
    settings.onChange((keys) => {
      if (keys.includes(LINK)) draw();
    }),
    listen(window, "resize", draw),
  ];
  return {
    draw,
    dispose: () => {
      for (const off of offs) off();
      svg.remove();
    },
  };
}
