/**
 * One turn of Eris's as her card shows it (FT-06, ADR 0409): the line she took in, a row per
 * component she went to, in the order she first went to it, her answer so far, and how the turn
 * ended. A row is a component, not a call: a plugin, a window the desk's own command names, a local
 * agent, or an endue agent. Calls to one component fold into its row. Pure: the card draws it.
 */
import type { BrainReply, BrainStep } from "../bridge/types";
import { nameOf } from "./errand-targets";

export type RowKind = "plugin" | "window" | "agent" | "endue";
/** `sent`: a call already sent when the turn was stopped, which cannot be taken back. */
export type RowState = "waiting" | "working" | "needs" | "done" | "failed" | "stopped" | "sent";

/** What a call goes to, as a row names it. */
export interface Component {
  key: string;
  kind: RowKind;
  name: string;
  /** The window to bring forward on a press, when the row has one. */
  window?: string;
  /** The window's title, shown with a plugin's name. */
  place?: string;
  /** A local agent's id (its Stop) or an endue agent's (its conversation). */
  agent?: string;
}

/** What the desk knows about a call besides its step: the window and agent its arguments name. */
export interface Hint {
  window?: { id: string; title: string };
  agent?: { id: string; name: string };
}

export interface Row extends Component {
  state: RowState;
  /** The title of the row's latest call. */
  title?: string;
  calls: number;
  /** A failed call's message, first line. */
  message?: string;
  /** Milliseconds its calls took, first start to last end, once it is done. */
  took?: number;
}

const LOCAL_AGENTS = "desk.agents.";
const ENDUE_ASK = "desk.endue.ask";

/** The component a call is: by its command, its provider and what its arguments name. */
export function componentOf(
  step: Pick<BrainStep, "command" | "provider">,
  hint: Hint = {},
): Component {
  const { window, agent } = hint;
  if (step.command.startsWith(LOCAL_AGENTS)) {
    const id = agent?.id;
    return {
      key: `agent:${id ?? "local"}`,
      kind: "agent",
      name: agent?.name ?? "Local agents",
      ...(id ? { agent: id } : {}),
    } satisfies Component;
  }
  if (step.command === ENDUE_ASK) {
    const id = agent?.id;
    return {
      key: `endue:${id ?? "endue"}`,
      kind: "endue",
      name: agent?.name ?? "endue",
      ...(id ? { agent: id } : {}),
    } satisfies Component;
  }
  if (step.provider === "desk" && window)
    return { key: `window:${window.id}`, kind: "window", name: window.title, window: window.id };
  return {
    key: `plugin:${step.provider}`,
    kind: "plugin",
    name: nameOf(step.provider),
    ...(window ? { window: window.id, place: window.title } : {}),
  } satisfies Component;
}

interface Call {
  row: string;
  command: string;
  provider: string;
  title?: string;
  start: number;
  end?: number;
  ok?: boolean;
  message?: string;
}

export type Outcome = "done" | "failed" | "stopped";

export class TurnModel {
  readonly line: string;
  readonly started: number;
  answer = "";
  ended?: number;
  outcome?: Outcome;
  private readonly order: Component[] = [];
  private readonly calls = new Map<string, Call>();
  private readonly waiting = new Map<string, string>();

  /** A turn of `line`, from `now`; `about` are the windows it names, each a waiting row at once. */
  constructor(line: string, now: number, about: Component[] = []) {
    this.line = line;
    this.started = now;
    for (const c of about) this.place(c);
  }

  /** A step of her loop: a call goes out, or comes back. */
  step(step: BrainStep, now: number, hint?: Hint): void {
    if (this.outcome) return;
    if (step.kind === "tool") {
      if (this.calls.has(step.callId)) return;
      const who = componentOf(step, hint);
      this.place(who);
      const { command, provider, title } = step;
      this.calls.set(step.callId, { row: who.key, command, provider, start: now, title });
      return;
    }
    const call = this.calls.get(step.callId);
    if (!call || call.end !== undefined) return;
    call.end = now;
    call.ok = step.ok !== false;
    if (!call.ok && step.message) call.message = step.message;
  }

