// @vitest-environment jsdom
// The card of Eris's turn in flight (FT-06, ADR 0409): her answer fills as it comes, the rows fold
// into one line when the turn ends, a row that waits for the person offers Review, a short answer
// with no step stays soul text, and changes are announced once per state change.
import { afterEach, describe, expect, it } from "vitest";
import type { BrainStep } from "../bridge/types";
import { mountTurnCard, type TurnActions } from "./turn-card";
import type { Row } from "./turn-model";

let clock = 0;
const acted: Array<[string, string]> = [];
const actions: TurnActions = {
  stop: () => acted.push(["stop", ""]),
  press: (row: Row) => acted.push(["press", row.key]),
  review: (row: Row) => acted.push(["review", row.key]),
  stopRun: (row: Row) => acted.push(["stop-run", row.key]),
  conversation: (row: Row) => acted.push(["conversation", row.key]),
};

function card() {
  clock = 0;
  acted.length = 0;
  const c = mountTurnCard(
    document,
    () => "en",
    () => clock,
    actions,
  );
  document.body.append(c.el);
  const q = <T extends Element = HTMLElement>(sel: string) =>
    c.el.querySelector<T & HTMLElement>(sel);
  const rows = () =>
    [...c.el.querySelectorAll<HTMLElement>(".turn-row")].map((r) => [
      r.querySelector(".turn-name")?.firstChild?.textContent,
      r.dataset.state,
    ]);
  return { c, q, rows };
}

const tool = (callId: string, command: string, provider: string, title?: string): BrainStep => ({
  kind: "tool",
  callId,
  command,
  provider,
  ...(title ? { title } : {}),
});
const result = (s: BrainStep, ok = true, message?: string): BrainStep => ({
  ...s,
  kind: "tool-result",
  ok,
  ...(message ? { message } : {}),
});

afterEach(() => document.body.replaceChildren());

describe("the turn card", () => {
  it("the_answer_fills_as_deltas_arrive", () => {
    const { c, q } = card();
    c.begin("Summarise my mail");
    const mail = tool("c1", "endue.mail.latest", "endue.mail", "Latest mail");
    c.step(mail);
    expect(c.showing()).toBe(true);
    expect(q(".turn-line")?.textContent).toBe("Summarise my mail");
    c.step(result(mail));
    c.answer("You have two");
    expect(q(".turn-answer")?.textContent).toBe("You have two");
    c.answer("You have two new messages.");
    expect(q(".turn-answer")?.textContent).toBe("You have two new messages.");
    expect(q(".turn-answer")?.hidden).toBe(false);
  });

  it("rows_fold_into_one_line_when_the_turn_ends", () => {
    const { c, q, rows } = card();
    c.begin("Tidy up");
    const a = tool("c1", "endue.mail.archive", "endue.mail", "Archive mail");
    const b = tool("c2", "endue.files.list", "endue.files", "List files");
    c.step(a);
    clock = 1000;
    c.step(b);
    expect(q(".turn-fold")?.textContent).toBe("Working · 0 of 2 · 1 s");
    expect(q<HTMLButtonElement>(".turn-stop")?.hidden).toBe(false);
    c.step(result(a));
    c.step(result(b));
    clock = 4000;
    expect(c.end({ text: "Done." })).toBe(true);
    expect(rows()).toEqual([
      ["Mail", "done"],
      ["Files", "done"],
    ]);
    const fold = q<HTMLButtonElement>(".turn-fold");
    expect(fold?.textContent).toBe("Done · 2 steps · 4 s");
    expect(q<HTMLButtonElement>(".turn-stop")?.hidden).toBe(true);
    expect(q(".turn-rows")?.hidden).toBe(true);
    expect(fold?.getAttribute("aria-expanded")).toBe("false");
    fold?.click();
    expect(q(".turn-rows")?.hidden).toBe(false);
    expect(fold?.getAttribute("aria-expanded")).toBe("true");
  });

  it("a_row_that_needs_the_person_offers_review", () => {
    const { c, q, rows } = card();
    c.begin("Save the draft");
    c.step(tool("c1", "endue.files.write", "endue.files", "Save a file"));
    c.needs("a-1", true);
    expect(rows()).toEqual([["Files", "needs"]]);
    const main = q(".turn-row-main");
    expect(main?.getAttribute("aria-label")).toBe("Files: Needs your answer");
    q<HTMLButtonElement>("[data-act=review]")?.click();
    main?.click();
    expect(acted).toEqual([
      ["review", "plugin:endue.files"],
      ["press", "plugin:endue.files"],
    ]);
    c.needs("a-1", false);
    expect(q("[data-act=review]")).toBeNull();
    q<HTMLButtonElement>(".turn-stop")?.click();
    expect(acted.at(-1)).toEqual(["stop", ""]);
  });

  it("a_short_answer_with_no_step_shows_no_card", () => {
    const { c } = card();
    c.begin("Hi");
    c.answer("Hello.");
    expect(c.showing()).toBe(false);
    expect(c.end({ text: "Hello." })).toBe(false);
    expect(c.showing()).toBe(false);
    // A long one, or a failure, stays her card's text, as before: the turn's card is for the work.
    c.begin("Tell me a story");
    c.answer("Once upon a time ".repeat(6));
    expect(c.showing()).toBe(false);
    expect(c.end({ text: "Once upon a time ".repeat(6) })).toBe(false);
    c.begin("Hi");
    expect(c.end({ text: "I can't reach endue right now.", reason: "no_brain" })).toBe(false);
  });

  it("the_card_is_announced_once_per_state_change", () => {
    const { c, q } = card();
    const told: string[] = [];
    const live = q(".sr-only");
    expect(live?.getAttribute("aria-live")).toBe("polite");
    new MutationObserver(() => told.push(live?.textContent ?? "")).observe(live as Node, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    c.begin("Read the report");
    const read = tool("c1", "endue.files.read", "endue.files", "Read a file");
    c.step(read);
    return Promise.resolve().then(() => {
      const after = told.length;
      for (const soFar of ["The", "The report", "The report says"]) c.answer(soFar);
      c.tick();
      return Promise.resolve().then(() => {
        expect(told.length).toBe(after);
        c.step(result(read, false, "no such file: report.md"));
        return Promise.resolve().then(() => {
          expect(told.length).toBe(after + 1);
          expect(told.at(-1)).toBe("Files: Read a file failed: no such file: report.md");
        });
      });
    });
  });
});
