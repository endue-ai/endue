// What a post looks like: a row of a list (network mark, who and when, the first lines, what the
// network counts) and the detail beside the list (the whole text, media, counts, the post it
// answers and the way to it on its network). Every text a network gave is set as textContent, and
// media show as their kind and alt text: the page loads nothing from a network.
import { countsOf, firstLines } from "./model.js";

/**
 * @typedef {import("./model.js").Post} Post
 * @typedef {import("./model.js").Network} Network
 * @typedef {{
 *   t(id: string, params?: Record<string, unknown>): string,
 *   when(at: string): string,
 *   open(url: string): void,
 * }} Words
 */

/** One row's height, which the windowed list scrolls by. */
export const ROW = 76;

/** An element with a class and a text. */
export function el(
  /** @type {Document} */ doc,
  /** @type {string} */ tag,
  /** @type {string} */ className = "",
  /** @type {string | undefined} */ text = undefined,
) {
  const e = doc.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** A network's mark: its letters on its chart colour. */
export function mark(/** @type {Document} */ doc, /** @type {Network} */ network) {
  const m = el(doc, "span", "mark", network.mark);
  m.style.setProperty("--mark", `var(--desk-chart-${network.hue})`);
  m.title = network.name;
  m.setAttribute("aria-hidden", "true");
  return m;
}

/** What a post's counts say, in words, those the network gives. */
export const countsText = (/** @type {Words} */ w, /** @type {Post} */ p) =>
  countsOf(p)
    .map((c) => w.t(`count.${c.name}`, { count: c.value }))
    .join(" · ");

const mediaText = (/** @type {Words} */ w, /** @type {Post} */ p) =>
  p.media.map((m) =>
    w.t(`media.${["image", "video", "link"].includes(m.kind) ? m.kind : "other"}`),
  );

/**
 * One row: the post's network, its author and account, when, its first lines, and its counts.
 * @param {Document} doc
 * @param {Words} w
 * @param {{ post: Post, selected: boolean, unseen?: boolean, note?: string }} row
 */
export function postRow(doc, w, { post: p, selected, unseen = false, note }) {
  const row = el(doc, "button", "row desk-btn desk-btn-quiet");
  row.type = "button";
  row.setAttribute("role", "option");
  row.setAttribute("aria-selected", String(selected));
  row.dataset.key = p.key;
  row.tabIndex = selected ? 0 : -1;
  const head = el(doc, "span", "row-head");
  const who = el(doc, "span", "row-who", p.author || p.accountName);
  const where = el(
    doc,
    "span",
    "row-where",
    `${p.handle ? `@${p.handle} · ` : ""}${p.accountName}`,
  );
  const at = el(doc, "time", "row-at", w.when(p.at));
  at.dateTime = p.at;
  head.append(mark(doc, p.network), who, where, at);
  if (unseen) head.append(el(doc, "span", "row-unseen", w.t("unseen")));
  const body = el(doc, "span", "row-text", firstLines(p.text) || note || "");
  const foot = [note, countsText(w, p), ...mediaText(w, p)].filter(Boolean).join(" · ");
  row.append(head, body, el(doc, "span", "row-foot", foot));
  return row;
}

/** A medium: its kind and alt text. */
function medium(
  /** @type {Document} */ doc,
  /** @type {Words} */ w,
  /** @type {Post["media"][number]} */ m,
) {
  const kind = w.t(`media.${["image", "video", "link"].includes(m.kind) ? m.kind : "other"}`);
  return el(doc, "span", "medium", m.alt ? w.t("media.alt", { kind, alt: m.alt }) : kind);
}

/**
 * The detail of a post: its network and account, the whole text, media, counts, the post it
 * answers, and the way to it on its network (https only).
 * @param {Document} doc
 * @param {Words} w
 * @param {{ post: Post, answers?: Post, close(): void }} detail
 */
export function postDetail(doc, w, { post: p, answers, close }) {
  const box = el(doc, "article", "detail-post");
  box.setAttribute("aria-label", w.t("post", { author: p.author || p.accountName }));
  const head = el(doc, "header", "detail-head");
  const title = el(doc, "h2", "detail-title", p.author || p.accountName);
  const shut = el(doc, "button", "desk-btn desk-btn-quiet detail-close", w.t("close"));
  shut.type = "button";
  shut.onclick = close;
  head.append(mark(doc, p.network), title, shut);
  const where = `${p.handle ? `@${p.handle} · ` : ""}${p.accountName} · ${w.when(p.at)}`;
  box.append(head, el(doc, "p", "detail-where", where));
  if (answers)
    box.append(
      el(doc, "p", "detail-answers", w.t("replyingTo", { text: firstLines(answers.text, 140) })),
    );
  else if (p.kind === "mention") box.append(el(doc, "p", "detail-answers", w.t("mention")));
  if (p.title && p.title !== p.text.split("\n")[0])
    box.append(el(doc, "h3", "detail-heading", p.title));
  box.append(el(doc, "p", "detail-text", p.text));
  if (p.truncated) box.append(el(doc, "p", "detail-note", w.t("truncated")));
  if (p.media.length > 0) {
    const media = el(doc, "div", "detail-media");
    media.append(...p.media.map((m) => medium(doc, w, m)));
    box.append(media);
  }
  const counts = countsText(w, p);
  if (counts) box.append(el(doc, "p", "detail-counts", counts));
  if (p.url) {
    const url = p.url;
    const link = el(
      doc,
      "button",
      "desk-btn desk-btn-secondary",
      w.t("openOn", { network: p.network.name }),
    );
    link.type = "button";
    link.onclick = () => w.open(url);
    box.append(link);
  }
  return box;
}
