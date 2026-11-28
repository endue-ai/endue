/**
 * The side of an agent's window on the browser stub (ADR 0411, FT-07; fixtures and the dev page,
 * never shipped): the agents' topics, each topic's threads and the agents' routines, as the core's
 * studio.topics.list, studio.routines.list and studio.conversations.list's `topicId` answer. Only
 * what a row shows is held: no routine prompt, webhook address or run history. A test can make a
 * method fail (`failing`) to see each list say so.
 */
import {
  StubError,
  type StubHandlers,
  type StudioConversation,
  type StudioRoutine,
  type StudioTopic,
} from "@endue-ai/bridge";
import { sampleAgentId as AG } from "./studio-fixtures";

type SideMethod = "studio.topics.list" | "studio.routines.list" | "studio.conversations.list";

export interface StudioSide {
  /** Topics by agent id, the most recently active first; tests edit them in place. */
  topics: Record<string, StudioTopic[]>;
  /** Routines by agent id; tests edit them in place. */
  routines: Record<string, StudioRoutine[]>;
  /** The topics' threads (conversations with a `topicId`), apart from the recent ones. */
  threads: StudioConversation[];
  /** Methods that fail with this message until cleared. */
  failing: Partial<Record<SideMethod, string>>;
  /** Which lists were read, oldest first: `topics:<agent>`, `threads:<topic>`, `routines:<agent>`. */
  reads: string[];
}

const iso = (epoch: number, minutesAgo: number) =>
  new Date(epoch - minutesAgo * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");

function thread(
  epoch: number,
  n: number,
  topicId: string,
  title: string,
  ago: number,
): StudioConversation {
  return {
    id: `cnv_topic${n}`,
    agentId: AG(1),
    topicId,
    title,
    status: "active",
    messageCount: 4,
    lastMessageAt: iso(epoch, ago),
    lastMessagePreview: "Here is where it stands.",
    lastRunStatus: "completed",
    activity: "done",
    createdAt: iso(epoch, ago + 60),
    updatedAt: iso(epoch, ago),
  };
}

/** Two topics and three routines for the first sample agent; the others have none. */
export function sampleSide(epoch: number): StudioSide {
  const threads = [
    thread(epoch, 1, "tp_launch", "Pricing page copy", 20),
    thread(epoch, 2, "tp_launch", "Launch checklist", 95),
    thread(epoch, 3, "tp_weekly", "Week 47 review", 2 * 24 * 60),
  ];
  return {
    topics: {
      [AG(1)]: [
        {
          id: "tp_launch",
          name: "launch-plan",
          threadCount: 2,
          lastActivityAt: iso(epoch, 20),
          mainConversationId: "cnv_topic1",
        },
        {
          id: "tp_weekly",
          name: "weekly-review",
          threadCount: 1,
          lastActivityAt: iso(epoch, 2880),
        },
      ],
    },
    routines: {
      [AG(1)]: [
        {
          id: "rt_brief",
          name: "Morning brief",
          enabled: true,
          trigger: { kind: "schedule", text: "Every weekday at 9:00" },
          lastRunAt: iso(epoch, 180),
          lastRunStatus: "completed",
        },
        { id: "rt_lead", name: "New lead", enabled: true, trigger: { kind: "webhook" } },
        {
          id: "rt_digest",
          name: "Weekly digest",
          enabled: false,
          trigger: { kind: "schedule", text: "Every Monday at 8:00" },
          lastRunAt: iso(epoch, 6 * 24 * 60),
          lastRunStatus: "failed",
        },
      ],
    },
    threads,
    failing: {},
    reads: [],
  };
}

/** studio.topics.list and studio.routines.list over `side`, behind the stub's gate. */
export function sideHandlers(
  side: StudioSide,
  gate: (caller: string | undefined) => void,
): StubHandlers {
  return {
    "studio.topics.list": ({ agentId }, caller) => {
      gate(caller);
      side.reads.push(`topics:${agentId}`);
      fail(side, "studio.topics.list");
      return { topics: structuredClone(side.topics[agentId] ?? []) };
    },
    "studio.routines.list": ({ agentId, page, limit }, caller) => {
      gate(caller);
      side.reads.push(`routines:${agentId}`);
      fail(side, "studio.routines.list");
      const all = side.routines[agentId] ?? [];
      const size = Math.min(Math.max(limit ?? 20, 1), 100);
      const at = (Math.max(page ?? 1, 1) - 1) * size;
      return { routines: structuredClone(all.slice(at, at + size)), total: all.length };
    },
  };
}

/** A topic's threads: the recent conversations in it (a new thread lands there) and the held ones. */
export function topicThreads(
  side: StudioSide,
  conversations: StudioConversation[],
  topicId: string,
): StudioConversation[] {
  side.reads.push(`threads:${topicId}`);
  fail(side, "studio.conversations.list");
  const known = new Set<string>();
  return [...conversations, ...side.threads]
    .filter((c) => c.topicId === topicId && !known.has(c.id) && known.add(c.id))
    .sort((a, b) => (b.lastMessageAt ?? b.updatedAt).localeCompare(a.lastMessageAt ?? a.updatedAt));
}

function fail(side: StudioSide, method: SideMethod) {
  const message = side.failing[method];
  if (message) throw new StubError("io_error", message);
}
