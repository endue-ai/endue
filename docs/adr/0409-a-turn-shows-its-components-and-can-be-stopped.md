---
status: accepted
date: 2026-11-29
decision-makers: Team endue
---

# A turn shows its components and can be stopped

It adds to ADR 0089 (Eris's agentic loop), ADR 0271 and ADR 0275 (errands), and ADR 0405 (#831's
`reason`). It keeps every spark, thread and glow.

## Context and Problem Statement

In the 0.5.0 field test (#829, FT-06), a turn that used several windows, plugins and agents was hard
to follow:

1. Each step was a spark whose label left with it. Nothing listed what the turn did.
2. A failed step was a grey spark. Nothing said which component failed or why.
3. Her answer appeared only when the turn ended, so a long turn was silent.
4. A turn could not be stopped.
5. The person's line was shown nowhere once it had flown into her.
6. An approval a step waited for stood apart from the turn that asked for it.
7. Her card covered the field the person was typing in when she floated over it.

How does the desk show a turn's work as it happens, and let the person stop it?

## Decision Drivers

* A row is a component, not a call, so a long turn stays short to read
* Every row ends as done, failed, stopped or "cannot be taken back"; stop never leaves one half shown
* No argument or result crosses to the card: only the command's title and, on failure, its message
* The star marks only rows at work
* Announced politely, once per state change, not per delta

## Considered Options

* A card of the turn under Eris, its rows keyed by component, and `brain.stop` in the core
* A list of every call, one row each
* A window of its own for the turn

## Decision Outcome

Chosen option: "A card of the turn under Eris".

**The card** (`eris/turn-card.ts`, `eris/turn-model.ts`) sits inside her card (`said.ts`). It has
four parts, each shown only when it has something:

| Part | Holds |
| --- | --- |
| Line | The line she took in, on one line |
| Rows | One per component, in the order she first went to it; calls to one component fold into it with a count |
| Answer | Her answer as `delta`s add to it |
| Foot | "Working · 2 of 4 · 6 s" and Stop while it runs; after it, "Done · 4 steps · 1 failed · 8 s" as a disclosure of the rows |

A component is a plugin; a window a desk command names; a local agent (`desk.agents.*`); or an endue
agent (`desk.endue.ask`). The window and agent come from the call's arguments, as the errands read
them (`Commands.watchRuns`). A row is waiting, at work (the star), needs the person (a warning dot
and Review), done (a check and its time), failed ("<title> failed: <message>"), stopped, or sent.

A turn with no step and a short answer shows no card: soul text says it, as before. The card stays
while the turn runs, while a row failed, and until the person closes it or sends the next line.

**Stop** is a new bridge method, `brain.stop { turnId, scope } → { stopped }`. Only the caller that
said the line may stop its turn. The core raises the turn's flag (`core_turn_stop.rs`):

* the loop starts no further call and does not hand the brain the result of the call in flight;
* the wait on a command returns at once;
* the local agent runs the turn started are stopped;
* the turn ends at once as `error` with `reason: "stopped"` and the text "Stopped.", and nothing
  else of that turn is published.

A call already sent to a plugin runs on. Its row says "Sent; cannot be taken back".

**A failed step says why.** `tool-result` gains `message`: the first non-empty line of the command's
error, cut at 200 characters.

**Needs the person.** An approval (`perm.approval`) whose `task` is the turn's id marks the row of
the call still open as needing the person until the approval is settled.

**Placement.** `placeSaid` keeps the card clear of the field with the keyboard focus and of the
talk line. It tries under her, above her, then beside her. While she rests in the talk line (ADR
0254) the card opens from the line: above it, or below it when the line is high.

### Consequences

* Good, because a turn's work reads as a short list, and the person can stop it.
* Good, because a failed step names its component and the reason.
* Bad, because a call already sent cannot be called back, and the card can only say so.
* Neutral: stopping one component is offered only where a stop exists: a local agent's run.

### Confirmation

`crates/desk-core/tests/eris_loop.rs` (stop, the local run, the message), `eris/turn-model.test.ts`,
`eris/turn-card.test.ts`, the placement cases in `eris/said.test.ts`,
`apps/desk/src/shell-bridge.test.ts`, the spec vectors, and `e2e/eris-turn-card.spec.ts`.

## Pros and Cons of the Options

### A row per call

* Good, because each call is visible.
* Bad, because a turn that reads ten messages becomes ten rows.

### A window for the turn

* Good, because it can hold a long history.
* Bad, because it takes a place on the desk for a few seconds of work. The conversation that keeps
  past turns is a task of its own.
