/**
 * Eris's turns on the desk (FT-06, ADR 0409): each line the talk line or her ear gives her opens
 * the card of its turn (`turn-card.ts`). The desk tells the card what each call names (the window
 * or agent in its arguments, as the errands read them, `Commands.watchRuns`), which approval waits
 * for the person, and what the card's buttons do: Stop asks the core to stop the turn, a row brings
 * its window forward, Review the approval, and an agent's row stops its run or opens its
 * conversation. The card keeps clear of the field the person types in and of the talk line.
 */
import type { BrainReply, BrainStep, BrainTurnHooks } from "../bridge/types";
import { windowsOf } from "../shell/actions";
import type { ShellCtx } from "../shell/context";
import { surfaceTitle } from "../shell/titles";
import { focusTab, showPlugin } from "../shell/windows";
import { agentHome } from "../system/endue-ids";
import type { Avoid, Box } from "./said";
import { mountTurnCard, type TurnCard } from "./turn-card";
import type { Component, Hint, Row } from "./turn-model";

/** Who runs a command of the desk's as Eris's tool call (`system/local-agent-commands.ts`). */
const ERIS = "agent:eris";

/** One turn, as the code that sends the line feeds it. */
export interface TurnHandle {
  step(step: BrainStep): void;
  hooks: BrainTurnHooks;
  end(reply: Pick<BrainReply, "text" | "reason">): void;
}

export interface Turns {
  readonly card: TurnCard;
  /** A new turn of `line`; `about` are the windows it names (FT-04), each a waiting row. */
  begin(line: string, about?: string[]): TurnHandle;
  /** What her card keeps clear of now, in `root`'s coordinates. */
  avoid(root: HTMLElement, resting: boolean): Avoid;
  dispose(): void;
}

const boxIn = (el: Element | null, root: HTMLElement): Box | null => {
  if (!el || el.getClientRects().length === 0) return null;
  const r = el.getBoundingClientRect();
  const f = root.getBoundingClientRect();
  return { x: r.left - f.left, y: r.top - f.top, width: r.width, height: r.height };
};

/** Turns on `ctx`'s desk; `announce` says a change of the card politely (her live region). */
export function mountTurns(ctx: ShellCtx, announce?: (text: string) => void): Turns {
  let turnId: string | undefined;
  /** Where each endue agent's row continues: the conversation its answer names. */
  const urls = new Map<string, string>();
  const titled = (id: string) => ({ id, title: surfaceTitle(ctx, id) });

  const press = (row: Row) => {
    if (row.window) return void focusTab(ctx, row.window);
    if (row.kind === "plugin") return void showPlugin(ctx, row.key.slice("plugin:".length));
    if (row.kind === "agent")
      return void ctx.runtime?.commands.run(
        "desk.agents.open",
        row.agent ? { agent: row.agent } : {},
      );
    if (row.kind === "endue") conversation(row);
  };
  const conversation = (row: Row) => {
    const url = urls.get(row.key) ?? (row.agent ? agentHome(row.agent) : undefined);
    if (url) void ctx.bridge.studio?.open(url);
  };
  const card = mountTurnCard(
    document,
    () => ctx.store.get().lang,
    () => ctx.ticker.now(),
    {
      stop: () => {
        if (turnId) void ctx.bridge.brain.stop?.(turnId);
      },
      press,
      // The approval's card is the permissions overlay's, in front of everything: its first button.
      review: () =>
        document
          .querySelector<HTMLElement>(
            '[data-surface^="endue.permissions"] button, [data-surface^="endue.permissions"]',
          )
          ?.focus(),
      stopRun: (row) => {
        const s = ctx.store.get();
        const run = s.localRuns.find(
          (r) => r.agent === row.agent && r.state === "running" && s.erisRuns.includes(r.runId),
        );
        if (run) void ctx.bridge.localAgents?.stop(run.runId);
      },
      conversation,
    },
    announce,
  );

  /** What a call's arguments (or answer) name: a window, a local agent, an endue agent. */
  const hintOf = (said: unknown): Hint => {
    const named = (said ?? {}) as Record<string, unknown>;
    const hint: Hint = {};
    if (typeof named.window === "string" && named.window) hint.window = titled(named.window);
    const local = typeof named.agent === "string" ? named.agent : undefined;
    const endue = typeof named.agentId === "string" ? named.agentId : undefined;
    if (local) {
      const name = ctx.store.get().localAgents.find((a) => a.id === local)?.name;
      hint.agent = { id: local, name: name ?? local };
    } else if (endue) hint.agent = { id: endue, name: endue };
    return hint;
  };
  const offRuns = ctx.runtime?.commands?.watchRuns?.(({ id, args, caller }) => {
    if (caller !== ERIS || !card.running()) return undefined;
    const hint = hintOf(args);
    if (hint.window || hint.agent) card.hint(id, hint);
    return (result) => {
      const url = (result as { conversationUrl?: unknown } | null)?.conversationUrl;
      if (typeof url === "string" && hint.agent) urls.set(`endue:${hint.agent.id}`, url);
      const more = hintOf(result);
      if (more.window && !hint.window) card.hint(id, { ...hint, window: more.window });
    };
  });

  return {
    card,
    begin(line, about = []) {
      turnId = undefined;
      urls.clear();
      const open = new Set(windowsOf(ctx.store.get()).map((w) => w.id));
      const waiting: Component[] = about
        .filter((id) => open.has(id))
        .map((id) => ({
          key: `window:${id}`,
          kind: "window",
          name: surfaceTitle(ctx, id),
          window: id,
        }));
      card.begin(line, waiting.length > 1 ? waiting : []);
      return {
        step: (step) => card.step(step),
        hooks: {
          started: (id) => {
            turnId = id;
          },
          answer: (soFar) => card.answer(soFar),
          needs: (approvalId, waiting) => card.needs(approvalId, waiting),
        },
        end: (reply) => {
          card.end(reply);
          if (reply.reason && reply.reason !== "stopped") ctx.eris.setState("oops");
        },
      };
    },
    avoid(root, resting) {
      const doc = root.ownerDocument;
      const line = boxIn(doc.querySelector(".composer"), root);
      const active = doc.activeElement as HTMLElement | null;
      const typing =
        active &&
        !active.closest(".composer") &&
        (active instanceof HTMLInputElement ||
          active instanceof HTMLTextAreaElement ||
          active.isContentEditable);
      return { line, field: typing ? boxIn(active, root) : null, resting };
    },
    dispose() {
      offRuns?.();
    },
  };
}
