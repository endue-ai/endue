/**
 * One agent window's conversation as it goes (ADR 0411): which conversation it shows, its messages
 * read a page at a time, the person's line sent into it, the run followed through
 * `studio.chat.event`, a stop, Try again, and the read marked on the way in. A window opened on a
 * conversation whose run is in flight attaches to it.
 */
import type { StudioChatEventData } from "@endue-ai/bridge";
import type { StudioThreadBridge } from "../../../bridge/types";
import type { ShellCtx } from "../../../shell/context";
import { loadEndue } from "../../../system/endue";
import { applyEvent, emptyThread, sent, type Thread, tryAgain, withPage } from "./model";

export interface ThreadControl {
  thread(): Thread;
  /** The conversation shown; `undefined` is a new chat, in `topicId` when given (a new thread). */
  select(conversationId: string | undefined, topicId?: string): void;
  send(text: string): Promise<void>;
  stop(): Promise<void>;
  retry(): Promise<void>;
  /** Read the page before the oldest message held. */
  older(): Promise<void>;
  /** Why the last send failed, if it did. */
  failure(): string;
  dispose(): void;
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** A message id the platform keeps one send of: letters and digits, 8 to 64. */
function messageId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `desk_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function threadControl(
  ctx: ShellCtx,
  agentId: string,
  bridge: StudioThreadBridge,
  changed: (what: "messages" | "run") => void,
): ThreadControl {
  let t = emptyThread();
  let failure = "";
  let disposed = false;
  /** Which selection a read answers; a later select makes an earlier read stale. */
  let generation = 0;

  const set = (next: Thread, what: "messages" | "run") => {
    t = next;
    if (!disposed) changed(what);
  };

  /** Steps that came before a new chat's send answered with its conversation. */
  let early: StudioChatEventData[] | undefined;

  const take = (e: StudioChatEventData) => {
    const before = t.messages.length;
    const next = applyEvent(t, e, iso(ctx.wall()));
    set(next, next.messages.length !== before ? "messages" : "run");
    if (e.kind === "completed" || e.kind === "cancelled") void loadEndue(ctx);
  };

  const off = bridge.onEvent((e: StudioChatEventData) => {
    if (e.conversationId === t.conversationId) take(e);
    else early?.push(e);
  });

  async function open(conversationId: string) {
    const mine = ++generation;
    set(emptyThread(conversationId), "messages");
    const running = ctx.store
      .get()
      .endue.conversations.find((c) => c.id === conversationId)?.lastRunStatus;
    try {
      const [page, previousReadAt] = await Promise.all([
        bridge.messages(conversationId),
        bridge.read(conversationId).catch(() => undefined),
      ]);
      if (mine !== generation) return;
      set(
        { ...withPage(t, page, false), ...(previousReadAt ? { previousReadAt } : {}) },
        "messages",
      );
      if (running === "running")
        await bridge.attach(conversationId, agentId).catch(() => undefined);
    } catch (reason) {
      if (mine !== generation) return;
      failure = reason instanceof Error ? reason.message : String(reason);
      set({ ...t, reading: false }, "messages");
    }
  }

  async function send(text: string) {
    const line = text.trim();
    if (!line || (t.run && t.run.state !== "failed")) return;
    failure = "";
    const id = messageId();
    const fresh = t.conversationId === undefined;
    if (fresh) early = [];
    set(sent(t, line, `local_${id}`, iso(ctx.wall())), "messages");
    try {
      const result = await bridge.send({
        agentId,
        ...(t.conversationId ? { conversationId: t.conversationId } : {}),
        ...(fresh && t.topicId ? { topicId: t.topicId } : {}),
        text: line,
        messageId: id,
      });
      if (fresh) {
        generation++;
        set({ ...t, conversationId: result.conversationId }, "messages");
        for (const e of early ?? []) if (e.conversationId === result.conversationId) take(e);
        void loadEndue(ctx);
      }
    } catch (reason) {
      failure = reason instanceof Error ? reason.message : String(reason);
      const { run: _, ...rest } = t;
      set(rest, "run");
    } finally {
      if (fresh) early = undefined;
    }
  }

  return {
    thread: () => t,
    select(conversationId, topicId) {
      failure = "";
      if (conversationId === undefined) {
        generation++;
        set(emptyThread(undefined, topicId), "messages");
      } else if (conversationId !== t.conversationId || t.messages.length === 0)
        void open(conversationId);
    },
    send,
    async stop() {
      const runId = t.run?.runId;
      if (!t.conversationId || !runId) return;
      await bridge.stop(t.conversationId, runId).catch((reason) => {
        failure = reason instanceof Error ? reason.message : String(reason);
        changed("run");
      });
    },
    async retry() {
      const line = tryAgain(t);
      if (line === undefined) return;
      const { run: _, ...rest } = t;
      t = rest;
      await send(line);
    },
    async older() {
      const first = t.messages[0];
      if (!t.conversationId || !t.hasMore || t.reading || !first) return;
      const mine = generation;
      set({ ...t, reading: true }, "messages");
      const page = await bridge.messages(t.conversationId, first.id).catch(() => undefined);
      if (mine !== generation) return;
      set(page ? withPage(t, page, true) : { ...t, reading: false }, "messages");
    },
    failure: () => failure,
    dispose() {
      disposed = true;
      off();
    },
  };
}
