// A windowed list: rows of one height in a scrolling box, and only those in view (and a few on
// either side) in the page, so 5,000 posts scroll as lightly as 50. A row is drawn by the caller;
// the list keeps the scroll offset across redraws and brings a selected row into view.

/** Rows drawn above and below the visible ones. */
export const OVERSCAN = 6;
/** Rows drawn when the box has no height yet (before layout, or in a test page). */
export const FALLBACK_ROWS = 24;

/**
 * @template T
 * @param {HTMLElement} box the scrolling element; its height is the window
 * @param {{ height: number, draw(item: T, index: number): HTMLElement }} options
 */
export function createWindow(box, { height, draw }) {
  const doc = box.ownerDocument;
  const spacer = doc.createElement("div");
  spacer.className = "window-spacer";
  const rows = doc.createElement("div");
  rows.className = "window-rows";
  rows.setAttribute("role", "presentation");
  spacer.append(rows);
  box.replaceChildren(spacer);
  /** @type {T[]} */
  let items = [];
  let frame = 0;

  const paint = () => {
    frame = 0;
    const seen = box.clientHeight > 0 ? Math.ceil(box.clientHeight / height) : FALLBACK_ROWS;
    const first = Math.max(0, Math.floor(box.scrollTop / height) - OVERSCAN);
    const last = Math.min(items.length, first + seen + OVERSCAN * 2);
    spacer.style.height = `${items.length * height}px`;
    rows.style.transform = `translateY(${first * height}px)`;
    rows.replaceChildren(...items.slice(first, last).map((item, i) => draw(item, first + i)));
  };
  const later = () => {
    if (frame === 0) frame = (doc.defaultView?.requestAnimationFrame ?? setTimeout)(paint);
  };
  box.addEventListener("scroll", later, { passive: true });

  return {
    /** Draw `next` from the current scroll offset. */
    set(/** @type {T[]} */ next) {
      items = next;
      paint();
    },
    /** Scroll so the row at `index` is in view, then draw. */
    reveal(/** @type {number} */ index) {
      const top = index * height;
      if (top < box.scrollTop) box.scrollTop = top;
      else if (top + height > box.scrollTop + box.clientHeight)
        box.scrollTop = top + height - box.clientHeight;
      paint();
    },
    /** How many rows are in the page now. */
    drawn: () => rows.childElementCount,
  };
}
