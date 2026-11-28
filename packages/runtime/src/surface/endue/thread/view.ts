/**
 * The thread's rows (ADR 0411): the person's bubbles at the right, the agent's prose with its
 * time, the "New messages" line where the previous read falls, each turn's work as a box that
 * unfolds its tool groups, "Used in this turn", and the run in flight with what it needs.
 */
import type { StudioMessage, StudioWork } from "@endue-ai/bridge";
import { prose } from "../../../eris/prose";
import type { ShellCtx } from "../../../shell/context";
import { type Child, h } from "../../../shell/dom";
import { icon } from "../../../shell/icons";
import { text } from "../parts";
import { newLineAt, type Run, type Thread, used, when, workLine } from "./model";

export interface RowsOptions {
  /** The work boxes unfolded, by message id ("run" for the one in flight). */
  open: Set<string>;
  toggle(id: string): void;
  retry(): void;
  openWeb(): void;
  failure: string;
}

function workBox(
  ctx: ShellCtx,
  id: string,
  work: StudioWork,
  running: boolean,
  o: RowsOptions,
): HTMLElement {
  const lang = ctx.store.get().lang;
  const open = o.open.has(id);
  const groups = `thread-work-${id}`;
  return h(
    "div",
    { class: "thread-work", "data-work": running ? "running" : work.phase },
    h(
      "button",
      {
        class: "menu-item thread-work-head",
        type: "button",
        "aria-expanded": open ? "true" : "false",
        "aria-controls": groups,
        "data-key": `work-${id}`,
        title: text(ctx, "threadWorkDetails"),
        onClick: () => o.toggle(id),
      },
      running
        ? h("span", {
            class: "thread-star",
            role: "img",
            "aria-label": text(ctx, "threadWorking"),
            "data-working": "true",
          })
        : null,
      h("span", { class: "thread-work-line" }, workLine(lang, work, ctx.wall(), running)),
      work.failed
        ? h(
            "span",
            { class: "thread-work-failed" },
            text(ctx, "threadWorkFailed", { n: work.failed }),
          )
        : null,
      h("span", { class: "thread-chevron", "aria-hidden": "true" }, icon("chevron-down", 14)),
    ),
    h(
      "ul",
      { class: "thread-work-groups", id: groups, ...(open ? {} : { hidden: true }) },
      work.groups.map((g) =>
        h(
          "li",
          { class: "thread-work-group", "data-failed": g.failed ? "true" : "false" },
          h("span", { class: "thread-group-label" }, g.label),
          g.provider ? h("span", { class: "thread-group-provider" }, g.provider) : null,
          h("span", { class: "thread-group-calls" }, text(ctx, "threadGroupCalls", { n: g.calls })),
          g.failed
            ? h(
                "span",
                { class: "thread-work-failed" },
                text(ctx, "threadWorkFailed", { n: g.failed }),
              )
            : null,
        ),
      ),
    ),
  );
}

function usedRow(ctx: ShellCtx, work: StudioWork | undefined): Child {
  const { labels, more } = used(work);
  if (!labels.length) return null;
  return h(
    "div",
    { class: "thread-used" },
    h("span", { class: "thread-used-label" }, text(ctx, "threadUsed")),
    h(
      "ul",
      { class: "thread-chips" },
      labels.map((label) => h("li", { class: "tag" }, label)),
      more ? h("li", { class: "tag" }, text(ctx, "threadMore", { n: more })) : null,
    ),
  );
}

function message(ctx: ShellCtx, m: StudioMessage, o: RowsOptions): HTMLElement {
  const time = h(
    "time",
    { class: "thread-time", datetime: m.createdAt },
    when(ctx.store.get().lang, m.createdAt, ctx.wall()),
  );
  if (m.role === "user")
    return h(
      "li",
      { class: "thread-row is-mine", "data-message": m.id },
      h("div", { class: "thread-bubble" }, m.text),
      time,
    );
  return h(
    "li",
    { class: "thread-row is-agent", "data-message": m.id },
    m.work ? workBox(ctx, m.id, m.work, false, o) : null,
    h("div", { class: "thread-prose" }, prose(document, m.text)),
    usedRow(ctx, m.work),
    time,
  );
}

/** Every message held, with the new-messages line where the previous read falls. */
export function messageRows(ctx: ShellCtx, t: Thread, o: RowsOptions): Child[] {
  if (t.reading && !t.messages.length)
    return [
      h(
        "li",
        { class: "thread-reading", "aria-label": text(ctx, "threadReading") },
        [0, 1, 2].map(() => h("span", { class: "thread-skeleton" })),
      ),
    ];
  const line = newLineAt(t.messages, t.previousReadAt);
  return t.messages.flatMap((m, i) => [
    i === line
      ? h(
          "li",
          { class: "thread-new", role: "separator", "aria-label": text(ctx, "threadNewMessages") },
          h("span", { class: "thread-new-label" }, text(ctx, "threadNewMessages")),
        )
      : null,
    message(ctx, m, o),
  ]);
}

/** The run in flight, a stop, or what failed: below the messages. */
export function runRow(ctx: ShellCtx, t: Thread, o: RowsOptions): Child {
  const run: Run | undefined = t.run;
  if (!run) {
    if (o.failure)
      return h(
        "div",
        { class: "thread-callout", "data-tone": "danger", role: "alert" },
        h(
          "p",
          { class: "thread-callout-body" },
          text(ctx, "threadSendFailed", { message: o.failure }),
        ),
      );
    return t.stopped ? h("p", { class: "thread-note" }, text(ctx, "threadStopped")) : null;
  }
  const running = run.state !== "failed";
  return h(
    "div",
    { class: "thread-row is-agent is-running", "data-run": run.state, "aria-live": "polite" },
    run.work
      ? workBox(ctx, "run", run.work, running, o)
      : running
        ? h(
            "p",
            { class: "thread-working" },
            h("span", {
              class: "thread-star",
              role: "img",
              "aria-label": text(ctx, "threadWorking"),
              "data-working": "true",
            }),
            text(ctx, "threadWorking"),
          )
        : null,
    run.text ? h("div", { class: "thread-prose" }, prose(document, run.text)) : null,
    run.state === "needs"
      ? h(
          "div",
          { class: "thread-callout", "data-tone": "warning" },
          h(
            "div",
            { class: "thread-callout-body" },
            h("p", { class: "thread-callout-title" }, text(ctx, "threadNeedsYou")),
            h("p", {}, run.message ?? text(ctx, "threadNeedsOpen")),
          ),
          h(
            "button",
            { class: "btn btn-xs", type: "button", "data-action": "open-web", onClick: o.openWeb },
            text(ctx, "threadOpenWeb"),
          ),
        )
      : null,
    run.state === "failed"
      ? h(
          "div",
          { class: "thread-callout", "data-tone": "danger", role: "alert" },
          h(
            "p",
            { class: "thread-callout-body" },
            run.message
              ? text(ctx, "threadFailed", { message: run.message })
              : text(ctx, "threadFailedPlain"),
          ),
          run.line
            ? h(
                "button",
                {
                  class: "btn btn-xs",
                  type: "button",
                  "data-action": "try-again",
                  onClick: o.retry,
                },
                text(ctx, "threadTryAgain"),
              )
            : null,
        )
      : null,
  );
}
