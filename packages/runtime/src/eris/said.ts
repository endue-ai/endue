/**
 * Her words on the desk, readable whole wherever she floats (issue 161 findings 6 and 12, issue 158
 * finding 14). A card under her, or above her when there is more room there, inside the desk with
 * 16 px to spare: a short line is soul text and leaves with it; a long one is kept as text, wrapped
 * and scrolling, until the person closes it (its button, Escape) or she says something else. "Show
 * what Eris said" (`desk.eris.said`) brings back her last lines. The card is one of the page's
 * overlays (`popover`), so the compositor draws it above every window and it takes its own presses
 * (ADR 0160, ADR 0166).
 */
import type { BrainTurnReason } from "../bridge/types";
import type { ShellCtx } from "../shell/context";
import { h, listen } from "../shell/dom";
import { icon } from "../shell/icons";
import { erisText } from "./copy";
import { prose } from "./prose";
import type { TurnCard } from "./turn-card";

/** A line longer than this, or of more than one line, is kept in the card as text. */
export const KEEP_CHARS = 60;
/** How many of her lines "Show what Eris said" brings back. */
export const RECALL_LINES = 12;
export const SAID = "desk.eris.said";
const MARGIN = 16;
const GAP = 12;
const WIDTH = 480;
/** Below her unless less than this is left there and more above. */
const ROOM = 120;

export const isLong = (text: string): boolean => {
  const line = text.trim();
  return line.length > KEEP_CHARS || line.includes("\n");
};

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Placed {
  left: number;
  top?: number;
  bottom?: number;
  width: number;
  maxHeight: number;
}

/** What the card keeps clear of (FT-06): the field in use, the talk line, and whether she rests in it. */
export interface Avoid {
  field?: Box | null;
  line?: Box | null;
  /** She rests in the talk line (ADR 0254): the card opens from the line. */
  resting?: boolean;
}

/** How tall the card is reckoned when it is checked against what it must not cover. */
const TALL = 240;
/** The narrowest the card goes beside her. */
const NARROW = 280;

const meets = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** The box a placement takes on a desk `height` tall, reckoned `TALL` at most. */
function boxOf(p: Placed, height: number): Box {
  const tall = Math.min(TALL, p.maxHeight);
  const y = p.top ?? height - (p.bottom ?? 0) - tall;
  return { x: p.left, y, width: p.width, height: tall };
}

/**
 * Where the card goes for her box on a desk of `size`: under her, else above her, else beside her,
 * the first that leaves `avoid`'s field and talk line uncovered; while she rests in the talk line,
 * from the line, above it or, when the line is high, below it.
 */
export function placeSaid(
  eris: Box,
  size: { width: number; height: number },
  avoid: Avoid = {},
): Placed {
  const width = Math.max(0, Math.min(WIDTH, size.width - 2 * MARGIN));
  const leftOf = (centre: number) =>
    Math.round(Math.max(MARGIN, Math.min(centre - width / 2, size.width - MARGIN - width)));
  const below = (b: Box): Placed => {
    const top = b.y + b.height + GAP;
    return {
      left: leftOf(b.x + b.width / 2),
      top: Math.round(top),
      width,
      maxHeight: Math.max(0, Math.round(size.height - MARGIN - top)),
    };
  };
  const above = (b: Box): Placed => ({
    left: leftOf(b.x + b.width / 2),
    bottom: Math.round(size.height - b.y + GAP),
    width,
    maxHeight: Math.max(0, Math.round(b.y - GAP - MARGIN)),
  });
  const { line, field } = avoid;
  if (avoid.resting && line)
    return line.y + line.height / 2 < size.height / 2 ? below(line) : above(line);
  const under = below(eris);
  const over = above(eris);
  const roomBelow = under.maxHeight;
  const roomAbove = over.maxHeight;
  const legacy = roomBelow >= ROOM || roomBelow >= roomAbove ? under : over;
  const clear = [field, line].filter((b): b is Box => !!b);
  if (!clear.length) return legacy;
  const beside = (right: boolean): Placed | undefined => {
    const room = right ? size.width - MARGIN - (eris.x + eris.width + GAP) : eris.x - GAP - MARGIN;
    const w = Math.min(WIDTH, room);
    if (w < NARROW) return undefined;
    const left = right ? eris.x + eris.width + GAP : eris.x - GAP - w;
    const top = Math.max(MARGIN, Math.min(eris.y, size.height - MARGIN - TALL));
    return {
      left: Math.round(left),
      top: Math.round(top),
      width: Math.round(w),
      maxHeight: Math.round(size.height - MARGIN - top),
    };
  };
  const options = [under, over, beside(true), beside(false)].filter(
    (p): p is Placed => p !== undefined && p.maxHeight >= ROOM,
  );
  return options.find((p) => !clear.some((b) => meets(boxOf(p, size.height), b))) ?? legacy;
}

export interface Said {
  readonly el: HTMLElement;
  /** Her new line; true when it is kept in the card as text (the soul text is for the others). */
  say(text: string): boolean;
  /** A failed turn's sentence, kept as text with the command that fixes it (FT-01). */
  fail(text: string, reason: BrainTurnReason): void;
  /** The person's words she heard so far, muted under her (FT-02); "" hides them. */
  hearing(words: string): void;
  /** Show the card while it keeps text or `soul` (a soul line is on screen). */
  update(soul: boolean): void;
  place(eris: Box, size: { width: number; height: number }, avoid?: Avoid): void;
  /** The text the card keeps now, for her label. */
  kept(): string;
  dispose(): void;
}

