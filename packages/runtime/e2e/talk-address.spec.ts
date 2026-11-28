// What the talk line's next line is about (FT-04, ADR 0407): the chip names the window in use, a
// press pins it and Backspace clears it; a link joins the line to that window's edge and follows
// it; the line is one row at rest and under the pointer, two open, every part of a row on its
// centre line; reduced motion changes sizes at once, and in the narrowest app nothing overflows.
import { expect, type Page, test } from "@playwright/test";
import type { SurfacePlacement } from "../src/modes/types";
import { DESK, openShell, step } from "./shell-helpers";

test.use({ viewport: DESK });

/** Calendar and Notes on desktop 1, Notes in use. */
async function seed(page: Page, notes = { x: 600, y: 200 }) {
  await page.evaluate(async (at) => {
    const win = (id: string, x: number, y: number): SurfacePlacement => ({
      id,
      plugin: "endue.shell",
      x,
      y,
      w: 380,
      h: 300,
      pinned: false,
    });
    await window.__shell.wm.desktop(1);
    await window.__shell.wm.session({
      1: {
        surfaces: [win("calendar", 120, 160), win("notes", at.x, at.y)],
        eris: null,
        rail: { visible: true },
        drawer: { visible: true },
      },
    });
    await window.__shell.wm.focus("notes");
  }, notes);
}

const pill = (page: Page) => page.locator(".talk-pill");
const chip = (page: Page) => page.locator(".talk-chip-pin");

/** The vertical centres of the visible parts of the line, by selector. */
const centres = (page: Page, parts: string[]) =>
  page.evaluate(
    (selectors) =>
      selectors.map((q) => {
        const el = document.querySelector<HTMLElement>(q);
        const r = el?.getBoundingClientRect();
        return r && r.height > 0 ? r.top + r.height / 2 : null;
      }),
    parts,
  );

function oneLine(ys: (number | null)[]) {
  const shown = ys.filter((y): y is number => y !== null);
  expect(shown.length).toBeGreaterThan(1);
  for (const y of shown) expect(Math.abs(y - (shown[0] as number))).toBeLessThanOrEqual(1);
}

test("the chip names the window in use; a press pins it; Backspace clears it", async ({ page }) => {
  await openShell(page, "?lang=en");
  await seed(page);
  await expect(chip(page)).toHaveAccessibleName("About Notes");
  await chip(page).click();
  await expect(chip(page)).toHaveAttribute("aria-pressed", "true");
  await page.evaluate(() => window.__shell.wm.focus("calendar"));
  await expect(chip(page)).toHaveAccessibleName("About Notes");
  await page.getByRole("button", { name: "Talk to Eris", exact: true }).click();
  await page.keyboard.press("Backspace");
  await expect(page.locator(".talk-chip")).toBeHidden();
});

test("the link's ring lies on the window's edge, and again after the window moves", async ({
  page,
}) => {
  await openShell(page, "?lang=en");
  await seed(page);
  const ringOnEdge = async () => {
    await step(page, 500);
    const { ring, box } = await page.evaluate(() => {
      const r = document.querySelector(".talk-link-ring")?.getBoundingClientRect();
      const w = document.querySelector('.surface[data-surface="notes"]')?.getBoundingClientRect();
      return {
        ring: r && { x: r.left + r.width / 2, y: r.top + r.height / 2 },
        box: w && { l: w.left, t: w.top, r: w.right, b: w.bottom },
      };
    });
    if (!ring || !box) throw new Error("no link or no window");
    const near = (a: number, b: number) => Math.abs(a - b) <= 1.5;
    const onEdge =
      ((near(ring.x, box.l) || near(ring.x, box.r)) &&
        ring.y >= box.t - 1.5 &&
        ring.y <= box.b + 1.5) ||
      ((near(ring.y, box.t) || near(ring.y, box.b)) &&
        ring.x >= box.l - 1.5 &&
        ring.x <= box.r + 1.5);
    expect(onEdge, JSON.stringify({ ring, box })).toBe(true);
    return ring;
  };
  await expect(page.locator(".talk-link")).toBeVisible();
  const before = await ringOnEdge();
  await seed(page, { x: 900, y: 120 });
  const after = await ringOnEdge();
  expect(after).not.toEqual(before);
});

test("one row at rest and under the pointer, two open, each row on its centre line", async ({
  page,
}) => {
  await openShell(page, "?lang=en");
  await seed(page);
  const row = [".talk-launch .talk-orb", ".talk-hint", ".talk-chip-pin", ".talk-shortcut"];
  oneLine(await centres(page, row));
  const rest = await pill(page).boundingBox();
  expect(rest && [Math.round(rest.width), Math.round(rest.height)]).toEqual([440, 40]);
  await pill(page).hover();
  await step(page, 400);
  const hover = await pill(page).boundingBox();
  expect(hover && [Math.round(hover.width), Math.round(hover.height)]).toEqual([560, 40]);
  // It grows from its centre.
  expect(hover && rest && Math.round(hover.x + hover.width / 2)).toBe(
    rest && Math.round(rest.x + rest.width / 2),
  );
  oneLine(await centres(page, row));
  await page.getByRole("button", { name: "Talk to Eris", exact: true }).click();
  await step(page, 400);
  const open = await pill(page).boundingBox();
  expect(open && [Math.round(open.width), Math.round(open.height)]).toEqual([640, 96]);
  oneLine(await centres(page, [".talk-grip", ".talk-chip-pin", ".talk-who"]));
  oneLine(
    await centres(page, [
      ".talk-field-orb",
      ".composer-input",
      ".talk-agent-button",
      ".talk-mic",
      ".talk-shortcut",
    ]),
  );
});

test("reduced motion changes sizes at once", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openShell(page, "?lang=en");
  await pill(page).hover();
  const hover = await pill(page).boundingBox();
  expect(hover && Math.round(hover.width)).toBe(560);
});

// The shell is never narrower than 1024 (shell.css), so its narrowest app stands for "360 px".
test("in the narrowest app nothing overflows the open line", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 600 });
  await openShell(page, "?lang=en");
  await seed(page, { x: 20, y: 80 });
  await page.evaluate(() => document.querySelector<HTMLButtonElement>(".talk-launch")?.click());
  await step(page, 400);
  const spill = await page.evaluate(() => {
    const line = document.querySelector(".talk-pill")?.getBoundingClientRect();
    if (!line) return ["no line"];
    const out: string[] = [];
    if (line.left < 0 || line.right > window.innerWidth) out.push("line");
    for (const el of document.querySelectorAll<HTMLElement>(".talk-pill > *:not([hidden])")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || el.matches(".popover")) continue;
      const outside = r.left < line.left - 0.5 || r.right > line.right + 0.5;
      if (outside || r.top < line.top - 0.5 || r.bottom > line.bottom + 0.5) out.push(el.className);
    }
    return out;
  });
  expect(spill).toEqual([]);
});
