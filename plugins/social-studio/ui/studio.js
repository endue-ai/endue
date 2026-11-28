// Social Studio without its DOM: the social items of the desk's index (posts, replies and mentions
// as entries, numbers as metrics, accounts as records), the accounts from connector.list, the view
// the person picked and the post open. It reads ctx.data, ctx.bridge, ctx.commands
// and ctx.surface, and hands a page a model to draw, so the SDK's test host runs it.
import { answerAgents } from "./agent.js";
import {
  accountKey,
  accountsOf,
  bestOf,
  feedOf,
  isSocial,
  itemKey,
  postOf,
  repliesOf,
  seriesOf,
} from "./model.js";

/**
 * @typedef {import("@endue-ai/plugin-sdk").PluginContext} PluginContext
 * @typedef {import("@endue-ai/bridge").Item} Item
 * @typedef {import("./model.js").Post} Post
 * @typedef {{ draw(model: Model): void, focus(where: string): void }} Page
 * @typedef {ReturnType<typeof modelOf>} Model
 * @typedef {{
 *   view: string, filter: { network: string | null, account: string | null, text: string },
 *   selected: string | null, items: Map<string, Item>, instances: import("./model.js").Instance[],
 *   seen: Set<string>, sorted: Set<string>, state: "reading" | "ready" | "failed" | "denied",
 *   why: string,
 * }} State
 */

export const VIEWS = ["feed", "replies", "numbers", "drafts"];
/** What the studio reads: every social entry, metric and record. */
export const QUERY = /** @type {import("@endue-ai/bridge").ItemQuery} */ ({
  kinds: ["entry", "metric", "record"],
  where: [{ field: "raw.network", op: "exists" }],
  limit: 500,
});
/** Pages read at start: 5,000 items at most. */
export const PAGES = 10;
const SEEN_MAX = 5000;
const LINKS = { permission: "shell:open", schemes: ["https"] };
const CONNECTORS = { permission: "connector:manage" };
const READ = { permission: "data:read", kinds: QUERY.kinds };

const codeOf = (/** @type {unknown} */ e) =>
  String(/** @type {{ code?: unknown }} */ (e)?.code ?? (e instanceof Error ? e.message : e));

/**
 * @param {Pick<PluginContext, "bridge" | "commands" | "data" | "surface">} ctx
 * @param {Page} page
 * @param {{ reason(what: "read" | "accounts"): string, entered?(view: string): void }} words why
 *   the studio asks for a grant, and whom to tell when a view opens
 */
