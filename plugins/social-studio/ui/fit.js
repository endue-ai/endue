// What each account makes of a draft: its record's capabilities (specs/connector/v0 README, Social
// profile) against the text, the title and the pictures, as the problems that keep it out of
// Publish, and the exact post it would receive. Pure functions, so the tests run them in Node.
import { accountKey, isSocial } from "./model.js";

/**
 * @typedef {import("@endue-ai/bridge").Item} Item
 * @typedef {{ max?: number, required?: boolean }} TextLimit
 * @typedef {{ max_count?: number, max_bytes?: number, types?: string[] } | false} MediaLimit
 * @typedef {{
 *   text?: TextLimit, title?: TextLimit | false, reply?: boolean, delete_post?: boolean,
 *   delete_comment?: boolean,
 *   media?: { image?: MediaLimit, video?: MediaLimit, required?: boolean } | false,
 * }} Capabilities
 * @typedef {{ file: string, alt: string, type: string, size: number }} Medium
 * @typedef {{ text: string, title: string, media: Medium[] }} Content
 * @typedef {{ id: string, params?: Record<string, unknown> }} Problem
 * @typedef {{ reauth: boolean }} Reachable
 */

/** The account's capabilities from its record; none before it synced one. */
export function capabilitiesOf(/** @type {Item[]} */ items, /** @type {string} */ key) {
  for (const item of items) {
    if (item.kind !== "record" || !isSocial(item) || accountKey(item.source) !== key) continue;
    const fields = /** @type {{ fields?: { capabilities?: unknown } }} */ (item).fields;
    const caps = fields?.capabilities;
    if (caps && typeof caps === "object") return /** @type {Capabilities} */ (caps);
  }
  return undefined;
}

/** Characters as people count them: code points, so an emoji is one. */
export const length = (/** @type {string} */ text) => [...text].length;
/** A medium's kind from its type. */
export const kindOf = (/** @type {string} */ type) =>
  type.startsWith("video/") ? "video" : "image";
const MB = 1024 * 1024;
export const megabytes = (/** @type {number} */ bytes) =>
  `${Math.round((bytes / MB) * 10) / 10} MB`;

/** The type of a picked file, by its extension; empty for one endue AI does not take. */
export function typeOf(/** @type {string} */ name) {
  const extension = name.toLowerCase().split(".").pop() ?? "";
  const types = /** @type {Record<string, string>} */ ({
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
    mp4: "video/mp4",
    m4v: "video/mp4",
    mov: "video/quicktime",
  });
  return types[extension] ?? "";
}

/** Whether the account takes a title. */
export const takesTitle = (/** @type {Capabilities | undefined} */ caps) =>
  Boolean(caps?.title && typeof caps.title === "object");

/**
 * How the draft fits one account: the text's count against its limit and every problem that keeps
 * the account out of Publish. An account without a record yet is `unknown`: the network checks it.
 * @param {Capabilities | undefined} caps
 * @param {Content} content
 * @param {Reachable} account
 */
export function fitOf(caps, content, account) {
  /** @type {Problem[]} */
  const problems = [];
  const count = length(content.text);
  const max = caps?.text?.max;
  if (account.reauth) problems.push({ id: "fit.reconnect" });
  if (!content.text.trim() && content.media.length === 0) problems.push({ id: "fit.empty" });
  if (!caps) return { count, max, problems, unknown: true };
  if (typeof max === "number" && count > max)
    problems.push({ id: "fit.tooLong", params: { over: count - max, max } });
  if (caps.text?.required && !content.text.trim()) problems.push({ id: "fit.textRequired" });
  if (caps.title && typeof caps.title === "object") {
    if (caps.title.required && !content.title.trim()) problems.push({ id: "fit.titleRequired" });
    if (caps.title.max && length(content.title) > caps.title.max)
      problems.push({ id: "fit.titleTooLong", params: { max: caps.title.max } });
  }
  const media = caps.media || {};
  if (media.required && content.media.length === 0) problems.push({ id: "fit.mediaRequired" });
  for (const kind of /** @type {const} */ (["image", "video"])) {
    const these = content.media.filter((m) => kindOf(m.type) === kind);
    if (these.length === 0) continue;
    const limit = media[kind];
    if (!limit) {
      problems.push({ id: `fit.no.${kind}` });
      continue;
    }
    if (limit.max_count && these.length > limit.max_count)
      problems.push({ id: `fit.count.${kind}`, params: { count: limit.max_count } });
    for (const m of these) {
      if (limit.types && !limit.types.includes(m.type))
        problems.push({ id: "fit.type", params: { name: m.file } });
      if (limit.max_bytes && m.size > limit.max_bytes)
        problems.push({
          id: "fit.size",
          params: { name: m.file, max: megabytes(limit.max_bytes) },
        });
    }
  }
  return { count, max, problems, unknown: false };
}

/**
 * What one account receives: the text, the title where it takes one, the pictures as files with
 * their alt text. `keepLocation` only when the person keeps where a picture was taken.
 * @param {Capabilities | undefined} caps
 * @param {Content} content
 * @param {(file: string) => string} pathOf
 * @param {boolean} keepLocation
 */
export function postFor(caps, content, pathOf, keepLocation) {
  return {
    ...(content.text ? { text: content.text } : {}),
    ...(takesTitle(caps) && content.title.trim() ? { title: content.title.trim() } : {}),
    ...(content.media.length > 0
      ? {
          media: content.media.map((m) => ({
            path: pathOf(m.file),
            ...(m.alt.trim() ? { alt: m.alt.trim() } : {}),
            ...(keepLocation ? { keepLocation: true } : {}),
          })),
        }
      : {}),
  };
}
