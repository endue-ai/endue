// The social items of the index as the studio reads them (specs/connector/v0 README, Social
// profile): a post, a reply or a mention is an `entry` whose `raw.network` is set, an account's
// numbers are `metric` items and the account itself a `record`. A network is a name and one of the
// theme's chart colours, never a logo. Pure functions, so the tests run them in Node.

/**
 * @typedef {import("@endue-ai/bridge").Item} Item
 * @typedef {import("@endue-ai/bridge").ItemSource} ItemSource
 * @typedef {{ id: string, name: string, mark: string, hue: number }} Network
 * @typedef {{ kind: string, url?: string, alt?: string }} Media
 * @typedef {{
 *   key: string, source: ItemSource, id: string, network: Network, account: string,
 *   accountName: string, destination?: string, kind: string, self: boolean, replyTo?: string,
 *   handle: string, author: string, avatar?: string, title: string, text: string, url?: string,
 *   at: string, media: Media[], counts: Record<string, number>, truncated: boolean,
 * }} Post
 * @typedef {{ metric: string, unit: string, points: { t: string, v: number }[] }} Series
 */

/** The networks the studio names; any other id is shown by its own name. */
export const NETWORKS = /** @type {Network[]} */ ([
  { id: "instagram", name: "Instagram", mark: "Ig", hue: 6 },
  { id: "threads", name: "Threads", mark: "Th", hue: 8 },
  { id: "x", name: "X", mark: "X", hue: 1 },
  { id: "facebook", name: "Facebook", mark: "Fb", hue: 5 },
  { id: "reddit", name: "Reddit", mark: "Rd", hue: 3 },
  { id: "linkedin", name: "LinkedIn", mark: "In", hue: 2 },
  { id: "youtube", name: "YouTube", mark: "Yt", hue: 4 },
  { id: "tiktok", name: "TikTok", mark: "Tt", hue: 7 },
  { id: "bluesky", name: "Bluesky", mark: "Bs", hue: 9 },
  { id: "mastodon", name: "Mastodon", mark: "Ma", hue: 10 },
]);
const BY_ID = new Map(NETWORKS.map((n) => [n.id, n]));

/** A stable 1 to 10 for any text, so a network keeps its colour across restarts and desks. */
export function hueOf(/** @type {string} */ text) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  return (hash % 10) + 1;
}

/** The network an id names: one the studio knows, else the id itself with a stable colour. */
export function networkOf(/** @type {string} */ id) {
  const known = BY_ID.get(id.toLowerCase());
  if (known) return known;
  const name = id.charAt(0).toUpperCase() + id.slice(1);
  return { id, name, mark: name.slice(0, 2), hue: hueOf(id) };
}

const COUNTS = ["likes", "replies", "reposts", "views"];
const text = (/** @type {unknown} */ v) => (typeof v === "string" ? v : "");
const https = (/** @type {unknown} */ v) =>
  typeof v === "string" && v.startsWith("https://") ? v : undefined;

/** Whether an item is a social one: its raw names a network. */
export const isSocial = (/** @type {Item} */ item) =>
  typeof (/** @type {{ raw?: { network?: unknown } }} */ (item).raw?.network) === "string";

/** The key of an account: its source. */
export const accountKey = (/** @type {ItemSource} */ s) => `${s.connector}/${s.instance}`;
/** The key of an item. */
export const itemKey = (/** @type {ItemSource} */ s, /** @type {string} */ id) =>
  `${accountKey(s)}/${id}`;

/** A social entry as the studio draws it; none for any other item. */
export function postOf(/** @type {Item} */ item) {
  if (item.kind !== "entry" || !isSocial(item)) return undefined;
  const raw = /** @type {Record<string, unknown>} */ (item.raw);
  /** @type {Record<string, number>} */
  const counts = {};
  for (const name of COUNTS) if (typeof raw[name] === "number") counts[name] = Number(raw[name]);
  const media = Array.isArray(raw.media) ? raw.media : [];
  const body = text(item.body) || text(item.title);
  return /** @type {Post} */ ({
    key: itemKey(item.source, item.id),
    source: item.source,
    id: item.id,
    network: networkOf(text(raw.network)),
    account: accountKey(item.source),
    accountName: text(item.feed) || item.source.instance,
    ...(typeof raw.destination === "string" ? { destination: raw.destination } : {}),
    kind: text(raw.postKind) || "post",
    self: raw.self === true,
    ...(typeof raw.replyTo === "string" ? { replyTo: raw.replyTo } : {}),
    handle: text(raw.handle),
    author: text(raw.authorName) || text(raw.handle),
    ...(https(raw.avatar) ? { avatar: https(raw.avatar) } : {}),
    title: text(item.title),
    text: body,
    ...(https(item.url) ? { url: https(item.url) } : {}),
    at: text(item.publishedAt) || item.updatedAt,
    media: media.map((m) => ({
      kind: text(m?.kind) || "other",
      ...(https(m?.url) ? { url: https(m.url) } : {}),
      ...(typeof m?.alt === "string" ? { alt: m.alt } : {}),
    })),
    counts,
    truncated: raw.truncated === true,
  });
}

