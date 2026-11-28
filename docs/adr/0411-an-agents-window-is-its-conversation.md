---
status: accepted
date: 2026-11-29
decision-makers: Team endue
---

# An agent's window is its conversation

It amends ADR 0129 (endue agents as windows), ADR 0232 (the Studio board on the card's back) and
ADR 0395 (asking an endue agent from the desk). Space windows keep their card and Front Desk
question.

## Context and Problem Statement

In the 0.5.0 field test (#829, FT-03), an endue agent's window was a 440 × 600 card with a question
form under it:

1. Every question opened a new conversation titled "From Desk". Nothing asked from the window went on.
2. The core read the run to its end, up to 90 seconds, and handed back only the final text. Nothing
   showed while the answer was written, or which tools the agent used.
3. No earlier message could be read.
4. Studio was the back of a card that turned over. Nothing on endue.ai does that.
5. The window opened inside the band Eris floats over, so she and her card covered it.

How does the desk show an agent so that one conversation goes on, as it does on endue.ai?

## Decision Drivers

* One conversation goes on: the composer sends into the conversation the window shows
* The answer shows as it is written, and a run can be stopped
* Only what the thread shows crosses the bridge: text, times, the run's phase and counts, and each
  tool group's label, provider and counts. No argument, result, reasoning, memory, file or person id
* The person's own line in the window asks nothing; Eris's `desk.endue.ask` keeps its review
* The window stays the runtime's own view: the desk's theme, no second sign-in, and Eris can address it

## Considered Options

* The window as the agent's conversation, on new `studio.*` methods
* endue.ai's own page in a web view
* The card, with the answer streamed into it

## Decision Outcome

Chosen option: "The window as the agent's conversation".

**The window** opens at 920 × 580 below the band Eris floats over (`crates/desk-wm/src/desk/edit.rs`)
and holds down to 360 px wide. It has four parts:

| Part | Holds |
| --- | --- |
| Header, 48 px | The side toggle, the agent's face with its dot, its name and handle, and the tabs Home and Studio |
| Side, 260 px | New chat, the pinned conversations, the recent ones; the star on a row whose run is in flight, "Needs your answer" on one that waits. Under 720 px it is a drawer over the thread |
| Thread | A column of at most 860 px: the person's bubbles at the right, the agent's prose with its time, the "New messages" line where the previous read falls, each turn's work as a box that unfolds its tool groups, and "Used in this turn" |
| Composer | A field that grows to 200 px, a menu (Open on endue.ai, Copy link), the microphone (FT-02 writes into the field) and Send, which is Stop while a run is in flight. The keys under it |

Studio is a tab and shows the board the card's back showed (ADR 0232), unchanged. The flip goes.

**The bridge** (`specs/bridge/v0/studio-chat.schema.json`, under `studio:manage`):

| Method or event | Does |
| --- | --- |
| `studio.messages.list` | A conversation's messages, a page before a message |
| `studio.chat.send` | The person's line into the conversation it names, or a new one; `messageId` makes a repeated send safe. Answers at once |
| `studio.chat.attach` | Follow a run already in flight |
| `studio.chat.stop` | Cancel a run on endue AI |
| `studio.conversations.read` | Mark the conversation read; answers when it was read before |
| `studio.chat.event` | A run's step, to the caller that sent or attached only: `started`, `delta`, `work`, `needsInput`, `completed`, `failed`, `cancelled` |

Only the shell (`desk`) may send, attach or stop. A line sent there is the person's own act, so
nothing asks. `desk.endue.ask` keeps ADR 0395's review and its final text only.

**The stream** (`crates/desk-platform`). The core reads the run's events as they come, on a thread of
its own, and forwards deltas joined so at most one leaves every 50 ms. It gives up after 90 seconds
without an event, not 90 seconds in all, and cuts a run past 2 MiB with a failure that says so. An
event it does not know is skipped. Tool rows are folded into the turn's `work` in the client; their
arguments and results are never read into a type. desk-sys cannot read a POST body as it arrives,
so `stream.rs` opens it with ureq under desk-sys's rules: the host allowlist, the system proxy, the
OS trust store, no redirects.

**States, each a sentence.** Signed out; offline (the thread stays readable, the composer says why
it cannot send); reading (a skeleton of three rows); an agent that is not active (the composer is
replaced by "This agent is not taking work." and a way to its Studio tab); a run that needs the
person; a failed run with Try again, which sends the same line again.

The pieces a plugin page can take too are in `packages/ui/src/patterns.css`: `.desk-thread`,
`.desk-bubble`, `.desk-work`, `.desk-composer`.

### Consequences

* Good, because one conversation goes on, and the answer shows as it is written.
* Good, because a run can be stopped, and the work of each turn can be read.
* Bad, because the shell reads a run on a thread of the core's for as long as it runs.
* Bad, because the stream transport sits in desk-platform until desk-sys can read a POST stream.
* Neutral: topics, routines and outputs in the side are FT-07's.

### Confirmation

`crates/desk-platform/tests/{chat,messages}.rs`, `crates/desk-core/tests/studio/thread.rs`,
`packages/runtime/src/surface/endue/thread/model.test.ts`,
`packages/runtime/src/surface/endue/windows.test.ts`, the spec vectors, and
`e2e/endue-thread.spec.ts` with `e2e/endue-windows.spec.ts`.

## Pros and Cons of the Options

### endue.ai's page in a web view

* Good, because it is endue.ai's own thread.
* Bad, because it needs a second sign-in, does not follow the desk's theme, and Eris cannot address it.

### The card, with the answer streamed into it

* Good, because it is a small change.
* Bad, because one conversation still does not go on, and nothing earlier can be read.
