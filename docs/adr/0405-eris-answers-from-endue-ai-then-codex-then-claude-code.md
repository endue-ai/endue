---
status: accepted
date: 2026-11-29
decision-makers: Team endue
---

# Eris answers from endue AI, then the person's Codex, then their Claude Code

Amends ADR 0094 (the fallback) and ADR 0109 (the recipe for a coding CLI as her model).

## Context and Problem Statement

In the 0.5.0 field test (#829, FT-01) every line to Eris ended with "Something went wrong on my
side". The `endue` brain was a `specs/brain/v0` server at an address that does not answer, so every
turn fell to the local brain. The local brain asked Ollama for `llama3.2`, which most computers do
not hold. Ollama answered 404, and the desk read that 404 as a lost session, tried three more times
and gave up. Meanwhile the person was signed in to endue, where their own Eris already answers on
the web, and many people have Codex or Claude Code signed in on the same computer. Which brain
should answer, and in what order?

## Decision Drivers

* Eris on the desk is the person's Eris on endue AI whenever they are signed in
* No key in the desk: every brain signs in with the person's own account
* A turn never asks for something that is not there, and never mistakes "not there" for "try again"
* The person's choice (`brain.use`) still wins while it can answer

## Considered Options

* Keep one fallback, the local brain (ADR 0094)
* An ordered fallback: endue AI, Codex, Claude Code, then a model on this computer
* Ask the person to choose before the first line

## Decision Outcome

Chosen option: "An ordered fallback", because it answers the first line on most computers with no
setup and keeps endue AI first.

* **endue AI.** The `endue` brain is the person's own Eris on the endue AI platform, reached with the
  endue ID token the desk already holds (ADR 0089). `GET /api/v1/ai/secretary` names her agent and
  conversation, the same conversation the web uses; each answer is one run on it
  (`POST /api/v1/ai/conversations/{id}/runs`). She answers in words with endue AI's own tools. A
  turn that must call one of the desk's tools (`brain.ask`) goes to the next brain. Signed out, or
  on an account without her, she cannot be reached. `DESK_BRAIN_URL` still points the desk at a
  `specs/brain/v0` brain, for development.
* **Codex.** A new brain, `codex`: the person's Codex CLI, run once per answer as `codex exec` in a
  read-only sandbox, the prompt on stdin and the answer read back from `--output-last-message`
  through a strict `--output-schema`. It is ADR 0109's recipe: the desk's tools are in the prompt,
  and the desk runs every call.
* **Claude Code.** ADR 0109's brain, unchanged.
* **A model on this computer.** With `brain.model` unset, the local brain asks Ollama for its model
  list and uses the first model that is not only for embeddings. With none, it cannot answer. A 404
  for a named model also means it cannot answer, never that a session was lost.

`brain.use` still names one brain. When that brain cannot answer, the turn goes to the first brain
after it in this order that can, and that brain's own chain is the rest of the list. Eris says
`FALLBACK_LINE` once, until the chosen brain answers again. `brain.status` adds `answering`, the
brain that stands in. A local choice still never reaches out.

A turn that fails says why. `brain.turn`'s `error` and `offline` carry `reason` (`no_brain`,
`signed_out`, `read_only`, `too_many_steps`, `failed`), and `text` stays the sentence for people.
A turn no brain answers says `offline` once and ends with `no_brain` after `give_up` (20 s), so Eris
never thinks for ever. Her card offers the command that fixes the reason: "Choose a brain"
(`desk.eris.model`) or "Sign in" (`desk.account.sign-in`). Every failed turn is in the desk's log,
channel `brain`, at `warn`: the turn, the reason, the brain's mode and what the brain said, never
the person's line.

### Consequences

* Good, because a signed-in desk answers with the person's own Eris and her memory.
* Good, because a desk that is signed out still answers on most developers' computers.
* Bad, because Eris on endue AI does not run the desk's tools yet: "open the newest picture" is
  answered in words. Desk tools over the platform need a client-tool round trip there (a follow-up).
* Bad, because Codex's flags are its CLI's, not a contract; a refused option says to update it.

### Confirmation

`crates/desk-core/tests/brain_choice.rs` (`a_turn_goes_down_endue_codex_claude_then_local`,
`with_none_of_them_a_model_this_computer_holds_answers`), `crates/desk-boot/src/endue_eris_tests.rs`,
`crates/desk-brain-local/src/codex_tests.rs`, `crates/desk-brain-local/tests/failures.rs`
(`a_model_the_server_does_not_hold_is_no_model_not_a_lost_session`) and
`crates/desk-platform/tests/chat.rs`; for the reasons, `crates/desk-core/tests/turn_failures.rs`,
`packages/runtime/src/eris/said.test.ts` and `apps/desk/src/shell-bridge.test.ts`.