/** What a failed turn's card offers, by reason: a command that exists, and its words. */
export const FIXES: Partial<
  Record<BrainTurnReason, { command: string; label: "chooseBrain" | "signIn" }>
> = {
  no_brain: { command: "desk.eris.model", label: "chooseBrain" },
  signed_out: { command: "desk.account.sign-in", label: "signIn" },
};

/**
 * Her card in `root`, with the soul text `soul` and, when given, the card of her turn in flight
 * (`turn-card.ts`, FT-06): while that card shows, her answer is in it, not kept again as text.
 */
export function mountSaid(
  root: HTMLElement,
  ctx: ShellCtx,
  soul: HTMLElement,
  turn?: TurnCard,
): Said {
  const tr = (key: "label" | "close" | "title" | "none" | "chooseBrain" | "signIn") =>
    erisText(ctx.store.get().lang, `said.${key}`);
  const text = h("div", { class: "eris-said-text", hidden: true });
  const close = h(
    "button",
    {
      class: "icon-button eris-said-close",
      type: "button",
      hidden: true,
      "aria-label": tr("close"),
      title: tr("close"),
      onClick: () => closeAll(),
    },
    icon("close", 16),
  );
  const fixes = h("div", { class: "eris-said-fixes", hidden: true });
  const heard = h("p", { class: "eris-said-heard", "aria-live": "polite", hidden: true });
  const el = h(
    "section",
    { class: "popover eris-said", "aria-label": tr("label"), hidden: true },
    heard,
    soul,
    text,
    fixes,
    close,
  );
  root.append(el);
  let lines: string[] = [];
  let kept: string[] | null = null;
  let showing = false;
  let placed = "";

  const update = (soulShown: boolean) => {
    showing = soulShown;
    const card = turn?.showing() ?? false;
    // The turn's card is in her card only while it shows, after the words she heard.
    if (turn && card !== turn.el.isConnected) {
      if (card) heard.after(turn.el);
      else turn.el.remove();
    }
    el.hidden = !kept && !soulShown && heard.hidden && !card;
    close.hidden = !kept && !card;
  };
  /** Keep `next` as text: an answer read from its start, her last lines from the newest. */
  const keep = (next: string[] | null, newest = false) => {
    kept = next;
    fixes.hidden = true;
    fixes.replaceChildren();
    text.hidden = !next;
    text.replaceChildren(...(next ?? []).flatMap((line) => prose(document, line)));
    update(showing);
    text.scrollTop = newest ? text.scrollHeight : 0;
  };
  /** The person closed her card: its text and the turn's card. */
  const closeAll = () => {
    turn?.close();
    keep(null);
  };
  const recall = () => keep(lines.length ? lines.slice(-RECALL_LINES) : [tr("none")], true);

  const offs = [
    listen(el, "keydown", (e) => {
      const k = e as KeyboardEvent;
      if (k.key !== "Escape" || (!kept && !turn?.showing())) return;
      k.preventDefault();
      k.stopPropagation();
      closeAll();
    }),
  ];
  // A shell context without commands (a test's) keeps her card all the same.
  const commands = ctx.runtime?.commands;
  if (commands)
    offs.push(
      commands.define(SAID, {
        title: () => tr("title"),
        owner: "desk",
        keywords: ["eris", "said", "answer", "again", "last", "history", "에리스", "답", "말"],
        run: () => recall(),
      }),
    );

  return {
    el,
    say(line) {
      const said = line.trim();
      if (said) lines = [...lines, said].slice(-RECALL_LINES);
      // Her answer is in the turn's card while it shows; the soul text is not for it either.
      if (turn?.showing()) {
        keep(null);
        return true;
      }
      const long = isLong(said);
      keep(long ? [said] : null);
      return long;
    },
    fail(line, reason) {
      const said = line.trim();
      if (said) lines = [...lines, said].slice(-RECALL_LINES);
      keep([said]);
      const fix = FIXES[reason];
      if (!fix) return;
      fixes.append(
        h(
          "button",
          {
            class: "btn btn-outline",
            type: "button",
            "data-fix": reason,
            onClick: () => {
              keep(null);
              void ctx.runtime?.commands.run(fix.command);
            },
          },
          tr(fix.label),
        ),
      );
      fixes.hidden = false;
    },
    hearing(words) {
      const line = words.trim();
      if (heard.textContent === line) return;
      heard.textContent = line;
      heard.hidden = !line;
      update(showing);
    },
    update,
    place(eris, size, avoid) {
      const p = placeSaid(eris, size, avoid);
      const key = JSON.stringify(p);
      if (key === placed) return;
      placed = key;
      el.style.left = `${p.left}px`;
      el.style.width = `${p.width}px`;
      el.style.maxHeight = `${p.maxHeight}px`;
      el.style.top = p.top === undefined ? "" : `${p.top}px`;
      el.style.bottom = p.bottom === undefined ? "" : `${p.bottom}px`;
    },
    kept: () => kept?.join("\n\n") ?? "",
    dispose() {
      for (const off of offs) off();
      el.remove();
    },
  };
}
