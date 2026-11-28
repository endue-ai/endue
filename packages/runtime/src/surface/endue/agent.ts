/**
 * An endue agent's window (ADR 0411, amending ADR 0129 and ADR 0232): the agent's conversation as
 * endue.ai composes it. A header with the agent and its Home and Studio tabs; at the side "New
 * chat" and its conversations (a drawer under 720 px); on Home the thread with each turn's work
 * and the composer; on Studio the board the card's back showed (ADR 0232), unchanged. The frame
 * is built once and its parts redrawn on their own, so the draft, the caret and the reading place
 * survive every change.
 */
import type { ShellCtx } from "../../shell/context";
import { h, render } from "../../shell/dom";
import { icon } from "../../shell/icons";
import {
  agentConversationPage,
  ENDUE_AGENT_VIEW,
  flipCard,
  openOnWeb,
  readFacets,
} from "../../system/endue";
import { openAgentStudio } from "../../system/endue-studio";
import type { Mounted } from "../views";
import { lineSpecs, studioBoardView } from "./board";
import { boardLines } from "./board-lines";
import { studioBoard } from "./board-model";
import { agentFront, dotOf } from "./model";
import { actions, avatar, notice, type Page, readLine, text } from "./parts";
import { composer } from "./thread/composer";
import { threadControl } from "./thread/controller";
import { agentConversations, sideRows } from "./thread/side";
import { messageRows, runRow } from "./thread/view";
import "./thread/thread.css";

export { dotOf } from "./model";

/** How near the foot the reader must be for a new row to keep the thread at the newest. */
const STICK = 24;

