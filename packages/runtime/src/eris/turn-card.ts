/**
 * The card of Eris's turn in flight (FT-06, ADR 0409), inside her card under her (`said.ts`): the
 * line she took in, a row per component she goes to (`turn-model.ts`), her answer filling as it
 * comes, and a foot that says how far she is with Stop. Once the turn ends the rows fold into the
 * foot's one line, which opens them again. A turn with no step shows no card: her soul text or her
 * card's text says it, as before. Changes are announced politely, once per state change.
 */
import type { BrainReply, BrainStep } from "../bridge/types";
import { h } from "../shell/dom";
import { icon } from "../shell/icons";
import { erisText } from "./copy";
import { prose } from "./prose";
import { type Component, type Hint, type Row, TurnModel } from "./turn-model";

type Lang = "ko" | "en";
type Key = Parameters<typeof erisText>[1];

/** What the card's buttons do; the desk gives them their meaning. */
export interface TurnActions {
  stop(): void;
  /** A press on a row: its window forward, with its link. */
  press(row: Row): void;
  /** Bring the approval the row waits for forward. */
  review(row: Row): void;
  /** Stop a local agent's run. */
  stopRun(row: Row): void;
  /** Open an endue agent's conversation. */
  conversation(row: Row): void;
}

export interface TurnCard {
  readonly el: HTMLElement;
  /** A new turn of `line`; `about` are the windows the line names, each a waiting row. */
  begin(line: string, about?: Component[]): void;
  step(step: BrainStep, hint?: Hint): void;
  hint(command: string, hint: Hint): void;
  needs(approvalId: string, waiting: boolean): void;
  answer(soFar: string): void;
  /** The turn ended; true when the card stays: it has rows to show. */
  end(reply: Pick<BrainReply, "text" | "reason">): boolean;
  /** Whether the card is on screen now. */
  showing(): boolean;
  running(): boolean;
  /** The person closed it. */
  close(): void;
  /** Keep the foot's seconds current. */
  tick(): void;
}

const seconds = (ms: number) => Math.max(0, Math.round(ms / 1000));

