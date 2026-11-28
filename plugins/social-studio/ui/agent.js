// What an agent reads through Social Studio (ADR 0088): the accounts with their status and what
// each can do, the posts, the replies and mentions, and an account's numbers, as data from the
// desk's index, leaving the screen as it is; and `show`, which opens one post. A post is named by
// `{ source, id }` and an account by `{ source }`, as the answers carry them.
import { accountKey, accountsOf, bestOf, feedOf, itemKey, repliesOf, seriesOf } from "./model.js";

/**
 * @typedef {import("@endue-ai/bridge").Item} Item
 * @typedef {import("./model.js").Post} Post
 */

/** How many posts one answer holds by default and at most, and how long a text may be. */
export const POSTS = { usual: 20, most: 100 };
export const TEXT_MAX = 4000;
const POINTS_MAX = 90;

const limitOf = (/** @type {unknown} */ value) => {
  const asked = Number(value);
  return Number.isInteger(asked) && asked > 0 ? Math.min(asked, POSTS.most) : POSTS.usual;
};
const asString = (/** @type {unknown} */ v) => (typeof v === "string" && v ? v : undefined);
const asSource = (/** @type {unknown} */ v) => {
  const s = /** @type {{ connector?: unknown, instance?: unknown }} */ (v);
  return typeof s?.connector === "string" && typeof s?.instance === "string"
    ? { connector: s.connector, instance: s.instance }
    : undefined;
};

/** A post as an agent reads it. */
export function postAnswer(/** @type {Post} */ p) {
  return {
    source: p.source,
    id: p.id,
    network: p.network.id,
    kind: p.kind,
    self: p.self,
    author: p.author,
    handle: p.handle,
    at: p.at,
    text: p.text.length > TEXT_MAX ? `${p.text.slice(0, TEXT_MAX)}…` : p.text,
    ...(p.url ? { url: p.url } : {}),
    ...(p.replyTo ? { replyTo: p.replyTo } : {}),
    counts: p.counts,
    media: p.media.map((m) => m.kind),
  };
}

/**
 * @param {(name: string, handler: (args: unknown) => unknown) => unknown} answer
 * @param {{ posts(): Post[], items(): Item[], instances(): import("./model.js").Instance[],
 *   seen(): Set<string>, show(key: string): void }} deps
 */
export function answerAgents(answer, deps) {
  const args = (/** @type {unknown} */ a) => /** @type {Record<string, unknown>} */ (a ?? {});
  const page = (/** @type {Post[]} */ list, /** @type {unknown} */ limit) => {
    const n = limitOf(limit);
    return { list: list.slice(0, n), more: list.length > n };
  };
  const named = (/** @type {Record<string, unknown>} */ a, /** @type {string} */ what) => {
    const source = asSource(a.source);
    const id = asString(a.id);
    if (!source || !id) throw new Error(`Name the ${what}: { source, id }, as posts answers.`);
    return itemKey(source, id);
  };
  const filterOf = (/** @type {Record<string, unknown>} */ a) => {
    const source = asSource(a.source);
    return {
      network: asString(a.network)?.toLowerCase() ?? null,
      account: source ? accountKey(source) : null,
      text: asString(a.query) ?? "",
    };
  };

  answer("endue.social-studio.accounts", () => {
    const items = deps.items();
    const records = new Map(
      items.filter((i) => i.kind === "record").map((i) => [accountKey(i.source), i]),
    );
    return {
      accounts: accountsOf(deps.instances(), items).flatMap((g) =>
        g.accounts.map((a) => {
          const fields = /** @type {{ fields?: Record<string, unknown> }} */ (records.get(a.key))
            ?.fields;
          const account = /** @type {Record<string, unknown> | undefined} */ (fields?.account);
          return {
            source: a.source,
            title: a.title,
            network: a.network.id,
            state: a.state,
            ...(a.sentence ? { sentence: a.sentence } : {}),
            reauth: a.reauth,
            ...(typeof account?.handle === "string" ? { handle: account.handle } : {}),
            ...(typeof account?.followers === "number" ? { followers: account.followers } : {}),
            ...(fields?.capabilities ? { capabilities: fields.capabilities } : {}),
          };
        }),
      ),
    };
  });

  answer("endue.social-studio.posts", (raw) => {
    const a = args(raw);
    const { list, more } = page(feedOf(deps.posts(), filterOf(a)), a.limit);
    return { posts: list.map(postAnswer), more };
  });

  answer("endue.social-studio.replies", (raw) => {
    const a = args(raw);
    const to = a.id !== undefined || a.source !== undefined ? named(a, "post") : undefined;
    const seen = deps.seen();
    const all = repliesOf(deps.posts(), seen, to ? {} : filterOf(a)).filter(
      (r) =>
        !to ||
        r.answers?.key === to ||
        (r.post.replyTo && itemKey(r.post.source, r.post.replyTo) === to),
    );
    const n = limitOf(a.limit);
    return {
      replies: all.slice(0, n).map((r) => ({ ...postAnswer(r.post), seen: r.seen })),
      unseen: all.filter((r) => !r.seen).length,
      more: all.length > n,
    };
  });

  answer("endue.social-studio.numbers", (raw) => {
    const source = asSource(args(raw).source);
    if (!source) throw new Error("Name the account: { source }, as accounts answers.");
    const key = accountKey(source);
    return {
      series: seriesOf(deps.items(), key).map((s) => ({
        metric: s.metric,
        unit: s.unit,
        ...(s.points.length > 0 ? { latest: s.points[s.points.length - 1] } : {}),
        points: s.points.slice(-POINTS_MAX),
      })),
      best: bestOf(deps.posts(), key).map(postAnswer),
    };
  });

  answer("endue.social-studio.show", (raw) => {
    deps.show(named(args(raw), "post"));
    return { shown: true };
  });
}
