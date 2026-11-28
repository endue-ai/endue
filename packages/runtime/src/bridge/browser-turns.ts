/**
 * The stub's turns of Eris (ADR 0089, FT-06): a scripted errand runs at once, as before, and a turn
 * a test holds stays open until the test steps it, adds to her answer and ends it, or the person
 * stops it, as the core's brain.turn and brain.stop do.
 */
import type { BrainReply, BrainStep, BrainTurnHooks, ShellBridge, WordTime } from "./types";

export type Errand = (text: string) => { steps: BrainStep[]; reply: string } | undefined;

/** A turn a test holds open and drives. */
export interface HeldTurn {
  readonly id: string;
  readonly text: string;
  step(step: BrainStep): void;
  /** More of her answer, as a delta adds it. */
  answer(more: string): void;
  /** An approval of the turn's waits for the person (perm.approval), or no longer does. */
  needs(approvalId: string, waiting: boolean): void;
  /** End it: with her answer so far, or with `reply`. */
  end(reply?: Partial<BrainReply>): void;
}

export interface Turns {
  say: ShellBridge["brain"]["say"];
  stop: NonNullable<ShellBridge["brain"]["stop"]>;
  /** Hold the next turn open: it waits for the test, which reads it from `held`. */
  hold(): void;
  /** The turn held open now. */
  held(): HeldTurn | undefined;
}

export function turnsOf(errand: Errand, wordTimes: (text: string) => WordTime[]): Turns {
  let holding = false;
  let count = 0;
  let open: (HeldTurn & { stop(): void }) | undefined;

  const hold = (text: string, onStep?: (step: BrainStep) => void, hooks?: BrainTurnHooks) =>
    new Promise<BrainReply>((resolve) => {
      const id = `turn-${++count}`;
      let soFar = "";
      const done = (reply: BrainReply) => {
        if (open?.id === id) open = undefined;
        resolve(reply);
      };
      open = {
        id,
        text,
        step: (step) => onStep?.(structuredClone(step)),
        answer(more) {
          soFar += more;
          hooks?.answer?.(soFar);
        },
        needs: (approvalId, waiting) => hooks?.needs?.(approvalId, waiting),
        end: (reply) => done({ text: soFar, ...reply }),
        stop: () => done({ text: "Stopped.", reason: "stopped" }),
      };
      hooks?.started?.(id);
    });

  return {
    async say(text, onStep, _desk, hooks) {
      if (holding) {
        holding = false;
        return hold(text, onStep, hooks);
      }
      hooks?.started?.(`turn-${++count}`);
      const scripted = errand(text);
      for (const step of scripted?.steps ?? []) {
        onStep?.(structuredClone(step));
        await Promise.resolve();
      }
      const reply =
        scripted?.reply ??
        (text.trim() ? `I'll look into "${text.trim()}" and tell you.` : "I'm here.");
      hooks?.answer?.(reply);
      return { text: reply, words: wordTimes(reply) };
    },
    async stop(turnId) {
      if (open?.id !== turnId) return false;
      open.stop();
      return true;
    },
    hold() {
      holding = true;
    },
    held: () => open,
  };
}