export function mountTurnCard(
  doc: Document,
  lang: () => Lang,
  now: () => number,
  act: TurnActions,
  /** Where a change is said politely; by default a live region of the card's own. */
  announce?: (text: string) => void,
): TurnCard {
  const tr = (key: Key, vars?: Record<string, string | number>) => {
    let text = erisText(lang(), key);
    for (const [k, v] of Object.entries(vars ?? {})) text = text.replaceAll(`{${k}}`, String(v));
    return text;
  };
  const line = h("p", { class: "turn-line" });
  const rows = h("ul", { class: "turn-rows", "aria-label": tr("turn.rows") });
  const answer = h("div", { class: "turn-answer", hidden: true });
  const fold = h("button", {
    class: "btn btn-xs turn-fold",
    type: "button",
    "aria-expanded": "true",
  });
  const stop = h("button", { class: "btn btn-outline turn-stop", type: "button" });
  const foot = h("footer", { class: "turn-foot" }, fold, stop);
  const told = announce ? null : h("p", { class: "sr-only", "aria-live": "polite" });
  const say =
    announce ??
    ((text: string) => {
      if (told) told.textContent = text;
    });
  const el = h(
    "div",
    { class: "turn-card", role: "group", "aria-label": tr("turn.label"), hidden: true },
    line,
    rows,
    answer,
    foot,
    told,
  );
  let turn: TurnModel | undefined;
  let closed = false;
  let open = true;
  let announced = "";
  let shownAnswer = "";
  let shownFoot = "";

  const sentence = (row: Row): string => {
    const title = row.title ?? row.name;
    switch (row.state) {
      case "waiting":
        return tr("turn.waiting");
      case "needs":
        return tr("turn.needs");
      case "failed":
        return row.message
          ? tr("turn.failed", { title, message: row.message })
          : tr("turn.failedPlain", { title });
      case "stopped":
        return tr("turn.stopped");
      case "sent":
        return tr("turn.sent");
      case "done":
        return row.took === undefined || row.took < 100
          ? title
          : `${title} · ${tr("turn.took", { s: (row.took / 1000).toFixed(1) })}`;
      default:
        return title;
    }
  };
  const extra = (row: Row): HTMLElement | null => {
    const button = (label: string, run: () => void, kind: string) =>
      h(
        "button",
        { class: "btn btn-xs turn-row-act", type: "button", "data-act": kind, onClick: run },
        label,
      );
    if (row.state === "needs") return button(tr("turn.review"), () => act.review(row), "review");
    if (row.kind === "agent" && row.state === "working" && row.agent)
      return button(tr("turn.stopRun"), () => act.stopRun(row), "stop-run");
    if (row.kind === "endue" && row.agent)
      return button(tr("turn.conversation"), () => act.conversation(row), "conversation");
    return null;
  };
  const rowEl = (row: Row) => {
    const mark =
      row.state === "done"
        ? icon("check", 14)
        : h("span", { class: "turn-mark", "aria-hidden": "true" });
    const name = h(
      "span",
      { class: "turn-name" },
      row.name,
      row.place ? h("small", {}, row.place) : null,
    );
    const count = row.calls > 1 ? h("span", { class: "turn-count" }, `×${row.calls}`) : null;
    const said = sentence(row);
    const main = h(
      "button",
      {
        class: "menu-item turn-row-main",
        type: "button",
        "aria-label": `${row.name}: ${said}`,
        onClick: () => act.press(row),
      },
      mark,
      name,
      h("span", { class: "turn-say" }, said),
      count,
    );
    return h(
      "li",
      { class: "turn-row", "data-state": row.state, "data-kind": row.kind, "data-row": row.key },
      main,
      extra(row),
    );
  };
  const footText = (t: TurnModel) => {
    const c = t.counts();
    const s = seconds((t.ended ?? now()) - t.started);
    if (!t.outcome) return tr("turn.working", { over: c.over, total: c.total, s });
    if (t.outcome === "stopped") return tr("turn.endedStopped", { steps: c.steps, s });
    if (t.outcome === "failed") return tr("turn.endedFailed", { steps: c.steps, s });
    return c.failed
      ? tr("turn.doneFailed", { steps: c.steps, failed: c.failed, s })
      : tr("turn.done", { steps: c.steps, s });
  };
  const visible = (t: TurnModel | undefined): t is TurnModel => {
    if (!t || closed) return false;
    // A turn with no step is her card's text and soul text, as before: the card is for the work.
    return t.rows().length > 0;
  };

  /** Draw what changed: rows on a state change, the answer as it fills, the foot's words. */
  const draw = (force = false) => {
    const t = turn;
    el.hidden = !visible(t);
    if (!t) return;
    const key = t.key();
    if (force || key !== announced) {
      const list = t.rows();
      rows.replaceChildren(...list.map(rowEl));
      if (key !== announced) {
        const ended = t.outcome ? footText(t) : "";
        const changed = list.map((r) => `${r.name}: ${sentence(r)}`).join(". ");
        say([changed, ended].filter(Boolean).join(". "));
        announced = key;
      }
    }
    if (t.answer !== shownAnswer) {
      shownAnswer = t.answer;
      answer.replaceChildren(...prose(doc, t.answer));
      answer.hidden = !t.answer.trim();
    }
    const words = footText(t);
    if (words !== shownFoot) {
      shownFoot = words;
      fold.textContent = words;
    }
    const over = t.outcome !== undefined;
    stop.hidden = over;
    fold.disabled = !over;
    fold.setAttribute("aria-expanded", String(open || !over));
    rows.hidden = over && !open;
    el.dataset.outcome = t.outcome ?? "running";
  };

  stop.textContent = tr("turn.stop");
  stop.addEventListener("click", () => act.stop());
  fold.addEventListener("click", () => {
    open = !open;
    draw(true);
  });

  return {
    el,
    begin(said, about) {
      turn = new TurnModel(said, now(), about);
      closed = false;
      open = true;
      announced = "";
      shownAnswer = "";
      line.textContent = said;
      line.title = said;
      line.hidden = !said.trim();
      draw(true);
    },
    step(step, hint) {
      turn?.step(step, now(), hint);
      draw();
    },
    hint(command, hint) {
      turn?.hint(command, hint);
      draw(true);
    },
    needs(approvalId, waiting) {
      turn?.needs(approvalId, waiting);
      draw();
    },
    answer(soFar) {
      turn?.delta(soFar);
      draw();
    },
    end(reply) {
      if (!turn) return false;
      turn.end(reply, now());
      // The rows fold into the foot's line; one that failed or needs the person stays open.
      open = turn.rows().some((r) => r.state === "failed");
      draw(true);
      return visible(turn);
    },
    showing: () => !el.hidden,
    running: () => turn !== undefined && !turn.outcome,
    close() {
      closed = true;
      draw();
    },
    tick() {
      if (turn && !turn.outcome && !el.hidden) draw();
    },
  };
}