  /** The window or agent a call of `command` names, known once the desk runs it. */
  hint(command: string, hint: Hint): void {
    const call = [...this.calls.values()].reverse().find((c) => c.command === command);
    if (!call) return;
    const who = componentOf(call, hint);
    if (who.key === call.row) {
      this.place(who);
      return;
    }
    const was = call.row;
    const at = this.order.findIndex((c) => c.key === was);
    call.row = who.key;
    const left = [...this.calls.values()].some((c) => c.row === was);
    const known = this.order.some((c) => c.key === who.key);
    // The new row takes the old one's place when that one is left empty, so first contact holds.
    if (!left && at >= 0) this.order.splice(at, 1, ...(known ? [] : [who]));
    this.place(who);
  }

  /** A call of the turn waits for the person, or no longer does; the latest one still open. */
  needs(approvalId: string, waiting: boolean): void {
    if (!waiting) {
      this.waiting.delete(approvalId);
      return;
    }
    const open = [...this.calls.values()].reverse().find((c) => c.end === undefined);
    if (open) this.waiting.set(approvalId, open.row);
  }

  /** Her answer so far. */
  delta(soFar: string): void {
    if (!this.outcome) this.answer = soFar;
  }

  /** The turn ended with `reply`. */
  end(reply: Pick<BrainReply, "text" | "reason">, now: number): void {
    if (this.outcome) return;
    this.ended = now;
    this.outcome = reply.reason === "stopped" ? "stopped" : reply.reason ? "failed" : "done";
    this.waiting.clear();
    if (!reply.reason) this.answer = reply.text;
  }

  /** The rows, in the order she first went to each. */
  rows(): Row[] {
    return this.order.map((c) => this.row(c));
  }

  /** How many rows are over, of how many, and how many of them failed. */
  counts(): { over: number; total: number; failed: number; steps: number } {
    const rows = this.rows();
    const over = rows.filter((r) => r.state !== "waiting" && r.state !== "working");
    const failed = rows.filter((r) => r.state === "failed").length;
    return { over: over.length, total: rows.length, failed, steps: this.calls.size };
  }

  /** What the card announces: changes when a row's state or the turn's outcome does, not per delta. */
  key(): string {
    return [this.outcome ?? "", ...this.rows().map((r) => `${r.key}=${r.state}`)].join("|");
  }

  private place(who: Component): void {
    const at = this.order.findIndex((c) => c.key === who.key);
    if (at < 0) this.order.push(who);
    else this.order[at] = { ...this.order[at], ...who } as Component;
  }

  private row(c: Component): Row {
    const calls = [...this.calls.values()].filter((call) => call.row === c.key);
    const last = calls.at(-1);
    const failed = calls.filter((call) => call.ok === false).at(-1);
    const open = calls.some((call) => call.end === undefined);
    const needs = [...this.waiting.values()].includes(c.key);
    const ends = calls.map((call) => call.end ?? Number.NaN);
    const took =
      calls.length && !open
        ? Math.max(...ends) - Math.min(...calls.map((x) => x.start))
        : undefined;
    const row: Row = { ...c, state: "waiting", calls: calls.length };
    if (last?.title) row.title = last.title;
    if (failed?.message) row.message = failed.message;
    if (took !== undefined) row.took = took;
    if (this.outcome === "stopped" && (open || calls.length === 0))
      row.state = calls.length === 0 || c.kind === "agent" ? "stopped" : "sent";
    else if (needs) row.state = "needs";
    else if (open) row.state = this.outcome ? "failed" : "working";
    else if (calls.length === 0) row.state = this.outcome ? "stopped" : "waiting";
    else row.state = failed ? "failed" : "done";
    return row;
  }
}
