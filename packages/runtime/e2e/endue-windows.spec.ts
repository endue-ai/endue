// The person's endue agents and spaces on the desk (ADR 0129): signed in, the agent bar lists them
// from studio.* with their faces (ADR 0232). An agent opens as its conversation with Studio as a tab
// (ADR 0411; the thread itself is endue-thread.spec.ts); a space opens as a card that Studio turns
// over to its status, and asks its Front Desk.
import { expect, test } from "@playwright/test";
import { DESK, openShell, step } from "./shell-helpers";

test.use({ viewport: DESK });

const MISO = "ag_sample0000000000000000001";
const SCOUT = "ag_sample0000000000000000003";

test.describe("endue agents and spaces as windows", () => {
  test("asks the space Front Desk from its window", async ({ page }) => {
    await openShell(page, "?lang=en&endue=signed-in");
    await page.locator('.sidebar [data-endue-space="sp_sample001"]').click();
    const view = page.locator('[data-endue-space-view="sp_sample001"]');
    await view.getByRole("button", { name: "Ask Front Desk" }).click();
    await view.getByRole("textbox", { name: "Question" }).fill("What is ready for review?");
    await view.getByRole("button", { name: "Send question" }).click();
    await expect(view.getByRole("status")).toContainText("The outline is ready.");
    await view.getByRole("button", { name: "Open conversation on endue.ai" }).click();
    await expect
      .poll(() => page.evaluate(() => window.__shell.bridge.fake.opened.at(-1)))
      .toBe("https://endue.ai/spaces/sp_sample001/admin");
  });

  test("appear in the agent bar once the desk signs in", async ({ page }) => {
    await openShell(page, "?lang=en&endue=1");
    await expect(page.locator(".sidebar [data-endue-agent]")).toHaveCount(0);
    await expect(page.locator(".sidebar [data-agent]").first()).toBeVisible();
    await page.evaluate(() =>
      window.__shell.bridge.fake.setAccount({
        state: "signed-in",
        profile: { displayName: "Ada" },
      }),
    );
    await expect(page.locator(".sidebar [data-endue-agent]")).toHaveCount(3);
    await expect(page.locator(".sidebar [data-endue-space]")).toHaveCount(2);
    await expect(page.locator(".sidebar [data-agent]")).toHaveCount(0);
    await expect(page.locator(`.sidebar [data-endue-agent="${MISO}"]`)).toHaveAttribute(
      "data-presence",
      "working",
    );
    // Each agent's face, read by the core and handed over as a data: URL (ADR 0232).
    const faces = page.locator(".sidebar [data-endue-agent] img.avatar-face");
    await expect(faces).toHaveCount(3);
    await expect(faces.first()).toHaveAttribute("src", /^data:image\//);
  });

  test("an agent opens as its conversation, with Studio as a tab", async ({ page }) => {
    await openShell(page, "?lang=en&endue=signed-in");
    await page.click(`.sidebar [data-endue-agent="${MISO}"]`);
    const view = page.locator(`[data-endue-agent-view="${MISO}"]`);
    await expect(view.locator(".thread-head .thread-name")).toHaveText("Miso");
    await expect(view.locator(".thread-head .thread-handle")).toHaveText("@miso");
    // The window clears the band Eris floats over (ADR 0411).
    const top = await view.evaluate(
      (el) => el.closest("section.surface")?.getBoundingClientRect().top ?? 0,
    );
    expect(top).toBeGreaterThan(150);
    await expect(view.getByRole("textbox", { name: "Reply to Miso" })).toBeInViewport();
    await view.locator('[data-tab="studio"]').click();
    await step(page, 300);
    const studio = view.locator(".thread-studio");
    await expect(studio).toBeVisible();
    await expect(view.locator(".thread-home")).toBeHidden();
    // Studio is the board the card's back showed (ADR 0232): the ways in, the sheet, what it reaches.
    await expect(studio.locator(".studio-name")).toHaveText("Miso");
    await expect(studio.locator('[data-col="in"] [data-row]')).toHaveCount(5);
    await expect(studio.locator('[data-section="model"] .studio-sheet-value')).toHaveText(
      "claude-sonnet-4.5",
    );
    await expect(studio.locator('[data-row="channel"]')).toHaveAttribute("data-state", "on");
    await expect(studio.locator('[data-row="channel"] .studio-row-sub')).toHaveText("Acme");
    await expect(studio.locator('[data-section="memory"] .studio-sheet-value')).toHaveText(
      "12 memories · 3 rules",
    );
    await expect(studio.locator('svg.studio-lines [data-line="console:branch"]')).toBeAttached();
    await studio.locator('[data-row="live"] [data-row-head]').click();
    await expect(studio.locator('[data-row="live"] .studio-row-body')).toBeVisible();
    await expect(studio.locator('.endue-actions [data-action^="open-"]')).toHaveText([
      "Edit in Studio",
    ]);
    await view.locator('[data-tab="home"]').click();
    await step(page, 300);
    await expect(studio).toBeHidden();
  });

  test("a space opens as a window, and its Studio opens one of its agents", async ({ page }) => {
    await openShell(page, "?lang=en&endue=signed-in");
    await page.click('.sidebar [data-endue-space="sp_sample001"]');
    const view = page.locator('[data-endue-space-view="sp_sample001"]');
    await expect(view.locator('[data-face="front"] .endue-title')).toHaveText("Launch");
    await expect(view.locator('[data-face="front"] .endue-handle')).toHaveText("Front desk · Miso");
    await view.locator('[data-face="front"] [data-action="studio"]').click();
    await step(page, 600);
    await expect(view.locator('[data-fact="rooms"] dd')).toHaveText("2 · 3 unread · 1 discussing");
    await view.locator(`[data-member="${SCOUT}"]`).click();
    await expect(page.locator(`[data-endue-agent-view="${SCOUT}"]`)).toBeVisible();
  });
});