export function createStudio(ctx, page, words) {
  /** @type {State} */
  const s = {
    view: "feed",
    filter: { network: null, account: null, text: "" },
    selected: null,
    items: new Map(),
    instances: [],
    seen: new Set(),
    // The seen replies when Replies last opened: the list keeps that order, so a reply the person
    // reads stays where it is until they come back to the view.
    sorted: new Set(),
    state: "reading",
    why: "",
  };
  /** @type {Post[] | undefined} */
  let posts;
  const allPosts = () => {
    posts ??= [...s.items.values()].flatMap((i) => postOf(i) ?? []);
    return posts;
  };
  const changed = () => {
    posts = undefined;
  };

  const draw = () => page.draw(modelOf(s, allPosts()));

  const set = (/** @type {Item} */ item) => {
    if (isSocial(item)) s.items.set(itemKey(item.source, item.id), item);
  };
  const store = (/** @type {string} */ key, /** @type {unknown} */ value) =>
    void ctx.bridge.call("store.set", { key, value }).catch(() => {});

  const actions = {
    /** @param {string} view */
    setView(view) {
      if (!VIEWS.includes(view))
        throw new Error(`No view ${view}: feed, replies, numbers or drafts.`);
      s.view = view;
      s.selected = null;
      s.sorted = new Set(s.seen);
      draw();
      words.entered?.(view);
    },
    /** @param {Partial<typeof s.filter>} next */
    setFilter(next) {
      s.filter = { ...s.filter, ...next };
      if (next.network !== undefined && next.network !== null) {
        const account = s.instances.find((i) => accountKey(i) === s.filter.account);
        if (account && networkOfAccount(account) !== next.network) s.filter.account = null;
      }
      draw();
    },
    /** @param {string | null} key */
    select(key) {
      s.selected = key;
      if (key && !s.seen.has(key) && allPosts().some((p) => p.key === key && !p.self)) {
        s.seen.add(key);
        store("seen", [...s.seen].slice(-SEEN_MAX));
      }
      draw();
    },
    /** @param {string} url */
    open(url) {
      if (!url.startsWith("https://")) return;
      void ctx.bridge.call("shell.open", { target: url, scope: LINKS }).catch(() => {});
    },
    connect() {
      void ctx.commands.run("desk.connectors.open", { connector: "endue.social" }).catch(() => {});
    },
  };

  const networkOfAccount = (/** @type {{ connector: string, instance: string }} */ source) => {
    const key = accountKey(source);
    for (const item of s.items.values())
      if (accountKey(item.source) === key)
        return /** @type {{ network: string }} */ (item.raw).network;
    return undefined;
  };

  /**
   * `call`, and once more after asking the person for `permission` when the plugin does not hold
   * it yet: the desk asks them once, at first use.
   * @template T
   * @param {() => Promise<T>} call
   * @param {import("@endue-ai/bridge").Permission} permission
   * @param {"read" | "accounts"} what
   */
  const granted = async (call, permission, what) => {
    try {
      return await call();
    } catch (error) {
      if (codeOf(error) !== "permission_denied") throw error;
      const answer = await ctx.bridge
        .call("perm.request", { permission, reason: words.reason(what) })
        .catch(() => ({ granted: false }));
      if (!answer.granted) throw error;
      return call();
    }
  };

  /** The social accounts: instances of a connector that publishes posts or brought social items. */
  const readAccounts = async () => {
    const list = await granted(
      () => ctx.bridge.call("connector.list", { scope: CONNECTORS }),
      CONNECTORS,
      "accounts",
    ).catch(() => ({ connectors: [] }));
    const brought = new Set([...s.items.values()].map((i) => accountKey(i.source)));
    s.instances = list.connectors.flatMap((c) => {
      const posts = c.resources.some(
        (r) => r.kind === "entry" && (r.actions ?? []).some((a) => a.endsWith(".post.publish")),
      );
      return c.instances.filter((i) => posts || brought.has(accountKey(i)));
    });
  };

  /** Read the index, page by page, then hear what changes. */
  const load = async () => {
    let cursor;
    for (let page = 0; page < PAGES; page++) {
      const answer = await ctx.data.query(cursor ? { ...QUERY, cursor } : QUERY);
      for (const item of answer.items) set(item);
      cursor = answer.cursor;
      if (!cursor) break;
    }
    changed();
  };

  answerAgents((name, handler) => ctx.commands.on(name, handler), {
    posts: allPosts,
    items: () => [...s.items.values()],
    instances: () => s.instances,
    seen: () => s.seen,
    show: (key) => {
      const post = allPosts().find((p) => p.key === key);
      if (!post)
        throw new Error("No such post in the index: name it { source, id } as posts answers.");
      s.view = post.self ? "feed" : "replies";
      s.sorted = new Set(s.seen);
      s.filter = { network: null, account: null, text: "" };
      actions.select(key);
      ctx.surface.show();
      page.focus("detail");
    },
  });
  ctx.commands.on("endue.social-studio.view", (args) => {
    actions.setView(String(/** @type {{ view?: unknown }} */ (args)?.view ?? ""));
    return { view: s.view };
  });

  const start = async () => {
    draw();
    const seen = await ctx.bridge.call("store.get", { key: "seen" }).catch(() => ({}));
    const kept = /** @type {{ value?: unknown }} */ (seen).value;
    if (Array.isArray(kept)) for (const key of kept) if (typeof key === "string") s.seen.add(key);
    s.sorted = new Set(s.seen);
    try {
      await granted(load, READ, "read");
      await ctx.data.subscribe(QUERY, (changes) => {
        for (const c of changes) {
          if (c.change === "removed") s.items.delete(itemKey(c.source, c.id));
          else set(c.item);
        }
        changed();
        draw();
      });
      s.state = "ready";
    } catch (error) {
      s.state = codeOf(error) === "permission_denied" ? "denied" : "failed";
      s.why = codeOf(error);
    }
    await readAccounts();
    draw();
  };
  /** The items, the accounts and the posts as they are now, for the writing side. */
  const snapshot = () => {
    const items = [...s.items.values()];
    const accounts = accountsOf(s.instances, items).flatMap((g) => g.accounts);
    return { items, accounts, posts: allPosts() };
  };
  return { start, actions, redraw: draw, snapshot };
}

/** What the page draws, from the state and the posts. */
export function modelOf(/** @type {State} */ s, /** @type {Post[]} */ posts) {
  const items = [...s.items.values()];
  const groups = accountsOf(s.instances, items);
  const filter = s.filter;
  const feed = s.view === "feed" ? feedOf(posts, filter) : [];
  const replies =
    s.view === "replies"
      ? repliesOf(posts, s.sorted, filter).map((r) => ({ ...r, seen: s.seen.has(r.post.key) }))
      : [];
  const accounts = groups
    .flatMap((g) => g.accounts)
    .filter(
      (a) =>
        (!filter.network || a.network.id === filter.network) &&
        (!filter.account || a.key === filter.account),
    );
  const numbers =
    s.view === "numbers"
      ? accounts.map((a) => ({
          account: a,
          series: seriesOf(items, a.key),
          best: bestOf(posts, a.key),
        }))
      : [];
  const selected = s.selected ? posts.find((p) => p.key === s.selected) : undefined;
  const answers = selected?.replyTo
    ? posts.find((p) => p.account === selected.account && p.id === selected.replyTo)
    : undefined;
  return {
    view: s.view,
    state: s.state,
    why: s.why,
    filter,
    groups,
    networks: groups.map((g) => g.network),
    unseen: repliesOf(posts, s.seen).filter((r) => !r.seen).length,
    feed,
    replies,
    numbers,
    selected,
    answers,
    connected: s.instances.length > 0 || posts.length > 0,
    filtered: Boolean(filter.network || filter.account || filter.text),
  };
}
