/**
 * The side's own parts beyond FT-03's conversations (ADR 0411, FT-07): the Home and Chat tabs; on
 * Chat the Topics section, each topic unfolding to its threads and "New thread"; on Home one box
 * of two rows, Routines and Outputs, with their counts; and the list a row shows in the thread's
 * place. Every list says when it is reading, empty or could not be read.
 */
import type { StudioConversation, StudioOutputs } from "@endue-ai/bridge";
import type { ShellCtx } from "../../../shell/context";
import { type Child, h } from "../../../shell/dom";
import { icon } from "../../../shell/icons";
import type { EndueKey } from "../copy";
import { text } from "../parts";
import { when } from "./model";
import {
  type List,
  outputsLine,
  routineRan,
  routineStarts,
  type SideControl,
  type SidePanel,
} from "./side-lists";

export interface SideViewOptions {
  lists: SideControl;
  /** The outputs as the facets read them; undefined while they are read. */
  outputs: StudioOutputs | undefined;
  /** A thread row, as FT-03 draws a conversation. */
  row(c: StudioConversation): HTMLElement;
  newThread(topicId: string): void;
  /** Open the agent's page on endue.ai (topics are added there; outputs show there). */
  openWeb(): void;
}

/** Reading, none, or could not be read with "Read again"; null when the list has rows. */
export function listState<T>(
  ctx: ShellCtx,
  list: List<T>,
  none: EndueKey,
  again: () => void,
): Child {
  if (list.state === "reading" && !list.items.length)
    return h(
      "div",
      { class: "thread-side-skeleton", role: "status", "aria-label": text(ctx, "sideReading") },
      [0, 1, 2].map(() => h("span", { class: "thread-skeleton" })),
    );
  if (list.state === "failed")
    return h(
      "div",
      { class: "thread-side-unread", role: "alert", "data-unread": "true" },
      h("p", {}, text(ctx, "sideUnread", { why: list.failure })),
      h(
        "button",
        { class: "btn btn-xs", type: "button", "data-action": "side-read-again", onClick: again },
        text(ctx, "sideReadAgain"),
      ),
    );
  if (!list.items.length)
    return h("p", { class: "thread-note", "data-none": "true" }, text(ctx, none));
  return null;
}

export function sideTabs(ctx: ShellCtx, lists: SideControl): HTMLElement {
  const now = lists.state().tab;
  const tab = (key: "home" | "chat", label: EndueKey) =>
    h(
      "button",
      {
        class: `segment thread-side-tab${now === key ? " is-selected" : ""}`,
        type: "button",
        role: "tab",
        "data-side-tab": key,
        "data-key": `side-tab-${key}`,
        "aria-selected": now === key ? "true" : "false",
        onClick: () => lists.tab(key),
      },
      text(ctx, label),
    );
  return h(
    "div",
    { class: "segmented thread-side-tabs", role: "tablist", "aria-label": text(ctx, "sideTabs") },
    tab("home", "sideHome"),
    tab("chat", "sideChat"),
  );
}

export function topicsSection(ctx: ShellCtx, o: SideViewOptions): HTMLElement {
  const s = o.lists.state();
  const topics = s.topics;
  const lang = ctx.store.get().lang;
  const topicRow = (t: (typeof topics.items)[number]) => {
    const open = s.unfolded.includes(t.id);
    const threads = s.threads[t.id];
    return h(
      "li",
      { "data-topic": t.id },
      h(
        "button",
        {
          class: "menu-item thread-side-row thread-topic",
          type: "button",
          "aria-expanded": open ? "true" : "false",
          "data-key": `topic-${t.id}`,
          onClick: () => o.lists.unfold(t.id),
        },
        h("span", { class: "thread-chevron", "aria-hidden": "true" }, icon("chevron-down", 12)),
        h(
          "span",
          { class: "thread-side-text" },
          h("span", { class: "thread-side-title" }, `# ${t.name}`),
        ),
        t.lastActivityAt
          ? h(
              "time",
              { class: "thread-side-time", datetime: t.lastActivityAt },
              when(lang, t.lastActivityAt, ctx.wall()),
            )
          : null,
      ),
      open && threads
        ? h(
            "ul",
            { class: "thread-side-list thread-topic-threads" },
            threads.items.map((c) => o.row(c)),
            h(
              "li",
              {},
              listState(ctx, threads, "sideNoThreads", () => o.lists.unfold(t.id)),
            ),
            h(
              "li",
              {},
              h(
                "button",
                {
                  class: "menu-item thread-side-row thread-new-thread",
                  type: "button",
                  "data-action": "new-thread",
                  "data-key": `new-thread-${t.id}`,
                  onClick: () => o.newThread(t.id),
                },
                icon("plus", 12),
                h("span", { class: "thread-side-title" }, text(ctx, "sideNewThread")),
              ),
            ),
          )
        : null,
    );
  };
  return h(
    "section",
    { class: "thread-side-section", "data-section": "topics" },
    h(
      "div",
      { class: "thread-side-headrow" },
      h("h3", { class: "thread-side-heading" }, text(ctx, "sideTopics")),
      topics.state === "read"
        ? h("span", { class: "thread-side-count", "data-count": "topics" }, String(topics.total))
        : null,
      h(
        "button",
        {
          class: "add-button thread-side-add",
          type: "button",
          "aria-label": text(ctx, "sideAddTopic"),
          "data-action": "add-topic",
          onClick: o.openWeb,
        },
        icon("plus", 12),
      ),
    ),
    h("ul", { class: "thread-side-list" }, topics.items.map(topicRow)),
    listState(ctx, topics, "sideNoTopics", o.lists.again),
  );
}