export function endueAgentBody(ctx: ShellCtx, id: string): Mounted {
  const view = `${ENDUE_AGENT_VIEW}${id}`;
  const el = h("div", { class: "endue-view endue-chat", "data-endue-agent-view": id });
  const again = () => void readFacets(ctx, id, true);
  const lines = boardLines();
  const opened = new Set<string>();
  let drawer = false;
  /** Whether the person chose a conversation (or a new chat); until then the newest is shown. */
  let chosen = false;
  let expanded: string | null = null;
  const thread = ctx.bridge.studio?.thread;

  const head = h("header", { class: "thread-head" });
  const side = h("aside", { class: "thread-side", id: `thread-side-${id}` });
  const list = h("ol", { class: "thread-list", "aria-live": "off" });
  const run = h("div", { class: "thread-run" });
  const scroll = h(
    "div",
    { class: "thread-scroll" },
    h("div", { class: "thread-column" }, list, run),
  );
  const foot = h("div", { class: "thread-foot" });
  const home = h("div", { class: "thread-home", role: "tabpanel" }, scroll, foot);
  const studio = h("div", { class: "thread-studio", role: "tabpanel" });
  const frame = [
    head,
    h("div", { class: "thread-body" }, side, h("section", { class: "thread-main" }, home, studio)),
  ];

  const agentOf = () => ctx.store.get().endue.agents.find((a) => a.id === id);
  const webPage = () => {
    const conversation = control?.thread().conversationId;
    return conversation ? agentConversationPage(id, conversation) : undefined;
  };
  const input = composer(ctx, {
    send: (line) => {
      void control?.send(line).then(() => pin());
      pin();
    },
    stop: () => void control?.stop(),
    openWeb: () => {
      const page = webPage();
      if (page) void openOnWeb(ctx, page).catch(() => undefined);
    },
    copyLink: () => {
      const page = webPage();
      if (page) void navigator.clipboard?.writeText(page).catch(() => undefined);
    },
  });
  const control = thread
    ? threadControl(ctx, id, thread, (what) => {
        drawThread(what === "messages");
        drawFoot();
      })
    : undefined;

  /** Keep the newest row in view: on open and after the person sends. */
  let stuck = true;
  const pin = () => {
    stuck = true;
    scroll.scrollTop = scroll.scrollHeight;
  };
  scroll.addEventListener("scroll", () => {
    stuck = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < STICK;
    if (scroll.scrollTop < STICK) void control?.older();
  });

  const choose = (conversationId: string | undefined) => {
    chosen = true;
    drawer = false;
    control?.select(conversationId);
    drawSide();
    drawHead();
    input.focus();
  };

  function drawHead() {
    const s = ctx.store.get();
    const agent = agentOf();
    if (!agent) return;
    const front = agentFront(s.lang, agent, s.endue.facets[id], s.endue.conversations);
    const onStudio = s.endue.flipped.includes(view);
    const tab = (key: "home" | "studio", glyph: string, label: string) =>
      h(
        "button",
        {
          class: `segment thread-tab${(key === "studio") === onStudio ? " is-selected" : ""}`,
          type: "button",
          role: "tab",
          "data-tab": key,
          "data-key": `tab-${key}`,
          "aria-selected": (key === "studio") === onStudio ? "true" : "false",
          onClick: () => flipCard(ctx, view, key === "studio"),
        },
        icon(glyph, 14),
        h("span", { class: "thread-tab-label" }, label),
      );
    render(head, () => [
      h(
        "button",
        {
          class: "icon-button thread-side-toggle",
          type: "button",
          "aria-label": text(ctx, "threadToggleSide"),
          "aria-expanded": drawer ? "true" : "false",
          "aria-controls": side.id,
          "data-action": "toggle-side",
          "data-key": "toggle-side",
          onClick: () => {
            drawer = !drawer;
            el.dataset.drawer = drawer ? "open" : "closed";
            drawHead();
          },
        },
        icon("panel", 16),
      ),
      h(
        "span",
        { class: "thread-who" },
        avatar(front.initial, front.colour, false, s.endue.pictures[id]),
        h("span", { class: `dot ${dotOf(front.presence)} thread-who-dot`, "aria-hidden": "true" }),
        h("span", { class: "thread-name endue-title" }, front.name),
        h("span", { class: "thread-handle" }, front.handle),
      ),
      h(
        "div",
        { class: "segmented thread-tabs", role: "tablist", "aria-label": text(ctx, "threadTabs") },
        tab("home", "chat", text(ctx, "threadHome")),
        tab("studio", "layers", text(ctx, "studio")),
      ),
    ]);
    el.dataset.drawer = drawer ? "open" : "closed";
  }

  function drawSide() {
    render(side, () => sideRows(ctx, id, { selected: control?.thread().conversationId, choose }));
    side.setAttribute("aria-label", text(ctx, "threadSide"));
  }

  /** The agent's card, where a new chat starts: who it is and what it is like. */
  function intro() {
    const s = ctx.store.get();
    const agent = agentOf();
    if (!agent) return null;
    const front = agentFront(s.lang, agent, s.endue.facets[id], s.endue.conversations);
    return h(
      "li",
      { class: "thread-intro" },
      avatar(front.initial, front.colour, true, s.endue.pictures[id]),
      h(
        "h2",
        { class: "endue-name" },
        h("span", { class: "endue-title" }, front.name),
        h("span", { class: "endue-badge" }, text(ctx, "badge")),
      ),
      h("p", { class: "endue-handle" }, [front.handle, front.role].filter(Boolean).join(" · ")),
      h(
        "p",
        { class: "endue-presence", "data-presence": front.presence },
        h("span", { class: `dot ${dotOf(front.presence)}`, "aria-hidden": "true" }),
        front.presenceLabel,
      ),
      front.description ? h("p", { class: "endue-desc" }, front.description) : null,
      front.chips.length
        ? h(
            "ul",
            { class: "endue-chips" },
            front.chips.map((chip) => h("li", { class: "tag" }, chip)),
          )
        : null,
      h("p", { class: "thread-note" }, text(ctx, "threadEmpty", { name: front.name })),
    );
  }

  const rows = () => ({
    open: opened,
    toggle: (key: string) => {
      if (!opened.delete(key)) opened.add(key);
      drawThread(true);
    },
    retry: () => void control?.retry(),
    openWeb: () => {
      const page = webPage();
      if (page) void openOnWeb(ctx, page).catch(() => undefined);
    },
    failure: control?.failure() ?? "",
  });

  function drawThread(all: boolean) {
    const t = control?.thread();
    const fromFoot = scroll.scrollHeight - scroll.scrollTop;
    const wasStuck = stuck;
    if (all) {
      render(list, () =>
        !t || (!t.conversationId && !t.messages.length) ? [intro()] : messageRows(ctx, t, rows()),
      );
    }
    render(run, () => (t ? [runRow(ctx, t, rows())] : []));
    if (wasStuck) scroll.scrollTop = scroll.scrollHeight;
    else if (all) scroll.scrollTop = scroll.scrollHeight - fromFoot;
  }

  function drawFoot() {
    const s = ctx.store.get();
    const agent = agentOf();
    if (!agent) return;
    if (agent.status !== "active") {
      render(foot, () => [
        h(
          "div",
          { class: "thread-inactive" },
          h("p", {}, text(ctx, "threadInactive")),
          h(
            "button",
            {
              class: "btn btn-xs",
              type: "button",
              "data-action": "open-studio-tab",
              onClick: () => flipCard(ctx, view, true),
            },
            text(ctx, "threadOpenStudio"),
          ),
        ),
      ]);
      return;
    }
    if (!foot.contains(input.el)) foot.replaceChildren(input.el);
    const t = control?.thread();
    input.update({
      name: agentFront(s.lang, agent, s.endue.facets[id], s.endue.conversations).name,
      fresh: !t?.conversationId,
      running: !!t?.run && t.run.state !== "failed",
      blocked: s.endue.state === "offline" ? text(ctx, "threadOffline") : "",
    });
  }

  function drawStudio() {
    const s = ctx.store.get();
    const agent = agentOf();
    if (!agent) return;
    const read = s.endue.facets[id];
    const picture = s.endue.pictures[id];
    const board = studioBoard(s.lang, agent, read, s.endue.conversations);
    const pages: Page[] = [
      ["open-studio", "editInStudio", () => void openAgentStudio(ctx, id).catch(() => undefined)],
    ];
    render(studio, () => [
      readLine(ctx, read, again),
      studioBoardView(ctx, board, {
        agentId: id,
        ...(picture ? { picture } : {}),
        expanded,
        toggle: (row) => {
          expanded = expanded === row ? null : row;
          drawStudio();
        },
      }),
      actions(ctx, "back", pages, again),
    ]);
    const drawn = studio.querySelector<HTMLElement>("[data-studio-board]");
    if (drawn) lines.attach(drawn, lineSpecs(board, expanded));
  }

  const draw = () => {
    const s = ctx.store.get();
    const agent = agentOf();
    if (!agent) {
      lines.dispose();
      render(el, () => [notice(ctx, s.endue, again)]);
      return;
    }
    if (!el.contains(head)) el.replaceChildren(...frame);
    const onStudio = s.endue.flipped.includes(view);
    el.dataset.tab = onStudio ? "studio" : "home";
    home.hidden = onStudio;
    studio.hidden = !onStudio;
    if (!chosen && control && !control.thread().conversationId) {
      const { pinned, recent } = agentConversations(s.endue.conversations, id);
      const newest = [...pinned, ...recent].sort((a, b) =>
        (b.lastMessageAt ?? b.updatedAt).localeCompare(a.lastMessageAt ?? a.updatedAt),
      )[0];
      if (newest) control.select(newest.id);
    }
    drawHead();
    drawSide();
    drawThread(true);
    drawFoot();
    if (onStudio) drawStudio();
    else lines.dispose();
  };
  draw();
  void readFacets(ctx, id);
  const unwatch = ctx.store.watch(
    (s) => [
      s.endue.state,
      s.endue.agents.find((a) => a.id === id),
      s.endue.facets[id],
      s.endue.pictures[id],
      s.endue.conversations,
      s.endue.flipped.includes(view),
      s.lang,
    ],
    draw,
  );
  const off = () => {
    unwatch();
    lines.dispose();
    control?.dispose();
    input.dispose();
  };
  return { el, off };
}
