// What is handed over is seen going (FT-05, ADR 0408): a trail runs from where a thing leaves to
// where it arrives, and one ring marks the arrival. A sent line flies to the window it is about,
// a window put away flies to the drawer's handle and back from it, and with reduced motion only a
// still ring shows. The fixture's clock drives every frame.
import { expect, type Page, test } from "@playwright/test";
import type { SurfacePlacement } from "../src/modes/types";
import { DESK, openShell, putAway, step } from "./shell-helpers";

test.use({ viewport: DESK });

/** One flight (FLIGHT_MS) and the ring after it (RING_MS). */
const FLIGHT = 720;
const RING = 560;

/** Calendar and Notes on desktop 1, Notes in use, the drawer shown. */
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
  await step(page, 16);
}

/** Say `text` on the talk line; the clock stands still. */
async function tell(page: Page, text: string) {
  await page.locator("#composer-input").focus();
  await page.keyboard.type(text);
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
}

/** For a person to see each act: TRAIL_SHOTS=<dir> keeps a picture of each moment. */
const shot = async (page: Page, name: string) => {
  const dir = process.env.TRAIL_SHOTS;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
};

type Box = { l: number; t: number; r: number; b: number };

/** The arrival ring's middle and how clear it is, and the box of `selector`. */
const ringBy = (page: Page, selector: string) =>
  page.evaluate((q) => {
    const ring = document.querySelector<HTMLElement>(".trail-ring");
    const r = ring?.getBoundingClientRect();
    const w = document.querySelector(q)?.getBoundingClientRect();
    return {
      ring: r && { x: r.left + r.width / 2, y: r.top + r.height / 2 },
      opacity: ring ? Number(getComputedStyle(ring).opacity) : 0,
      box: w && { l: w.left, t: w.top, r: w.right, b: w.bottom },
    };
  }, selector);

/** Whether `p` lies on `box`'s border, give or take the ring's rounding. */
function onEdge(p: { x: number; y: number }, box: Box): boolean {
  const near = (a: number, b: number) => Math.abs(a - b) <= 2;
  return (
    ((near(p.x, box.l) || near(p.x, box.r)) && p.y >= box.t - 2 && p.y <= box.b + 2) ||
    ((near(p.y, box.t) || near(p.y, box.b)) && p.x >= box.l - 2 && p.x <= box.r + 2)
  );
}

const inside = (p: { x: number; y: number }, box: Box) =>
  p.x >= box.l && p.x <= box.r && p.y >= box.t && p.y <= box.b;

test("a sent line's trail ends in a ring on the edge of the window it is about", async ({
  page,
}) => {
  await openShell(page, "?lang=en");
  await seed(page);
  await tell(page, "summarise this");
  await step(page, 32);
  await expect(page.locator('.trail[data-tone="star"]')).toHaveCount(1);
  await expect(page.locator(".trail")).toHaveAttribute("aria-hidden", "true");
  await step(page, FLIGHT / 2);
  await shot(page, "1-line-flying");
  await step(page, FLIGHT / 2 + 32);
  await shot(page, "2-line-arrived");
  const { ring, opacity, box } = await ringBy(page, '.surface[data-surface="notes"]');
  if (!ring || !box) throw new Error("no ring or no window");
  expect(opacity).toBeGreaterThan(0);
  expect(onEdge(ring, box), JSON.stringify({ ring, box })).toBe(true);
  await step(page, RING + 32);
  await expect(page.locator(".trail")).toHaveCount(0);
});

test("while the window moves the trail stays joined to it", async ({ page }) => {
  await openShell(page, "?lang=en");
  await seed(page);
  await tell(page, "summarise this");
  await step(page, FLIGHT / 2);
  await seed(page, { x: 900, y: 120 });
  await step(page, FLIGHT / 2 + 32);
  const { ring, box } = await ringBy(page, '.surface[data-surface="notes"]');
  if (!ring || !box) throw new Error("no ring or no window");
  expect(box.l).toBeGreaterThan(890);
  expect(onEdge(ring, box), JSON.stringify({ ring, box })).toBe(true);
});

test("a window put away flies muted to the drawer's handle, and back to where it opens", async ({
  page,
}) => {
  await openShell(page, "?lang=en");
  // The morning desk's second desktop holds Calendar, which the drawer keeps once it is put away.
  await page.click('[data-desktop="2"]');
  await expect(page.locator('.surface[data-surface="calendar"]')).toBeVisible();
  await step(page, 16);
  await putAway(page, "calendar");
  await step(page, 32);
  await expect(page.locator('.trail[data-tone="muted"]')).toHaveCount(1);
  await step(page, FLIGHT / 2);
  await shot(page, "3-away-flying");
  await step(page, FLIGHT / 2 + 32);
  const away = await ringBy(page, ".drawer-button");
  if (!away.ring || !away.box) throw new Error("no ring or no handle");
  expect(inside(away.ring, away.box), JSON.stringify(away)).toBe(true);
  await step(page, RING + 32);
  await expect(page.locator(".trail")).toHaveCount(0);

  await page.click(".drawer-button");
  await page.click('[data-key="raise-surface-calendar"]');
  await step(page, 32);
  await expect(page.locator('.trail[data-tone="muted"]')).toHaveCount(1);
  await step(page, FLIGHT / 2);
  await shot(page, "4-back-flying");
  await step(page, FLIGHT / 2 + 32);
  const back = await ringBy(page, '.surface[data-surface="calendar"]');
  if (!back.ring || !back.box) throw new Error("no ring or no window");
  expect(inside(back.ring, back.box), JSON.stringify(back)).toBe(true);
});

test("with reduced motion nothing moves and a still ring marks the arrival", async ({ page }) => {
  await openShell(page, "?lang=en&reduced=1");
  await seed(page);
  await tell(page, "summarise this");
  const seen: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    await step(page, 64);
    seen.push(
      ...(await page
        .locator(".trail-dot")
        .evaluateAll((dots) => dots.map((d) => getComputedStyle(d).opacity))),
    );
  }
  expect(new Set(seen)).toEqual(new Set(["0"]));
  const ring = page.locator(".trail-ring");
  const transform = await ring.evaluate((el) => (el as HTMLElement).style.transform);
  expect(transform).toMatch(/scale\(1(\.0+)?\)$/);
  await step(page, RING);
  await expect(page.locator(".trail")).toHaveCount(0);
});
