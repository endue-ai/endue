/**
 * An agent's conversation as its window holds it (ADR 0411): the messages read, oldest first and
 * at most 500; the run in flight with its answer as deltas add to it; where the previous read
 * falls; and the words of times and work as endue.ai writes them. Pure: the view draws it.
 */
import type {
  StudioChatEventData,
  StudioMessage,
  StudioMessagesListResult,
  StudioWork,
} from "@endue-ai/bridge";
import type { Lang } from "../../../shell/copy";
import { endueLocale, endueText } from "../copy";

/** The most of a thread the page keeps. */
export const KEEP = 500;

export interface Run {
  runId?: string;
  /** The answer so far. */
  text: string;
  work?: StudioWork;
  state: "working" | "needs" | "failed";
  /** What the run asks, or what failed. */
  message?: string;
  /** The person's line that started it, for Try again. */
  line?: string;
}

export interface Thread {
  conversationId?: string;
  /** The topic a new thread is made in (ADR 0411, FT-07). */
  topicId?: string;
  messages: StudioMessage[];
  hasMore: boolean;
  previousReadAt?: string;
  run?: Run;
  reading: boolean;
  /** The last run was stopped by the person. */
  stopped: boolean;
}

export const emptyThread = (conversationId?: string, topicId?: string): Thread => ({
  ...(conversationId ? { conversationId } : {}),
  ...(topicId ? { topicId } : {}),
  messages: [],
  hasMore: false,
  reading: conversationId !== undefined,
  stopped: false,
});

/** A page read (newest first, as the bridge answers), added before what is held or as the start. */
export function withPage(t: Thread, page: StudioMessagesListResult, older: boolean): Thread {
  const read = [...page.messages].reverse();
  const known = new Set(t.messages.map((m) => m.id));
  const fresh = read.filter((m) => !known.has(m.id));
  const messages = older ? [...fresh, ...t.messages] : [...t.messages, ...fresh];
  return {
    ...t,
    messages: messages.slice(-KEEP),
    hasMore: page.hasMore,
    reading: false,
  };
}

/** The person's line, shown at once, and the run it starts. */
export function sent(t: Thread, text: string, id: string, at: string): Thread {
  const mine: StudioMessage = { id, role: "user", text, createdAt: at };
  return {
    ...t,
    messages: [...t.messages, mine].slice(-KEEP),
    run: { text: "", state: "working", line: text },
    stopped: false,
  };
}

/** One step of the run in flight. */
export function applyEvent(t: Thread, e: StudioChatEventData, at: string): Thread {
  const run: Run = t.run ?? { text: "", state: "working" };
  const runId = e.runId ?? run.runId;
  const answer = (text: string, work?: StudioWork): StudioMessage => ({
    id: `msg_${runId ?? at}`,
    role: "assistant",
    text,
    createdAt: at,
    ...(runId ? { runId } : {}),
    ...(work ? { work } : {}),
  });
  switch (e.kind) {
    case "started":
      return { ...t, run: { ...run, ...(runId ? { runId } : {}), state: "working" } };
    case "delta":
      return { ...t, run: { ...run, text: run.text + (e.text ?? "") } };
    case "work":
      return e.work ? { ...t, run: { ...run, work: e.work } } : t;
    case "needsInput":
      return {
        ...t,
        run: { ...run, state: "needs", ...(e.message ? { message: e.message } : {}) },
      };
    case "failed":
      return { ...t, run: { ...run, state: "failed", message: e.message ?? "" } };
    case "completed": {
      const done = answer(e.text ?? run.text, run.work);
      const messages = t.messages.some((m) => m.id === done.id)
        ? t.messages
        : [...t.messages, done].slice(-KEEP);
      const { run: _, ...rest } = t;
      return { ...rest, messages };
    }
    case "cancelled": {
      const { run: _, ...rest } = t;
      const kept = run.text.trim() ? [...t.messages, answer(run.text, run.work)] : t.messages;
      return { ...rest, messages: kept.slice(-KEEP), stopped: true };
    }
  }
}

/** The line to send again after a failed run. */
export const tryAgain = (t: Thread): string | undefined =>
  t.run?.state === "failed" ? t.run.line : undefined;

/** The index of the first message from the agent after the previous read: where the line falls. */
export function newLineAt(messages: StudioMessage[], previousReadAt?: string): number {
  if (!previousReadAt) return -1;
  const read = Date.parse(previousReadAt);
  return messages.findIndex((m) => m.role === "assistant" && Date.parse(m.createdAt) > read);
}

const MINUTE = 60_000;

/** A message's time: "just now", "5m", "3h", "yesterday", then a short date. */
export function when(lang: Lang, iso: string, now: number): string {
  const at = Date.parse(iso);
  const ago = now - at;
  if (ago < MINUTE) return endueText(lang, "threadJustNow");
  if (ago < 60 * MINUTE) return endueText(lang, "threadMinutes", { n: Math.floor(ago / MINUTE) });
  const day = (ms: number) => new Date(ms).toDateString();
  if (day(at) === day(now))
    return endueText(lang, "threadHours", { n: Math.floor(ago / 3_600_000) });
  if (day(at) === day(now - 86_400_000)) return endueText(lang, "threadYesterday");
  return new Date(at).toLocaleDateString(endueLocale(lang), { month: "short", day: "numeric" });
}

/** How long the work took, in whole seconds. */
export function seconds(work: StudioWork, now: number): number {
  const start = work.startedAt ? Date.parse(work.startedAt) : now;
  const end = work.endedAt ? Date.parse(work.endedAt) : now;
  return Math.max(0, Math.round((end - start) / 1000));
}

/** The work box's line: "Work completed · 14 s · 3 tools", or "Working · <tool>" in flight. */
export function workLine(lang: Lang, work: StudioWork, now: number, running: boolean): string {
  if (running) {
    const tool = work.groups.at(-1)?.label;
    return tool ? endueText(lang, "threadWorkingWith", { tool }) : endueText(lang, "threadWorking");
  }
  return endueText(lang, "threadWorkDone", {
    s: seconds(work, now),
    n: work.attempted,
  });
}

/** The labels of "Used in this turn", at most `max`, and how many more. */
export function used(work: StudioWork | undefined, max = 4): { labels: string[]; more: number } {
  const labels = [...new Set((work?.groups ?? []).map((g) => g.label))];
  return { labels: labels.slice(0, max), more: Math.max(0, labels.length - max) };
}
