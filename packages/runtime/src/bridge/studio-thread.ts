/**
 * An agent's conversation on the browser stub (ADR 0411; fixtures and the dev page, never
 * shipped): each sample conversation holds a few messages, a send adds the person's line and runs
 * a scripted turn at once, and a test can hold the next run open and drive it (`held`), as the
 * core's studio.chat.* and studio.chat.event do. Only the shell sends.
 */
import type {
  StudioChatEventData,
  StudioConversation,
  StudioMessage,
  StudioWork,
} from "@endue-ai/bridge";
import type { StudioThreadBridge } from "./types";

/** A run a test holds open and drives. */
export interface HeldRun {
  readonly conversationId: string;
  readonly runId: string;
  readonly text: string;
  /** More of the answer. */
  delta(text: string): void;
  /** The turn's work so far. */
  work(work: StudioWork): void;
  /** The run asks the person something. */
  needs(message?: string): void;
  /** End it with the answer so far (or `text`), or as failed with `failure`. */
  end(text?: string): void;
  fail(message: string): void;
}

export interface ThreadStub {
  bridge: StudioThreadBridge;
  /** The messages by conversation, oldest first; tests edit them in place. */
  messages: Record<string, StudioMessage[]>;
  /** When each conversation was last read. */
  readAt: Record<string, string>;
  /** Hold the next run open for the test. */
  hold(): void;
  held(): HeldRun | undefined;
  /** The ids of the runs stopped, oldest first. */
  stopped: string[];
  /** Give a conversation the stub did not start with (a topic's thread) its sample messages. */
  seed(conversation: StudioConversation): void;
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** A finished turn's work, as endue AI folds its tool rows. */
export function sampleWork(start: number, seconds: number, failed = 0): StudioWork {
  return {
    phase: failed ? "failed" : "completed",
    startedAt: iso(start),
    endedAt: iso(start + seconds * 1000),
    attempted: 3,
    succeeded: 3 - failed,
    failed,
    groups: [
      { label: "Search the web", provider: "endue", calls: 2, failed },
      { label: "Read a page", provider: "endue", calls: 1, failed: 0 },
    ],
  };
}

function sampleThread(c: StudioConversation): StudioMessage[] {
  const end = Date.parse(c.lastMessageAt ?? c.updatedAt);
  const user = (n: number, text: string, ago: number): StudioMessage => ({
    id: `msg_${c.id}_${n}`,
    role: "user",
    text,
    createdAt: iso(end - ago * 60_000),
  });
  const agent = (n: number, text: string, ago: number, work?: StudioWork): StudioMessage => ({
    id: `msg_${c.id}_${n}`,
    role: "assistant",
    text,
    createdAt: iso(end - ago * 60_000),
    runId: `run_${c.id}_${n}`,
    ...(work ? { work } : {}),
  });
  return [
    user(1, c.title ?? "Hello", 30),
    agent(
      2,
      "I looked into it.\n\nHere is what I found so far.",
      29,
      sampleWork(end - 1_800_000, 14),
    ),
    user(3, "Thanks. Can you go on?", 1),
    agent(4, c.lastMessagePreview ?? "On it.", 0),
  ];
}

export function threadStub(conversations: StudioConversation[], now: () => number): ThreadStub {
  const messages: Record<string, StudioMessage[]> = Object.fromEntries(
    conversations.map((c) => [c.id, sampleThread(c)]),
  );
  const readAt: Record<string, string> = Object.fromEntries(
    conversations.map((c) => [c.id, iso(Date.parse(c.lastMessageAt ?? c.updatedAt) - 90_000)]),
  );
  const listeners = new Set<(event: StudioChatEventData) => void>();
  const stopped: string[] = [];
  const open = new Map<string, HeldRun & { stop(): void }>();
  let holding = false;
  let held: HeldRun | undefined;
  let count = 0;

  const emit = (event: StudioChatEventData) => {
    for (const listener of listeners) listener(structuredClone(event));
  };

  const run = (conversationId: string, text: string): HeldRun & { stop(): void } => {
    const runId = `run_stub_${++count}`;
    let answer = "";
    let last: StudioWork | undefined;
    const base = { conversationId, runId };
    const close = () => {
      open.delete(runId);
      if (held?.runId === runId) held = undefined;
    };
    const message = (): StudioMessage => ({
      id: `msg_${runId}`,
      role: "assistant",
      text: answer,
      createdAt: iso(now()),
      runId,
      ...(last ? { work: last } : {}),
    });
    const r = {
      ...base,
      text,
      delta(more: string) {
        answer += more;
        emit({ ...base, kind: "delta", text: more });
      },
      work(work: StudioWork) {
        last = work;
        emit({ ...base, kind: "work", work });
      },
      needs: (asked?: string) =>
        emit({ ...base, kind: "needsInput", ...(asked ? { message: asked } : {}) }),
      end(final?: string) {
        if (final !== undefined) answer = final;
        messages[conversationId]?.push(message());
        close();
        emit({ ...base, kind: "completed", text: answer });
      },
      fail(failure: string) {
        close();
        emit({ ...base, kind: "failed", message: failure });
      },
      stop() {
        stopped.push(runId);
        close();
        emit({ ...base, kind: "cancelled" });
      },
    };
    open.set(runId, r);
    emit({ ...base, kind: "started" });
    return r;
  };

  const script = (r: HeldRun) => {
    const start = now();
    r.work({ ...sampleWork(start, 0), phase: "running", endedAt: undefined, succeeded: 1 });
    r.delta("Here is ");
    r.delta("what I found.");
    r.work(sampleWork(start, 4));
    r.end();
  };

  const bridge: StudioThreadBridge = {
    async messages(conversationId, before) {
      const all = messages[conversationId] ?? [];
      const end = before ? all.findIndex((m) => m.id === before) : all.length;
      const page = all.slice(Math.max(0, end - 30), Math.max(0, end));
      return { messages: structuredClone(page).reverse(), hasMore: end > 30 };
    },
    async send({ agentId, conversationId, text, topicId }) {
      const id = conversationId ?? `cnv_new_${++count}`;
      if (!conversationId) {
        const at = iso(now());
        conversations.unshift({
          id,
          agentId,
          ...(topicId ? { topicId } : {}),
          title: text.slice(0, 60),
          status: "active",
          messageCount: 0,
          lastMessageAt: at,
          activity: "active",
          createdAt: at,
          updatedAt: at,
        });
        messages[id] = [];
      }
      messages[id]?.push({ id: `msg_stub_${++count}`, role: "user", text, createdAt: iso(now()) });
      queueMicrotask(() => {
        const r = run(id, text);
        if (holding) {
          holding = false;
          held = r;
        } else script(r);
      });
      return { conversationId: id };
    },
    async attach() {},
    async stop(_conversationId, runId) {
      open.get(runId)?.stop();
    },
    async read(conversationId) {
      const previous = readAt[conversationId];
      readAt[conversationId] = iso(now());
      return previous;
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  return {
    bridge,
    messages,
    readAt,
    stopped,
    hold: () => {
      holding = true;
    },
    held: () => held,
    seed(c) {
      messages[c.id] ??= sampleThread(c);
      readAt[c.id] ??= iso(Date.parse(c.lastMessageAt ?? c.updatedAt) - 90_000);
    },
  };
}
