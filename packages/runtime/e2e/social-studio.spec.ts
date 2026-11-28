import { basename, join } from "node:path";
import { expect, type Frame, type Page, test } from "@playwright/test";

// endue.social-studio (plugins/social-studio) on the browser stub over three endue.social accounts,
// in the sandboxed frame a plugin page gets: the Feed, Replies and Numbers at 360 px and at 900 px,
// in the dark and the light scheme. Each run writes a screenshot of the window to its output folder.
const SURFACE = '[data-surface="endue.social-studio"]';
const PLUGIN = join(import.meta.dirname, "../../../plugins/social-studio");
const SIZES = { narrow: { width: 360, height: 640 }, wide: { width: 900, height: 600 } };

test.use({ timezoneId: "UTC", locale: "en-US", viewport: { width: 1280, height: 900 } });

const run = (page: Page, command: string, args: Record<string, unknown> = {}) =>
  page.evaluate(([command, args]) => window.__desk.runtime.commands.run(command as string, args), [
    command,
    args,
  ] as const);

/** Open the fixture page and the studio at `size`, and resolve with its frame once the feed shows. */
async function open(page: Page, size: { width: number; height: number }, scheme: "dark" | "light") {
  // The SDK reads a plugin's catalogs at /<id>/<path> on its origin, as the app serves them.
  await page.context().route("**/endue.social-studio/messages/*.json", (route) =>
    route.fulfill({
      path: join(PLUGIN, "messages", basename(new URL(route.request().url()).pathname)),
    }),
  );
  await page.goto("/social-studio.html");
  await page.waitForFunction(() => window.__desk !== undefined);
  await page.evaluate(() => window.__desk.runtime.plugins?.ready);
  if (scheme === "light") await run(page, "desk.theme.light");
  await run(page, "desk.plugins.open", { plugin: "endue.social-studio" });
  const iframe = page.locator(`${SURFACE} iframe`);
  await expect(iframe).toBeVisible();
  // The window is the page plus its 40 px title bar and 2 px of border.
  // This page has no window manager: give the studio's window the size, as a person would.
  await page.addStyleTag({
    content: `.desk-surfaces { display: block !important; }
      ${SURFACE} { width: ${size.width + 2}px !important; height: ${size.height + 42}px !important; }`,
  });
  const frame = await (await iframe.elementHandle())?.contentFrame();
  if (!frame) throw new Error("no endue.social-studio frame");
  await expect(frame.locator("html")).toHaveAttribute("data-scheme", scheme);
  await expect(frame.locator("#list .row")).toHaveCount(5);
  await expect.poll(() => frame.evaluate(() => innerWidth)).toBe(size.width);
  return { frame, window: page.locator(SURFACE) };
}

/** Press `key` in the studio's page, as the person does with the window in focus. */
async function press(page: Page, frame: Frame, key: string) {
  await frame.locator("#title").click();
  await page.keyboard.press(key);
}

const fits = (frame: Frame) =>
  frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

for (const scheme of ["dark", "light"] as const)
  for (const [name, size] of Object.entries(SIZES))
    test(`${name} (${size.width}px, ${scheme}): the Feed, Replies and Numbers`, async ({
      page,
    }, info) => {
      const { frame, window } = await open(page, size, scheme);
      await expect(frame.locator("#list .row").first()).toContainText(
        "We are opening a second workshop next month",
      );
      await expect(frame.locator("#accounts")).toContainText("Reconnect on endue.ai");
      expect(await fits(frame)).toBe(true);
      await window.screenshot({ path: info.outputPath(`feed-${name}-${scheme}.png`) });

      await press(page, frame, "2");
      await expect(frame.locator("#list .row")).toHaveCount(4);
      await expect(frame.locator("#list .row-unseen")).toHaveCount(4);
      await frame.locator("#list .row").first().click();
      await expect(frame.locator("#detail .detail-text")).toHaveText(
        "Will the new workshop take visitors?",
      );
      await expect(frame.locator("#detail .detail-answers")).toContainText(
        "We are opening a second workshop",
      );
      expect(await fits(frame)).toBe(true);
      await window.screenshot({ path: info.outputPath(`replies-${name}-${scheme}.png`) });

      await press(page, frame, "Escape");
      await press(page, frame, "3");
      await expect(frame.locator("#numbers .card")).toHaveCount(3);
      await expect(
        frame.locator('#numbers .card [data-metric="engagement"] .series-value'),
      ).toContainText("%");
      await expect(frame.locator("#numbers polyline")).toHaveCount(4);
      expect(await fits(frame)).toBe(true);
      await window.screenshot({ path: info.outputPath(`numbers-${name}-${scheme}.png`) });
    });

test("a post opens on its network through the desk, and the window never loads a network's image", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  const { frame } = await open(page, SIZES.wide, "dark");
  await frame.locator("#list .row").nth(1).click();
  await expect(frame.locator("#detail .medium")).toHaveText("Image: Three jackets on a rail");
  await frame.getByRole("button", { name: "Open on Instagram" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.__desk.stub.log.some((l) => l.request.method === "shell.open")),
    )
    .toBe(true);
  expect(requests.filter((url) => url.includes(".example/"))).toEqual([]);
});
