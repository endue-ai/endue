// The review before anything goes out: every account Publish goes to with exactly the text, title
// and pictures it receives, the chosen accounts left out and why, and one button. Nothing is
// invoked before that button. Drawn again only when what it shows changes, so its focus holds.
import { kindOf, typeOf } from "./fit.js";
import { el, mark } from "./rows.js";

/**
 * @typedef {import("./composer.js").Words} Words
 * @typedef {import("./composer.js").Writing} Writing
 * @typedef {import("./composer.js").Choice} Choice
 * @typedef {import("./composer.js").Writer} Writer
 */

/** One sentence per problem, in the account's network's name. */
export const problemText = (/** @type {Words} */ w, /** @type {Choice} */ a) =>
  a.fit.problems.map((p) => w.t(p.id, { network: a.network.name, ...(p.params ?? {}) }));

/** What a post says about its pictures: "2 pictures · 1 video". */
export function mediaText(/** @type {Words} */ w, /** @type {{ type: string }[]} */ media) {
  return /** @type {const} */ (["image", "video"])
    .map((kind) => ({ kind, count: media.filter((m) => kindOf(m.type) === kind).length }))
    .filter((k) => k.count > 0)
    .map((k) => w.t(`mediaCount.${k.kind}`, { count: k.count }))
    .join(" · ");
}

const button = (
  /** @type {Document} */ doc,
  /** @type {string} */ cls,
  /** @type {string} */ text,
  /** @type {() => void} */ click,
) => {
  const b = /** @type {HTMLButtonElement} */ (el(doc, "button", `desk-btn ${cls}`, text));
  b.type = "button";
  b.onclick = click;
  return b;
};

/** One account as the review names it: what it receives, word for word. */
function received(/** @type {Document} */ doc, /** @type {Words} */ w, /** @type {Choice} */ a) {
  const li = el(doc, "li", "review-account");
  li.dataset.account = a.key;
  const head = el(doc, "h3", "review-name");
  head.append(mark(doc, a.network), el(doc, "span", "", a.title));
  li.append(head);
  if (a.post.title) li.append(el(doc, "p", "review-heading", a.post.title));
  if (a.post.text) li.append(el(doc, "p", "review-text", a.post.text));
  const media = a.post.media ?? [];
  if (media.length > 0) {
    const ul = el(doc, "ul", "review-media");
    for (const m of media) {
      const file = m.path.split("/").pop() ?? m.path;
      const alt = m.alt ? w.t("review.alt", { alt: m.alt }) : w.t("review.noAlt");
      ul.append(el(doc, "li", "", `${w.t(`media.${kindOf(typeOf(file))}`)} · ${file} · ${alt}`));
    }
    li.append(ul);
  }
  return li;
}

/**
 * @param {Document} doc
 * @param {HTMLElement} overlay
 * @param {Words} w
 * @param {Writing} m
 * @param {Writer["actions"]} act
 */
export function drawReview(doc, overlay, w, m, act) {
  if (!m.review || !m.current) {
    if (overlay.hidden) return;
    overlay.hidden = true;
    overlay.replaceChildren();
    delete overlay.dataset.shows;
    /** @type {HTMLElement | null} */ (doc.querySelector(".compose-publish"))?.focus();
    return;
  }
  const draft = m.current;
  const shows = JSON.stringify([
    m.ready.map((a) => [a.key, a.post]),
    draft.media,
    m.may,
    m.busy,
    w.t("review.final"),
  ]);
  if (overlay.dataset.shows === shows) return;
  // Opening, or drawn again with the focus in it: the focus goes to the button it is for.
  const focus =
    overlay.hidden || overlay.contains(doc.activeElement) || doc.activeElement === doc.body;
  overlay.dataset.shows = shows;
  overlay.hidden = false;
  const box = el(doc, "div", "review");
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-labelledby", "review-title");
  const title = el(doc, "h2", "review-title", w.t("review.title", { count: m.ready.length }));
  title.id = "review-title";
  const list = el(doc, "ul", "review-accounts");
  list.append(...m.ready.map((a) => received(doc, w, a)));
  box.append(title, list);
  const ready = new Set(m.ready.map((a) => a.key));
  const left = m.accounts.filter(
    (a) => a.chosen && !ready.has(a.key) && a.outcome?.state !== "published",
  );
  if (left.length > 0) {
    const ul = el(doc, "ul", "review-left");
    ul.append(
      ...left.map((a) =>
        el(doc, "li", "", w.t("review.leftOut", { account: a.title, why: problemText(w, a)[0] })),
      ),
    );
    box.append(ul);
  }
  if (m.may && !m.may.includes("publish"))
    box.append(el(doc, "p", "review-key", w.t("review.key")));
  box.append(el(doc, "p", "review-final", w.t("review.final")));
  const cancel = button(doc, "desk-btn-quiet review-cancel", w.t("cancel"), () =>
    act.review(false),
  );
  const publish = button(
    doc,
    "desk-btn-primary review-publish",
    w.t("review.publish", { count: m.ready.length }),
    () => void act.publish(),
  );
  publish.disabled = m.busy;
  const actions = el(doc, "div", "review-actions");
  actions.append(cancel, publish);
  box.append(actions);
  box.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      act.review(false);
    } else if (e.key === "Tab") {
      const edge = e.shiftKey ? cancel : publish;
      if (doc.activeElement === edge) {
        e.preventDefault();
        (e.shiftKey ? publish : cancel).focus();
      }
    }
  });
  overlay.replaceChildren(box);
  if (focus) publish.focus();
}
