---
status: accepted
date: 2026-11-29
decision-makers: Team endue
---

# What is handed over is seen going

Amends ADR 0271 (a window Eris is at glows and her errands run along a thread). It keeps ADR
0275's meaning of an errand and ADR 0407's talk-line link.

## Context and Problem Statement

In the 0.5.0 field test (#829, FT-05), four hand-overs were hard to follow:

1. A sent line was a ghost of its text that flew into Eris for 1400 ms, whatever the line was about.
2. An errand was one spark on a dotted thread. One dot is hard to follow across a large desk.
3. A window put away was gone at once. Nothing showed that it went to the drawer.
4. Nothing marked an arrival.

How does the desk show where a thing went, without a new moving part that runs on its own?

## Decision Drivers

* Every hand-over is seen from where it leaves to where it arrives
* The star's colour stays where an agent is at work
* Nothing moves on its own; at rest the page asks for no frames (ADR 0164)
* The compositor is not touched, and `just perf-motion` stays green
* Reduced motion still marks the hand-over

## Considered Options

* One trail primitive in the page: a head, three followers and an arrival ring
* A canvas overlay that draws every trail
* Keep the ghost and the single spark, and add a ring at the end

## Decision Outcome

Chosen option: "One trail primitive in the page".

`eris/trail.ts` moves a 6 px head and three followers along a way. The way is a function from 0..1
to a point, read again on every frame, so a way whose ends move stays joined.

| Part | Value |
| --- | --- |
| Followers | 0.06, 0.12 and 0.18 of the way behind; 0.7, 0.55 and 0.40 of the size; opacity 0.55, 0.40, 0.25 |
| Flight | 720 ms, `cubic-bezier(0.45, 0, 0.2, 1)`; the trail fades over the last 15% |
| Arrival | One ring grows from 1 to 3.4 times its size and fades over 560 ms |
| Several | At most 12 flights; each starts `min(170, 1200 / (n − 1))` ms after the one before and takes 950 ms |

The parts are `aria-hidden` elements on the shell, moved by `transform` and `opacity` only. A flight
that starts while the page is hidden is skipped. A 13th flight waits until one ends.

It runs for four acts:

| Act | From → to | Colour |
| --- | --- | --- |
| A line is sent | The talk field → along the link (ADR 0407) to each window the line is about; with none, into Eris | star |
| An errand | The spark is the head; three followers run behind it on its arc. `LEG_MS`, `DWELL_MS` and the thread are unchanged | her gold out, the star back, grey on a failure |
| A window is put away | Its middle → the drawer's handle, or for an agent's window its row in the agent bar | muted |
| A window comes back | The drawer's handle → where it opens | muted |

The text of a sent line fades where it stands in 200 ms. With reduced motion nothing flies, and the
arrival shows a still ring for 560 ms, by opacity alone.

`stash` and `raise` (`shell/actions.ts`) tell the store's hand-overs (`shell/hand-over.ts`) before
their edit. The drawer, which knows the page, flies the trail.

### Consequences

* Good, because each hand-over is seen from start to end, and the person can find a put-away window.
* Good, because the trail uses the theme's tokens without reading them, and costs no frames at rest.
* Bad, because the shell holds up to 60 more elements during a burst of flights.
* Neutral: a line to an agent now leaves a trail too, though it never reaches Eris (ADR 0407).

### Confirmation

`eris/trail.test.ts`, the trail cases in `Composer.test.ts`, `errand.test.ts` and
`actions.test.ts`, `e2e/trail.spec.ts`, and `just perf-motion`.

## Pros and Cons of the Options

### A canvas overlay

* Good, because one element draws every trail.
* Bad, because a full-screen canvas costs a texture in the page every frame it draws, and it must
  read the theme's colours.

### Keep the ghost and the spark, and add a ring

* Good, because it changes the least.
* Bad, because one dot and a blurred ghost are still hard to follow, and a window put away still
  vanishes.