const newest = (/** @type {Post} */ a, /** @type {Post} */ b) =>
  a.at < b.at ? 1 : a.at > b.at ? -1 : a.key.localeCompare(b.key);

/**
 * @typedef {{ network?: string | null, account?: string | null, text?: string }} Filter
 */
const passes = (/** @type {Post} */ p, /** @type {Filter} */ f) =>
  (!f.network || p.network.id === f.network) &&
  (!f.account || p.account === f.account) &&
  (!f.text || `${p.text} ${p.handle} ${p.author}`.toLowerCase().includes(f.text.toLowerCase()));

/** The accounts' own posts, newest first, under the filter. */
export function feedOf(/** @type {Post[]} */ posts, /** @type {Filter} */ filter = {}) {
  return posts.filter((p) => p.self && p.kind === "post" && passes(p, filter)).sort(newest);
}

/**
 * Replies and mentions to the accounts, the unseen first, each with the post it answers when the
 * index holds it.
 */
export function repliesOf(
  /** @type {Post[]} */ posts,
  /** @type {Set<string>} */ seen,
  /** @type {Filter} */ filter = {},
) {
  const byId = new Map(posts.map((p) => [`${p.account}/${p.id}`, p]));
  return posts
    .filter((p) => !p.self && (p.kind === "reply" || p.kind === "mention") && passes(p, filter))
    .map((p) => ({
      post: p,
      seen: seen.has(p.key),
      answers: p.replyTo ? byId.get(`${p.account}/${p.replyTo}`) : undefined,
    }))
    .sort((a, b) => Number(a.seen) - Number(b.seen) || newest(a.post, b.post));
}

/** An account's series by metric, from its `metric` items. */
export function seriesOf(/** @type {Item[]} */ items, /** @type {string} */ account) {
  return items
    .filter((i) => i.kind === "metric" && isSocial(i) && accountKey(i.source) === account)
    .map((i) => {
      const m = /** @type {{ series: string, unit?: string, points: Series["points"] }} */ (
        /** @type {unknown} */ (i)
      );
      return { metric: m.series, unit: m.unit ?? "count", points: [...m.points] };
    })
    .sort((a, b) => a.metric.localeCompare(b.metric));
}

/** The account's posts that did best: most likes, then replies; a post without counts is not ranked. */
export function bestOf(/** @type {Post[]} */ posts, /** @type {string} */ account, n = 5) {
  const score = (/** @type {Post} */ p) => [p.counts.likes ?? -1, p.counts.replies ?? -1];
  return posts
    .filter((p) => p.account === account && p.self && Object.keys(p.counts).length > 0)
    .sort((a, b) => {
      const [x, y] = [score(a), score(b)];
      return y[0] - x[0] || y[1] - x[1] || newest(a, b);
    })
    .slice(0, n);
}

/**
 * @typedef {{
 *   key: string, source: ItemSource, title: string, network: Network,
 *   state: string, sentence?: string, reauth: boolean,
 * }} Account
 * @typedef {{ connector: string, instance: string, title?: string,
 *   status: { state: string, error?: { message: string, reauth?: boolean } } }} Instance
 */

/**
 * The social accounts by network: every instance of a connector that brings social items, its
 * network read from what it brought (the account record first), its status as a sentence.
 */
export function accountsOf(/** @type {Instance[]} */ instances, /** @type {Item[]} */ items) {
  /** @type {Map<string, string>} */
  const networks = new Map();
  for (const item of items) {
    if (!isSocial(item)) continue;
    const key = accountKey(item.source);
    const network = /** @type {{ network: string }} */ (item.raw).network;
    if (item.kind === "record" || !networks.has(key)) networks.set(key, network);
  }
  /** @type {Account[]} */
  const accounts = instances.map((i) => {
    const source = { connector: i.connector, instance: i.instance };
    const key = accountKey(source);
    const sentence = i.status.error?.message;
    return {
      key,
      source,
      title: i.title ?? i.instance,
      network: networkOf(networks.get(key) ?? "other"),
      state: i.status.state,
      ...(sentence ? { sentence } : {}),
      reauth: i.status.error?.reauth === true,
    };
  });
  /** @type {Map<string, { network: Network, accounts: Account[] }>} */
  const groups = new Map();
  for (const a of accounts.sort((x, y) => x.title.localeCompare(y.title))) {
    const group = groups.get(a.network.id) ?? { network: a.network, accounts: [] };
    group.accounts.push(a);
    groups.set(a.network.id, group);
  }
  return [...groups.values()].sort((a, b) => a.network.name.localeCompare(b.network.name));
}

/** What a post's counts say, in order, only those the network gives. */
export const countsOf = (/** @type {Post} */ p) =>
  COUNTS.filter((name) => name in p.counts).map((name) => ({ name, value: p.counts[name] }));

/** The first lines of a text, at most `max` characters. */
export function firstLines(/** @type {string} */ value, max = 280) {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
