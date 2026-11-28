import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { DESK, openShell, step } from "./shell-helpers";

// The side of an agent's window (ADR 0411, FT-07): Home and Chat tabs; on Chat the agent's topics,
// one unfolding to its threads, a thread opening in the thread; on Home the routines and outputs
// rows, each showing its list in the thread's place. The side holds at 200 px, in dark and light
// with high contrast.
test.use({ viewport: DESK });

const MISO = "ag_sample0000000000000000001";
/** Where the PR's frames go, when asked: `SIDE_SHOTS=<dir>`. */
const SHOTS = process.env.SIDE_SHOTS;

async function shot(view: Locator, name: string): Promise<void> {
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

const theme = (page: Page, mode: string) =>
  page.evaluate((m) => window.__shell.desk.runtime.commands.run(`desk.theme.${m}`), mode);

test("the side's tabs, a topic's threads, and the routines and outputs lists", async ({ page }) => {
  const view = await openMiso(page);
  const side = view.locator(".thread-side");
  await expect(side.locator("[data-side-tab]")).toHaveText(["Home", "Chat"]);
  await expect(side.locator("[data-side-tab=chat]")).toHaveAttribute("aria-selected", "true");
  await expect(side.locator(".thread-topic .thread-side-title")).toHaveText([
    "# launch-plan",
    "# weekly-review",
  ]);
  // A topic unfolds to its threads and "New thread"; a thread opens in the thread.
  await side.locator("[data-key=topic-tp_launch]").click();
  const threads = side.locator("[data-topic=tp_launch] .thread-topic-threads");
  await expect(threads.locator("[data-conversation] .thread-side-title")).toHaveText([
    "Pricing page copy",
    "Launch checklist",
  ]);
  await expect(threads.locator("[data-action=new-thread]")).toHaveText("New thread");
  await threads.locator("[data-conversation=cnv_topic1]").click();
  await expect(view.locator(".thread-bubble").first()).toHaveText("Pricing page copy");
  for (const scheme of ["dark", "light"]) {
    await theme(page, scheme);
    await step(page, 200);
    await shot(view, `1-chat-topic-unfolded-${scheme}`);
  }

  // Home: two rows with their counts, each showing its list in the thread's place.
  await side.locator("[data-side-tab=home]").click();
  await expect(side.locator("[data-panel] .thread-side-title")).toHaveText(["Routines", "Outputs"]);
  await expect(side.locator("[data-count=routines]")).toHaveText("3");
  await expect(side.locator("[data-count=outputs]")).toHaveText("4");
  await side.locator("[data-panel=routines]").click();
  const panel = view.locator(".thread-panel");
  await expect(view.locator(".thread-home")).toBeHidden();
  await expect(panel.locator("[data-starts]")).toHaveText([
    "Every weekday at 9:00",
    "When its webhook is called",
    "Every Monday at 8:00",
  ]);
  for (const scheme of ["dark", "light"]) {
    await theme(page, scheme);
    await step(page, 200);
    await shot(view, `2-home-routines-${scheme}`);
  }
  await side.locator("[data-panel=outputs]").click();
  await expect(panel.locator("[data-list=outputs]")).toContainText("4 made");
  await shot(view, "3-home-outputs-light");
  await panel.locator("[data-action=panel-back]").click();
  await expect(view.locator(".thread-home")).toBeVisible();
});

test("the side holds at 200 px, in dark and light with high contrast", async ({ page }) => {
  const settings = encodeURIComponent(JSON.stringify({ "desk.theme.contrast": "high" }));
  const view = await openMiso(page, `?lang=en&endue=signed-in&init=${settings}`);
  const id = await view.evaluate((el) =>
    el.closest("section.surface")?.getAttribute("data-surface"),
  );
  if (!id) throw new Error("The agent window is unavailable.");
  await page.evaluate((w) => window.__shell.wm.place(w, { x: 700, y: 200, w: 236, h: 580 }), id);
  await step(page, 600);
  await view.getByRole("button", { name: "Show conversations" }).click();
  const side = view.locator(".thread-side");
  await expect(side).toBeVisible();
  await side.locator("[data-key=topic-tp_launch]").click();
  await expect(side.locator("[data-action=new-thread]")).toBeVisible();
  const fits = () =>
    side.evaluate((el) => ({
      width: el.getBoundingClientRect().width,
      over: el.scrollWidth - el.clientWidth,
    }));
  for (const scheme of ["dark", "light"]) {
    await theme(page, scheme);
    await step(page, 200);
    const box = await fits();
    expect(box.width).toBeGreaterThanOrEqual(199);
    expect(box.over).toBeLessThanOrEqual(0);
    await shot(view, `4-side-200-chat-${scheme}`);
  }
  await side.locator("[data-side-tab=home]").click();
  await expect(side.locator("[data-count=routines]")).toHaveText("3");
  expect((await fits()).over).toBeLessThanOrEqual(0);
  await shot(view, "5-side-200-home-light");
});
