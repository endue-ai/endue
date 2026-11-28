import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { DESK, openShell, step } from "./shell-helpers";

// An endue agent's window as its conversation (ADR 0411): it opens on the agent's newest
// conversation with the new-messages line, a line sent there grows an answer as the run writes
// it, a run can be stopped, a turn's work unfolds, and under 720 px the side is a drawer. It holds
// in dark and light, with high contrast and with reduced motion.
test.use({ viewport: DESK });

const MISO = "ag_sample0000000000000000001";
/** Where the PR's frames go, when asked: `THREAD_SHOTS=<dir>`. */
const SHOTS = process.env.THREAD_SHOTS;

async function shot(_page: Page, view: Locator, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const frame = view.locator("xpath=ancestor::section[contains(@class,'surface')]");
  await frame.screenshot({ path: join(SHOTS, `${name}.png`) });
}

async function openMiso(page: Page, query = "?lang=en&endue=signed-in"): Promise<Locator> {
  await openShell(page, query);
  await page.locator(`.sidebar [data-endue-agent="${MISO}"]`).click();
  const view = page.locator(`[data-endue-agent-view="${MISO}"]`);
  await expect(view.locator(".thread-bubble").first()).toBeVisible();
  return view;
}

async function windowOf(view: Locator): Promise<string> {
  const id = await view.evaluate((el) =>
    el.closest("section.surface")?.getAttribute("data-surface"),
  );
  if (!id) throw new Error("The agent window is unavailable.");
  return id;
}

test("an agent's window reads its thread, sends a line, and stops a run", async ({ page }) => {
  const view = await openMiso(page);
  const box = await view.evaluate((el) => {
    const r = el.closest("section.surface")?.getBoundingClientRect();
    return r ? { w: r.width, h: r.height } : null;
  });
  expect(box?.w).toBeGreaterThan(600);
  await expect(view.locator("[role=tab]")).toHaveText(["Home", "Studio"]);
  await expect(view.locator(".thread-side-row[aria-current=true] .thread-side-title")).toHaveText(
    "Move Friday's dentist",
  );
  await expect(view.locator(".thread-bubble")).toHaveText([
    "Move Friday's dentist",
    "Thanks. Can you go on?",
  ]);
  await expect(view.locator(".thread-new")).toHaveText("New messages");
  await expect(view.locator(".thread-work-line").first()).toHaveText(
    "Work completed · 14 s · 3 tools",
  );
  // A turn's work unfolds into its tool groups.
  await view.locator(".thread-work-head").first().click();
  await expect(view.locator(".thread-work-groups").first()).toBeVisible();
  await expect(view.locator(".thread-group-label").first()).toHaveText("Search the web");

  // A line held open: the answer grows as the run writes it, and Stop ends it.
  await page.evaluate(() => window.__shell.bridge.fake.thread.hold());
  const field = view.getByRole("textbox", { name: "Reply to Miso" });
  await field.fill("Make it Thursday at ten");
  await field.press("Enter");
  await step(page, 200);
  await expect(view.locator(".thread-bubble").last()).toHaveText("Make it Thursday at ten");
  await page.evaluate(() => {
    const run = window.__shell.bridge.fake.thread.held();
    run?.work({
      phase: "running",
      startedAt: "2026-11-09T09:00:00Z",
      attempted: 1,
      succeeded: 0,
      failed: 0,
      groups: [{ label: "Update the event", provider: "calendar", calls: 1, failed: 0 }],
    });
    run?.delta("Moving it to ");
    run?.delta("Thursday at ten.");
  });
  await step(page, 200);
  const running = view.locator(".thread-run");
  await expect(running.locator(".thread-work-line")).toHaveText("Working · Update the event");
  await expect(running.locator(".thread-prose")).toHaveText("Moving it to Thursday at ten.");
  await shot(page, view, "1-answer-in-flight-920");
  await view.getByRole("button", { name: "Stop" }).click();
  await step(page, 200);
  await expect(running).toHaveText("Stopped.");
  expect(await page.evaluate(() => window.__shell.bridge.fake.thread.stopped.length)).toBe(1);

  // A line that runs to its end: the answer stays in the thread.
  await field.fill("Thanks");
  await view.getByRole("button", { name: "Send" }).click();
  await step(page, 200);
  await expect(view.locator(".thread-prose p").last()).toHaveText("Here is what I found.");
  await expect(field).toHaveValue("");
});

test("under 720 px the side is a drawer, in dark and light with high contrast", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const settings = encodeURIComponent(
    JSON.stringify({ "desk.theme.contrast": "high", "desk.theme.motion": "reduce" }),
  );
  const view = await openMiso(page, `?lang=en&endue=signed-in&init=${settings}`);
  const id = await windowOf(view);
  await page.evaluate((w) => window.__shell.wm.place(w, { x: 700, y: 200, w: 360, h: 580 }), id);
  await step(page, 600);
  const side = view.locator(".thread-side");
  await expect(side).toBeHidden();
  const toggle = view.getByRole("button", { name: "Show conversations" });
  for (const scheme of ["dark", "light"]) {
    await page.evaluate(
      (mode) => window.__shell.desk.runtime.commands.run(`desk.theme.${mode}`),
      scheme,
    );
    await step(page, 200);
    const field = view.getByRole("textbox", { name: "Reply to Miso" });
    await expect(field).toBeVisible();
    expect(await field.evaluate((el) => el.getBoundingClientRect().width)).toBeLessThan(361);
    await shot(page, view, `2-narrow-360-${scheme}`);
  }
  await toggle.click();
  await expect(side).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await side.locator("[data-conversation]").last().click();
  await expect(side).toBeHidden();
  // With reduced motion nothing twinkles.
  const star = await view
    .locator(".thread-star")
    .evaluateAll((els) => els.map((el) => getComputedStyle(el).animationName));
  expect(star.every((name) => name === "none")).toBe(true);
});

test("the window in dark and light at 920 px", async ({ page }) => {
  const view = await openMiso(page);
  await view.locator(".thread-work-head").first().click();
  await view.locator(".thread-work").first().scrollIntoViewIfNeeded();
  for (const scheme of ["dark", "light"]) {
    await page.evaluate(
      (mode) => window.__shell.desk.runtime.commands.run(`desk.theme.${mode}`),
      scheme,
    );
    await step(page, 200);
    await expect(view.locator(".thread-composer")).toBeVisible();
    await shot(page, view, `3-thread-920-${scheme}`);
  }
});