export function homeBox(ctx: ShellCtx, o: SideViewOptions): HTMLElement {
  const s = o.lists.state();
  const count = (panel: SidePanel) => {
    if (panel === "outputs") return o.outputs ? String(o.outputs.count) : "";
    return s.routines.state === "read" ? String(s.routines.total) : "";
  };
  const item = (panel: SidePanel, glyph: string, label: EndueKey) =>
    h(
      "button",
      {
        class: `menu-item thread-side-row thread-home-row${s.panel === panel ? " is-selected" : ""}`,
        type: "button",
        "data-panel": panel,
        "data-key": `panel-${panel}`,
        ...(s.panel === panel ? { "aria-current": "true" } : {}),
        onClick: () => o.lists.show(s.panel === panel ? undefined : panel),
      },
      icon(glyph, 14),
      h("span", { class: "thread-side-title" }, text(ctx, label)),
      h("span", { class: "thread-side-count", "data-count": panel }, count(panel)),
    );
  return h(
    "div",
    { class: "thread-home-box", "data-section": "home" },
    item("routines", "clock", "sideRoutines"),
    item("outputs", "layers", "sideOutputs"),
  );
}

/** The list a Home row shows in the thread's place, with the way back. */
export function sidePanel(
  ctx: ShellCtx,
  o: Pick<SideViewOptions, "lists" | "outputs" | "openWeb">,
): Child[] {
  const s = o.lists.state();
  const lang = ctx.store.get().lang;
  const at = ctx.wall();
  const back = h(
    "button",
    {
      class: "btn btn-xs thread-panel-back",
      type: "button",
      "data-action": "panel-back",
      onClick: () => o.lists.show(undefined),
    },
    text(ctx, "sideBack"),
  );
  if (s.panel === "routines") {
    const routines = s.routines;
    return [
      back,
      h("h2", { class: "thread-panel-title" }, text(ctx, "sideRoutines")),
      h(
        "ul",
        { class: "thread-panel-list", "data-list": "routines" },
        routines.items.map((r) =>
          h(
            "li",
            { class: "thread-panel-row", "data-routine": r.id },
            h(
              "span",
              { class: "thread-side-text" },
              h("span", { class: "thread-side-title" }, r.name),
              h(
                "span",
                { class: "thread-panel-sub", "data-starts": "true" },
                routineStarts(lang, r),
              ),
              h("span", { class: "thread-panel-sub" }, routineRan(lang, r, at)),
            ),
            h(
              "span",
              { class: `tag thread-routine-state${r.enabled ? " is-on" : ""}` },
              text(ctx, r.enabled ? "sideRoutineOn" : "sideRoutineOff"),
            ),
          ),
        ),
      ),
      listState(ctx, routines, "sideNoRoutines", o.lists.again),
    ];
  }
  const outputs = o.outputs;
  return [
    back,
    h("h2", { class: "thread-panel-title" }, text(ctx, "sideOutputs")),
    outputs && outputs.count > 0
      ? h(
          "div",
          { class: "thread-panel-row", "data-list": "outputs" },
          h("span", { class: "thread-side-title" }, outputsLine(lang, outputs, at)),
          h(
            "button",
            {
              class: "btn btn-xs",
              type: "button",
              "data-action": "open-outputs",
              onClick: o.openWeb,
            },
            text(ctx, "sideOpenOutputs"),
          ),
        )
      : h("p", { class: "thread-note", "data-none": "true" }, text(ctx, "sideNoOutputs")),
  ];
}
