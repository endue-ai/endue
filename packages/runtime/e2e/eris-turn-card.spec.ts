import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { openShell, step } from "./shell-helpers";

// The card of Eris's turn in flight (FT-06, ADR 0409): a scripted turn with four components shows
// four rows in the order she went to them (one done, one at work, one that needs the person, one
// that failed); Stop ends it with every row said; a turn that ends folds its rows into one line
// that opens them again. It holds with reduced motion and on the narrowest desk.
test.use({ viewport: { width: 1280, height: 800 } });

/** Where the PR's frames go, when asked: `TURN_SHOTS=<dir>`. */
const SHOTS = process.env.TURN_SHOTS;

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

/** Hold Eris's next turn, say `text` on the talk line, and let it fly into her. */
async function tell(page: Page, text: string): Promise<void> {
  await page.evaluate(() => window.__shell.bridge.fake.holdTurn());
  await page.locator("#composer-input").focus();
  await page.keyboard.type(text);
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await step(page, 800);
  await step(page, 600);
}

/** Four components: mail done, files at work, notes waiting on an approval, calendar failed. */
async function fourComponents(page: Page): Promise<void> {
  await page.evaluate(() => {
    const turn = window.__shell.bridge.fake.turn();
    if (!turn) throw new Error("no turn held");
    const call = (callId: string, command: string, provider: string, title: string) => ({
      callId,
      command,
      provider,
      title,
    });
    const mail = call("c1", "endue.mail.latest", "endue.mail", "Latest mail");
    const files = call("c2", "endue.files.list", "endue.files", "List Downloads");
    const notes = call("c3", "endue.notes.write", "endue.notes", "Save a note");
    const calendar = call("c4", "endue.calendar.today", "endue.calendar", "Today's events");
    turn.step({ kind: "tool", ...mail });
    turn.step({ kind: "tool-result", ...mail, ok: true });
    turn.step({ kind: "tool", ...files });
    turn.step({ kind: "tool", ...notes });
    turn.needs("a-1", true);
    turn.step({ kind: "tool", ...calendar });
    turn.step({ kind: "tool-result", ...calendar, ok: false, message: "the calendar is offline" });
    turn.answer("Two new messages, and your Downloads are next.");
  });
  await step(page, 1200);
  await step(page, 600);
}

const rows = (page: Page) =>
  page
    .locator(".turn-row")
    .evaluateAll((els) =>
      els.map((el) => [
        el.querySelector(".turn-name")?.firstChild?.textContent ?? "",
        (el as HTMLElement).dataset.state ?? "",
      ]),
    );

test("a turn with four components shows four rows in order, and Stop ends it", async ({ page }) => {
  await openShell(page, "?lang=en");
  await tell(page, "Go through my morning");
  await fourComponents(page);
  const card = page.locator(".turn-card");
  await expect(card).toBeVisible();
  await expect(card.locator(".turn-line")).toHaveText("Go through my morning");
  expect(await rows(page)).toEqual([
    ["Mail", "done"],
    ["Files", "working"],
    ["Notes", "needs"],
    ["Calendar", "failed"],
  ]);
  await expect(card.locator("[data-state=failed] .turn-say")).toHaveText(
    "Today's events failed: the calendar is offline",
  );
  await expect(card.locator("[data-act=review]")).toHaveText("Review");
  await expect(card.locator(".turn-answer")).toHaveText(
    "Two new messages, and your Downloads are next.",
  );
  // Every row can be reached by keyboard and names its component and state.
  await expect(card.locator(".turn-row-main").nth(2)).toHaveAttribute(
    "aria-label",
    "Notes: Needs your answer",
  );
  // The star marks only the row at work.
  const marked = await card
    .locator(".turn-mark")
    .evaluateAll((els) =>
      els.map((el) => getComputedStyle(el).backgroundColor !== "rgba(0, 0, 0, 0)"),
    );
  expect(marked).toEqual([true, true, false]);
  await shot(page, "1-four-components");

  await card.locator(".turn-stop").click();
  await step(page, 400);
  await step(page, 1600);
  await expect(card).toHaveAttribute("data-outcome", "stopped");
  expect(await rows(page)).toEqual([
    ["Mail", "done"],
    ["Files", "sent"],
    ["Notes", "sent"],
    ["Calendar", "failed"],
  ]);
  await expect(card.locator("[data-state=sent] .turn-say").first()).toHaveText(
    "Sent; cannot be taken back",
  );
  // A stop is the person's; she does not look as if something went wrong.
  await expect(page.locator(".eris")).not.toHaveAttribute("data-state", "oops");
});

test("a turn that ends folds its rows into one line that opens again", async ({ page }) => {
  await openShell(page, "?lang=en");
  await tell(page, "Go through my morning");
  await page.evaluate(() => {
    const turn = window.__shell.bridge.fake.turn();
    const files = { callId: "c1", command: "endue.files.list", provider: "endue.files" };
    const mail = { callId: "c2", command: "endue.mail.latest", provider: "endue.mail" };
    turn?.step({ kind: "tool", ...files, title: "List Downloads" });
    turn?.step({ kind: "tool-result", ...files, ok: true });
    turn?.step({ kind: "tool", ...mail, title: "Latest mail" });
    turn?.step({ kind: "tool-result", ...mail, ok: true });
    turn?.answer("Your Downloads hold three new files, and two messages wait in your mail.");
    turn?.end();
  });
  await step(page, 1600);
  await step(page, 1600);
  const card = page.locator(".turn-card");
  const fold = card.locator(".turn-fold");
  await expect(card).toHaveAttribute("data-outcome", "done");
  await expect(fold).toHaveText(/^Done · 2 steps · \d+ s$/);
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  await expect(card.locator(".turn-rows")).toBeHidden();
  await expect(card.locator(".turn-stop")).toBeHidden();
  await shot(page, "2-folded");
  await fold.click();
  await expect(card.locator(".turn-rows")).toBeVisible();
  expect(await rows(page)).toEqual([
    ["Files", "done"],
    ["Mail", "done"],
  ]);
  // Escape closes her card, the turn's with it.
  await card.locator(".turn-row-main").first().focus();
  await page.keyboard.press("Escape");
  await expect(card).toBeHidden();
});

test("with reduced motion and on the narrowest desk the card holds", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 640 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openShell(page, "?lang=en");
  await tell(page, "Go through my morning");
  await fourComponents(page);
  const card = page.locator(".eris-said");
  await expect(page.locator(".turn-card")).toBeVisible();
  const box = await card.boundingBox();
  expect(box).not.toBeNull();
  if (box) {
    expect(box.x).toBeGreaterThanOrEqual(16);
    expect(box.x + box.width).toBeLessThanOrEqual(1024 - 16);
  }
  const moving = await page
    .locator(".turn-row[data-state=working] .turn-mark")
    .evaluate((el) => getComputedStyle(el).animationName);
  expect(moving).toBe("none");
});
