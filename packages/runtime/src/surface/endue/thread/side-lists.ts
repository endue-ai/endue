/**
 * What the side of an agent's window reads beyond its conversations (ADR 0411, FT-07): the
 * agent's topics, a topic's threads when it is unfolded (not before), and its routines; which
 * side tab is shown; and which list stands in the thread's place. Each list is reading, read or
 * could not be read, and everything is read again by "Read again" or when the window gets the
 * focus five minutes after the last read. The words of a routine's trigger and last run, and of
 * the outputs line, are here too, so the view only draws.
 */
import type {
  StudioConversation,
  StudioOutputs,
  StudioRoutine,
  StudioTopic,
} from "@endue-ai/bridge";
import type { StudioSideBridge } from "../../../bridge/types";
import type { Lang } from "../../../shell/copy";
import { endueText } from "../copy";
import { when } from "./model";

/** How long a read stands before the focus reads it again. */
export const STALE = 5 * 60_000;

export interface List<T> {
  state: "reading" | "read" | "failed";
  items: T[];
  total: number;
  failure: string;
}

export type SideTab = "home" | "chat";
export type SidePanel = "routines" | "outputs";

export interface SideState {
  tab: SideTab;
  topics: List<StudioTopic>;
  routines: List<StudioRoutine>;
  threads: Record<string, List<StudioConversation>>;
  unfolded: string[];
  /** The list shown in the thread's place, from Home. */
  panel?: SidePanel;
}

export interface SideControl {
  state(): SideState;
  tab(tab: SideTab): void;
  /** Fold or unfold a topic; unfolding reads its threads the first time. */
  unfold(topicId: string): void;
  show(panel: SidePanel | undefined): void;
  /** Read every list again ("Read again"). */
  again(): void;
  /** The window got the focus: read again if the last read is five minutes old. */
  focused(): void;
  /** A new thread was made in `topicId`: read the topic and its threads again. */
  made(topicId: string): void;
  dispose(): void;
}

const reading = <T>(): List<T> => ({ state: "reading", items: [], total: 0, failure: "" });
const why = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));

export function sideControl(
  bridge: StudioSideBridge | undefined,
  agentId: string,
  now: () => number,
  changed: () => void,
): SideControl {
  let s: SideState = {
    tab: "chat",
    topics: reading(),
    routines: reading(),
    threads: {},
    unfolded: [],
  };
  let readAt = 0;
  let disposed = false;
  /** The first reads start before the window has drawn; it draws their reading state itself. */
  let started = false;
  const set = (next: Partial<SideState>) => {
    s = { ...s, ...next };
    if (started && !disposed) changed();
  };

  async function readTopics() {
    if (!bridge) return;
    set({ topics: { ...reading<StudioTopic>(), items: s.topics.items } });
    const next: List<StudioTopic> = await bridge.topics(agentId).then(
      (items) => ({ state: "read", items, total: items.length, failure: "" }),
      (reason) => ({ state: "failed", items: [], total: 0, failure: why(reason) }),
    );
    set({ topics: next });
  }

  async function readRoutines() {
    if (!bridge) return;
    set({ routines: { ...reading<StudioRoutine>(), items: s.routines.items } });
    const next: List<StudioRoutine> = await bridge.routines(agentId).then(
      (page) => ({ state: "read", items: page.routines, total: page.total, failure: "" }),
      (reason) => ({ state: "failed", items: [], total: 0, failure: why(reason) }),
    );
    set({ routines: next });
  }

  async function readThreads(topicId: string) {
    if (!bridge) return;
    set({ threads: { ...s.threads, [topicId]: reading() } });
    const next: List<StudioConversation> = await bridge.threads(agentId, topicId).then(
      (items) => ({ state: "read", items, total: items.length, failure: "" }),
      (reason) => ({ state: "failed", items: [], total: 0, failure: why(reason) }),
    );
    set({ threads: { ...s.threads, [topicId]: next } });
  }

  const readAll = () => {
    readAt = now();
    void readTopics();
    void readRoutines();
    for (const topicId of s.unfolded) void readThreads(topicId);
  };
  readAll();
  started = true;

  return {
    state: () => s,
    tab: (tab) => set({ tab }),
    unfold(topicId) {
      if (s.unfolded.includes(topicId)) {
        set({ unfolded: s.unfolded.filter((t) => t !== topicId) });
        return;
      }
      set({ unfolded: [...s.unfolded, topicId] });
      if (!s.threads[topicId] || s.threads[topicId].state === "failed") void readThreads(topicId);
    },
    show: (panel) => set(panel ? { panel } : { panel: undefined }),
    again: readAll,
    focused() {
      if (now() - readAt >= STALE) readAll();
    },
    made(topicId) {
      void readTopics();
      void readThreads(topicId);
    },
    dispose() {
      disposed = true;
    },
  };
}

/** What starts a routine, in a sentence: the schedule as endue AI words it, a webhook, an event. */
export function routineStarts(lang: Lang, r: StudioRoutine): string {
  switch (r.trigger.kind) {
    case "webhook":
      return endueText(lang, "sideRoutineWebhook");
    case "event":
      return endueText(lang, "sideRoutineEvent");
    default:
      return r.trigger.text || endueText(lang, "sideRoutineSchedule");
  }
}

/** When a routine last ran and how that ended, or that it has not run yet. */
export function routineRan(lang: Lang, r: StudioRoutine, at: number): string {
  if (!r.lastRunAt) return endueText(lang, "sideRoutineNever");
  const status = r.lastRunStatus ?? "";
  const how =
    status === "completed"
      ? endueText(lang, "sideRunCompleted")
      : status === "failed"
        ? endueText(lang, "sideRunFailed")
        : status === "running"
          ? endueText(lang, "sideRunRunning")
          : endueText(lang, "sideRunOther", { status });
  return endueText(lang, "sideRoutineRan", { when: when(lang, r.lastRunAt, at), how });
}

/** The outputs line: how many the agent made and when the newest changed. */
export function outputsLine(lang: Lang, outputs: StudioOutputs, at: number): string {
  return outputs.latestAt
    ? endueText(lang, "sideOutputsLine", {
        n: outputs.count,
        when: when(lang, outputs.latestAt, at),
      })
    : endueText(lang, "sideOutputsLineNone", { n: outputs.count });
}
