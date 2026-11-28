import { basename, join } from "node:path";
import { expect, type Frame, type Page, test } from "@playwright/test";

// endue.social-studio's Drafts view (plugins/social-studio) on the browser stub over three
// endue.social accounts with their capabilities: a draft written once, previewed per account,
// reviewed and published account by account, at 360 px and 900 px in both schemes. Each run writes
// screenshots of the composer, the review and the outcome to its output folder.
const SURFACE = '[data-surface="endue.social-studio"]';
const PLUGIN = join(import.meta.dirname, "../../../plugins/social-studio");
const SIZES = { narrow: { width: 360, height: 720 }, wide: { width: 900, height: 640 } };

test.use({ timezoneId: "UTC", locale: "en-US", viewport: { width: 1280, height: 900 } });

const run = (page: Page, command: string, args: Record<string, unknown> = {}) =>
  page.evaluate(([command, args]) => window.__desk.runtime.commands.run(command as string, args), [
    command,
    args,
  ] as const);

async function open(page: Page, size: { width: number; height: number }, scheme: "dark" | "light") {
  await page.context().route("**/endue.social-studio/messages/*.json", (route) =>
    route.fulfill({
      path: join(PLUGIN, "messages", basename(new URL(route.request().url()).pathname)),
    }),
  );
  await page.goto("/social-studio-compose.html");
  await page.waitForFunction(() => window.__desk !== undefined);
  await page.evaluate(() => window.__desk.runtime.plugins?.ready);
  if (scheme === "light") await run(page, "desk.theme.light");
  await run(page, "desk.plugins.open", { plugin: "endue.social-studio" });
  const iframe = page.locator(`${SURFACE} iframe`);
  await expect(iframe).toBeVisible();
  await page.addStyleTag({
    content: `.desk-surfaces { display: block !important; }
      ${SURFACE} { width: ${size.width + 2}px !important; height: ${size.height + 42}px !important; }`,
  });
  const frame = await (await iframe.elementHandle())?.contentFrame();
  if (!frame) throw new Error("no endue.social-studio frame");
  await expect(frame.locator("html")).toHaveAttribute("data-scheme", scheme);
  await expect(frame.locator("#list .row")).toHaveCount(3);
  await expect.poll(() => frame.evaluate(() => innerWidth)).toBe(size.width);
  return { frame, window: page.locator(SURFACE) };
}

const fits = (frame: Frame) =>
  frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const preview = (frame: Frame, instance: string) =>
  frame.locator(`.preview[data-account="endue.social/${instance}"]`);

for (const scheme of ["dark", "light"] as const)
  for (const [name, size] of Object.entries(SIZES))
    test(`${name} (${size.width}px, ${scheme}): write once, review, publish to each account`, async ({
      page,
    }, info) => {
      const { frame, window } = await open(page, size, scheme);
      await frame.getByRole("tab", { name: "Drafts" }).click();
      await frame.getByRole("button", { name: "New draft" }).first().click();
      await frame
        .locator(".compose-text")
        .fill(
          "Fabric samples are back in stock: moss, rust and slate. Come by the shop this week.",
        );
      for (const instance of ["conn_ig", "conn_th", "conn_rd"])
        await frame
          .locator(`.compose-account input[data-account="endue.social/${instance}"]`)
          .check();
      await expect(preview(frame, "conn_ig")).toContainText(
        "Instagram needs a picture or a video.",
      );
      await expect(preview(frame, "conn_rd")).toContainText("Reconnect on endue.ai");
      await frame.getByRole("button", { name: "Add pictures or videos" }).click();
      await expect(frame.locator(".medium-name")).toHaveText("Image · jacket.jpg");
      await frame.locator(".medium-alt").fill("Three fabric swatches on a table");
      await expect(preview(frame, "conn_ig").locator(".preview-problems")).toHaveCount(0);
      await expect(preview(frame, "conn_th").locator(".preview-count")).toHaveText(
        "83 of 500 characters",
      );
      expect(await fits(frame)).toBe(true);
      await window.screenshot({ path: info.outputPath(`composer-${name}-${scheme}.png`) });

      await frame.getByRole("button", { name: "Publish…" }).click();
      const dialog = frame.getByRole("dialog");
      await expect(dialog).toContainText("Publish to 2 accounts?");
      await expect(dialog).toContainText("Your endue key may not publish yet");
      await expect(dialog).toContainText("Left out: Studio on Reddit. Reconnect on endue.ai");
      await expect(dialog.locator(".review-media li").first()).toHaveText(
        "Image · jacket.jpg · described as “Three fabric swatches on a table”",
      );
      await expect(dialog.getByRole("button", { name: "Publish to 2 accounts" })).toBeFocused();
      await window.screenshot({ path: info.outputPath(`review-${name}-${scheme}.png`) });

      await dialog.getByRole("button", { name: "Publish to 2 accounts" }).click();
      await expect(preview(frame, "conn_ig").locator(".outcome")).toHaveAttribute(
        "data-state",
        "published",
      );
      await expect(preview(frame, "conn_th").locator(".outcome")).toContainText(
        "Threads did not take the link",
      );
      await expect(frame.getByRole("button", { name: "Open on Instagram" })).toBeVisible();
      await preview(frame, "conn_th").scrollIntoViewIfNeeded();
      expect(await fits(frame)).toBe(true);
      await window.screenshot({ path: info.outputPath(`outcome-${name}-${scheme}.png`) });

      await preview(frame, "conn_th").getByRole("button", { name: "Try again" }).click();
      await expect(preview(frame, "conn_th").locator(".outcome")).toHaveAttribute(
        "data-state",
        "published",
      );
      const published = await page.evaluate(
        () =>
          window.__desk.stub.log.filter(
            (l) =>
              l.request.method === "cmd.invoke" &&
              (l.request.params as { id?: string }).id === "endue.social.post.publish",
          ).length,
      );
      expect(published).toBe(3);
    });
