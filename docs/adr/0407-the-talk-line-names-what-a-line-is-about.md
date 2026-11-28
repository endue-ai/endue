---
status: accepted
date: 2026-11-29
decision-makers: Team endue
---

# The talk line names what a line is about, and shows it

Continues ADR 0254 (Eris rests in the talk line) and ADR 0109 (the brain sees the desk). It
brings back a link between the talk line and a window, which ADR 0275 removed with the look glow.

## Context and Problem Statement

In the 0.5.0 field test (#829, FT-04) a line could not be about anything. The composer sent the
desk with the focused window first and the brain guessed what "this" meant. The agent picker
opened an agent's view but changed nothing about where the line went. Nothing on screen joined the
talk line to a window. Under the pointer only the border changed. Open, every part was placed by
hand, and the parts did not share a centre line.

How does the person see, and choose, where the next line goes, and how does the brain hear it?

## Decision Drivers

* The person sees where a line goes before sending it
* An address grants nothing: a line about a window asks every question it asks today
* A line to an agent never reaches Eris
* The link costs nothing while nothing moves, and the compositor is not touched
* No part of the line is placed by offsets

## Considered Options

* Keep guessing from focus, and say in the brain's words which window is focused
* One address on the talk line, shown as a chip and a link, sent as `BrainDesk.about`
* Per-window "Ask about this" buttons in each window's title bar

## Decision Outcome

Chosen option: "one address on the talk line", because the person sees and changes it where they
type, and the brain is told it outright instead of guessing.

* **The address** (`shell/talk-address.ts`) is `eris`, a `window`, several `windows` or an `agent`.
  * It follows the window in use, or the sweep's selection (ADR 0296).
  * A press on the chip pins it. A pinned address lasts until it is cleared or its window closes.
  * Backspace in the empty field clears it to `eris`, until the window in use changes. Escape
    clears a pinned address, and the next Escape closes the line. On an address that follows the
    window in use, Escape closes the line at once, as it always has.
  * `Alt+Up` cycles through the windows of the desktop in front, front to back, then `eris`.
* **The brain** gets `BrainDesk.about: { windows }`. The core says it as the first line after the
  desk's header ("The line is about notes: 'this' and 'here' mean it; use it first.") and offers
  those windows' plugins' tools first. The permission and the tools offered do not change.
* **An agent's window** (an endue agent's, `agent:<id>`, or a local agent's screen) sends the line
  to that agent and not to `brain.say`.
  * A local agent gets `desk.agents.ask`, with ADR 0099's approval.
  * An endue agent's window gets the line as a `desk:talk-agent-line` event. That window takes it
    once it holds a conversation (FT-03). Until then the desk says to write in that window.
  * The launch label reads "Talk to <name>" before the line is sent.
* **The chip** is a `.desk-chip`: `→ <title>`, cut at 180 px at rest, with a pin mark and
  `aria-pressed="true"` when pinned. Its name is "About <title>" or "To <agent>". A window on
  another desktop says "on desktop N".
* **The link** (`shell/talk-link.ts`) is a dashed curve, muted and not the star, from a dot on the
  talk line's edge to a ring on the nearest point of the window's border (`borderPoint`).
  * Its dashes stand still.
  * It is laid again only on a frame where an end moved. Its tick returns `IDLE`, so it never keeps
    the frame loop running (ADR 0164).
  * It shows at 60% at rest, and whole under the pointer, open or pinned.
  * `desk.shell.talk-link` (`always` | `hover` | `off`) changes that.
  * It hides for a window on another desktop or put away.
* **Sizes.** At rest it is one flex row, 440 × 40. Under the pointer, or with keyboard focus on it,
  it is 560 × 40, growing from its centre over `motion-base` with `--desk-easing`. Open, it is a
  two-row grid, 640 × 96:
  * Row 1: `[grip] [chip] … [who answers]`.
  * Row 2: `[orb] [field] [agents] [microphone] [key]`.

  Reduced motion changes sizes at once. The microphone starts FT-02's spoken turn (ADR 0406).

### Consequences

* Good, because "this" is what the person sees named, and the brain is told so.
* Good, because a line to an agent cannot reach Eris by mistake.
* Good, because the link is drawn in the page like an errand's thread and costs no frames at rest.
* Bad, because an endue agent's window does not take lines yet. Until FT-03 lands, a line
  addressed to one is not sent, and the desk says where to write.
* Neutral: the shell is never narrower than 1024 px (`shell.css`), so the issue's 360 px layout
  has no app to apply to. The narrowest app is checked instead.

### Confirmation

* `shell/talk-address.test.ts`, `shell/talk-link.test.ts`, `shell/TalkChrome.test.ts`
* `shell/Composer.test.ts` (`a_line_about_a_window_sends_about`,
  `a_line_to_an_agent_does_not_reach_brain_say`)
* `crates/desk-core/tests/eris_loop.rs` (`about_names_the_window_in_what_the_brain_reads`)
* `packages/runtime/e2e/talk-address.spec.ts`

## More Information

Issue #833. The words so far of a spoken turn show under Eris (ADR 0406), not in the field.
