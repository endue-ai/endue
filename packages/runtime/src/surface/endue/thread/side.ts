/**
 * The side of an agent's window (ADR 0411): "New chat", then the agent's pinned and recent
 * conversations. A row whose run is in flight shows the star; one that waits for the person says
 * so. Under 720 px of window it is a drawer over the thread.
 */
import type { StudioConversation } from "@endue-ai/bridge";
import type { ShellCtx } from "../../../shell/context";
import { type Child, h } from "../../../shell/dom";
import { text } from "../parts";
import { when } from "./model";
import { homeBox, type SideViewOptions, sideTabs, topicsSection } from "./side-view";

export interface SideOptions {
  selected: string | undefined;
  choose(conversationId: string | undefined): void;
}

/** The agent's conversations: pinned first, then the most recently active. */
export function agentConversations(
  all: StudioConversation[],
  agentId: string,
): { pinned: StudioConversation[]; recent: StudioConversation[] } {
  const mine = all
    .filter((c) => c.agentId === agentId && !c.spaceId && !c.topicId && c.status !== "deleted")
    .sort((a, b) => (b.lastMessageAt ?? b.updatedAt).localeCompare(a.lastMessageAt ?? a.updatedAt));
  return {
    pinned: mine.filter((c) => c.pinnedAt),
    recent: mine.filter((c) => !c.pinnedAt),
  };
}

export function row(ctx: ShellCtx, c: StudioConversation, o: SideOptions): HTMLElement {
  const running = c.lastRunStatus === "running";
  const at = c.lastMessageAt ?? c.updatedAt;
  return h(
    "li",
    {},
    h(
      "button",
      {
        class: `menu-item thread-side-row${o.selected === c.id ? " is-selected" : ""}`,
        type: "button",
        "data-conversation": c.id,
        "data-key": `conversation-${c.id}`,
        ...(o.selected === c.id ? { "aria-current": "true" } : {}),
        onClick: () => o.choose(c.id),
      },
      h(
        "span",
        { class: "thread-side-text" },
        h("span", { class: "thread-side-title" }, c.title || text(ctx, "threadNewChat")),
        c.awaitingInput
          ? h("span", { class: "thread-side-needs" }, text(ctx, "threadNeedsYou"))
          : null,
      ),
      running
        ? h("span", {
            class: "thread-star",
            role: "img",
            "aria-label": text(ctx, "threadWorking"),
            "data-working": "true",
          })
        : null,
      h(
        "time",
        { class: "thread-side-time", datetime: at },
        when(ctx.store.get().lang, at, ctx.wall()),
      ),
    ),
  );
}

function section(
  ctx: ShellCtx,
  key: "threadPinned" | "threadRecent",
  list: StudioConversation[],
  o: SideOptions,
): Child {
  if (!list.length) return null;
  return h(
    "section",
    { class: "thread-side-section", "data-section": key },
    h("h3", { class: "thread-side-heading" }, text(ctx, key)),
    h(
      "ul",
      { class: "thread-side-list" },
      list.map((c) => row(ctx, c, o)),
    ),
  );
}

/** The side: its tabs when the host reads topics and routines, then Home's box or Chat's lists. */
export function sideRows(
  ctx: ShellCtx,
  agentId: string,
  o: SideOptions,
  more?: Omit<SideViewOptions, "row">,
): Child[] {
  if (!more) return chatRows(ctx, agentId, o);
  const view: SideViewOptions = { ...more, row: (c) => row(ctx, c, o) };
  if (more.lists.state().tab === "home") return [sideTabs(ctx, more.lists), homeBox(ctx, view)];
  const [newChat, ...lists] = chatRows(ctx, agentId, o);
  return [sideTabs(ctx, more.lists), newChat, topicsSection(ctx, view), ...lists];
}

function chatRows(ctx: ShellCtx, agentId: string, o: SideOptions): Child[] {
  const { pinned, recent } = agentConversations(ctx.store.get().endue.conversations, agentId);
  return [
    h(
      "button",
      {
        class: `btn thread-new-chat${o.selected === undefined ? " is-selected" : ""}`,
        type: "button",
        "data-action": "new-chat",
        "data-key": "new-chat",
        onClick: () => o.choose(undefined),
      },
      text(ctx, "threadNewChat"),
    ),
    section(ctx, "threadPinned", pinned, o),
    section(ctx, "threadRecent", recent, o),
    pinned.length + recent.length
      ? null
      : h("p", { class: "thread-note" }, text(ctx, "threadNoConversations")),
  ];
}
