// The studio's writing side without its DOM: the drafts, the one open, the review, publishing to
// each chosen account (`<connector>.post.publish`, the pictures as files the core uploads), replying
// and deleting, and the key's permission to publish (account.connectors.*). page.js and composer.js
// draw what model() says; agent-write.js answers agents with the same steps.
import { createDrafts, READ, WRITE } from "./drafts.js";
import { capabilitiesOf, fitOf, postFor, takesTitle } from "./fit.js";
import { createHelp } from "./help.js";

/**
 * @typedef {import("./drafts.js").Draft} Draft
 * @typedef {import("./drafts.js").Outcome} Outcome
 * @typedef {import("./model.js").Account} Account
 * @typedef {import("./model.js").Post} Post
 * @typedef {{ items: import("@endue-ai/bridge").Item[], accounts: Account[] }} Snapshot
 * @typedef {"read" | "accounts" | "drafts" | "write" | "account" | "help"} Why
 */

const ACCOUNT = Object.freeze({ permission: "account:manage" });
const PICK = [
  { name: "Pictures and videos", extensions: ["jpg", "jpeg", "png", "webp", "gif", "mp4", "mov"] },
];
const SAVE_MS = 300;
/** Errors after which the post may be up: the answer was lost on the way. */
const LOST = ["timeout", "io_error", "unavailable", "cancelled"];
const codeOf = (/** @type {unknown} */ e) =>
  String(/** @type {{ code?: unknown }} */ (e)?.code ?? "");
const messageOf = (/** @type {unknown} */ e) => (e instanceof Error ? e.message : String(e));
const https = (/** @type {unknown} */ v) =>
  typeof v === "string" && v.startsWith("https://") ? v : undefined;

/**
 * @param {import("@endue-ai/plugin-sdk").PluginContext} ctx
 * @param {{
 *   snapshot(): Snapshot, redraw(): void, t(id: string, params?: Record<string, unknown>): string,
 *   language(): string,
 * }} deps
 */
export function createWriter(ctx, deps) {
  const help = createHelp(ctx);
  const w = {
    /** @type {Draft[]} */ drafts: [],
    /** @type {Draft | null} */ current: null,
    review: false,
    busy: false,
    error: "",
    /** @type {{ what: string, network: string, state: "asking" | "ready" | "failed", text: string } | null} */
    help: null,
  };
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;

  /** `call`, and once more after asking the person for `scope` with the reason for `why`. */
  const granted = async (
    /** @type {() => Promise<any>} */ call,
    /** @type {Record<string, unknown>} */ scope,
    /** @type {Why} */ why,
  ) => {
    try {
      return await call();
    } catch (error) {
      if (codeOf(error) !== "permission_denied") throw error;
      const answer = await ctx.bridge
        .call(
          "perm.request",
          /** @type {never} */ ({ permission: scope, reason: deps.t(`grant.${why}`) }),
        )
        .catch(() => ({ granted: false }));
      if (!answer.granted) throw error;
      return call();
    }
  };
  const fs = {
    call: (/** @type {string} */ method, /** @type {Record<string, unknown>} */ params) =>
      granted(
        () => ctx.bridge.call(/** @type {never} */ (method), /** @type {never} */ (params)),
        /** @type {any} */ (params).scope === READ ? READ : WRITE,
        /** @type {any} */ (params).scope === READ ? "drafts" : "write",
      ),
  };
  const store = createDrafts(fs);

  const flush = async () => {
    clearTimeout(timer);
    timer = undefined;
    if (w.current) await store.save(w.current);
  };
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void flush().catch(fail), SAVE_MS);
  };
  const fail = (/** @type {unknown} */ e) => {
    w.error = deps.t("writeFailed", { why: messageOf(e) });
    deps.redraw();
  };

  /** The accounts as the composer shows them, each with how the open draft fits it. */
  function accountsOf(/** @type {Draft} */ draft) {
    const { items, accounts } = deps.snapshot();
    return accounts.map((a) => {
      const caps = capabilitiesOf(items, a.key);
      return {
        ...a,
        caps,
        chosen: draft.accounts.includes(a.key),
        fit: fitOf(caps, draft, a),
        post: postFor(caps, draft, (f) => store.pathOf(draft, f), false),
        outcome: draft.outcome[a.key],
      };
    });
  }

  /** The chosen accounts Publish goes to: they take the post and have not published it. */
  const readyOf = (/** @type {Draft} */ draft) =>
    accountsOf(draft).filter(
      (a) => a.chosen && a.fit.problems.length === 0 && a.outcome?.state !== "published",
    );

  /** The key may `power` (publish, delete), widened once with the person's click if not. */
  async function mayDo(/** @type {"publish" | "delete"} */ power) {
    const status = await granted(
      () => ctx.bridge.call("account.connectors.status", { scope: ACCOUNT }),
      ACCOUNT,
      "account",
    );
    if (status.may?.includes(power)) return;
    const after = await ctx.bridge.call("account.connectors.enable", {
      scope: ACCOUNT,
      allow: [power],
    });
    if (!after.may?.includes(power)) throw new Error(after.problem || deps.t("keyRefused"));
  }

  /** Publish the draft to each account by key, one after another; each answers on its own. */
  async function publishTo(/** @type {Draft} */ draft, /** @type {string[]} */ keys) {
    await mayDo("publish");
    const keep =
      (await ctx.settings.get("endue.social-studio.keep-location").catch(() => false)) === true;
    const { items, accounts } = deps.snapshot();
    for (const key of keys) {
      const account = accounts.find((a) => a.key === key);
      if (!account || draft.outcome[key]?.state === "published") continue;
      const caps = capabilitiesOf(items, key);
      const post = postFor(caps, draft, (f) => store.pathOf(draft, f), keep);
      /** @type {Outcome} */
      let outcome;
      try {
        const answer = /** @type {any} */ (
          await ctx.commands.run(`${account.source.connector}.post.publish`, {
            instance: account.source.instance,
            ...post,
          })
        );
        outcome = {
          state: "published",
          ...(typeof answer?.id === "string" ? { id: answer.id } : {}),
          ...(https(answer?.url) ? { url: https(answer.url) } : {}),
        };
      } catch (e) {
        outcome = { state: LOST.includes(codeOf(e)) ? "unknown" : "failed", why: messageOf(e) };
      }
      draft.outcome[key] = outcome;
      await store.save(draft).catch(fail);
      deps.redraw();
    }
    return keys.map((key) => ({ account: key, ...draft.outcome[key] }));
  }

  const actions = {
    async refresh() {
      w.drafts = await store.list().catch((e) => (fail(e), w.drafts));
      deps.redraw();
    },
    async create(/** @type {Partial<Draft>} */ init = {}) {
      await flush().catch(fail);
      const draft = store.create(init);
      await store.save(draft);
      w.current = draft;
      w.help = null;
      await actions.refresh();
      return draft;
    },
    async open(/** @type {string} */ id) {
      await flush().catch(fail);
      w.current = await store.read(id);
      w.review = false;
      w.help = null;
      deps.redraw();
    },
    /** @param {{ text?: string, title?: string }} change */
    edit(change) {
      if (!w.current) return;
      Object.assign(w.current, change);
      later();
      deps.redraw();
    },
    async addPictures() {
      const draft = w.current;
      if (!draft) return;
      const picked = await ctx.bridge.call("dialog.open", {
        kind: "files",
        multiple: true,
        title: deps.t("addPictures"),
        filters: PICK,
      });
      if (picked.cancelled) return;
      for (const path of picked.paths) {
        await store
          .addMedium(draft, path)
          .catch((e) =>
            fail(codeOf(e) === "unsupported_type" ? deps.t("fit.type", { name: messageOf(e) }) : e),
          );
      }
      await flush().catch(fail);
      deps.redraw();
    },
    /** @param {string} file @param {string | null} alt null removes the picture */
    medium(file, alt) {
      if (!w.current) return;
      if (alt === null) w.current.media = w.current.media.filter((m) => m.file !== file);
      else for (const m of w.current.media) if (m.file === file) m.alt = alt;
      later();
      deps.redraw();
    },
    toggle(/** @type {string} */ key) {
      if (!w.current) return;
      const on = w.current.accounts.includes(key);
      w.current.accounts = on
        ? w.current.accounts.filter((k) => k !== key)
        : [...w.current.accounts, key];
      later();
      deps.redraw();
    },
    review(/** @type {boolean} */ open) {
      w.review = open && Boolean(w.current) && readyOf(/** @type {Draft} */ (w.current)).length > 0;
      deps.redraw();
    },
    async publish(/** @type {string[] | undefined} */ only) {
      const draft = w.current;
      if (!draft || w.busy) return;
      const keys = only ?? readyOf(draft).map((a) => a.key);
      w.review = false;
      w.busy = true;
      w.error = "";
      deps.redraw();
      try {
        await flush();
        await publishTo(draft, keys);
      } catch (e) {
        fail(e);
      } finally {
        w.busy = false;
        await actions.refresh();
      }
    },
    async remove(/** @type {string} */ id) {
      clearTimeout(timer);
      await store.remove(id).catch(fail);
      if (w.current?.id === id) w.current = null;
      await actions.refresh();
    },
    async help(
      /** @type {"shorten" | "adapt"} */ what,
      /** @type {string} */ network,
      /** @type {number | undefined} */ limit,
    ) {
      const draft = w.current;
      if (!draft) return;
      w.help = { what, network, state: "asking", text: "" };
      deps.redraw();
      try {
        const job = {
          what,
          text: draft.text,
          network,
          language: deps.language(),
          ...(limit ? { limit } : {}),
        };
        const text = await granted(() => help.ask(job), { permission: "brain:ask" }, "help");
        w.help = { what, network, state: "ready", text };
      } catch (e) {
        w.help = { what, network, state: "failed", text: messageOf(e) };
      }
      deps.redraw();
    },
    keepHelp(/** @type {boolean} */ keep) {
      if (keep && w.help?.state === "ready") actions.edit({ text: w.help.text });
      w.help = null;
      deps.redraw();
    },
    /** @param {Post} post @param {string} text */
    async reply(post, text) {
      await mayDo("publish");
      return ctx.commands.run(`${post.source.connector}.post.reply`, {
        instance: post.source.instance,
        id: post.id,
        text,
      });
    },
    /** @param {Post} post */
    async deletePost(post) {
      await mayDo("delete");
      return ctx.commands.run(`${post.source.connector}.post.delete`, {
        instance: post.source.instance,
        id: post.id,
      });
    },
    flush,
  };

  /** What the account's record lets the person do with a post open in the detail. */
  function postActions(/** @type {Post} */ post) {
    const caps = capabilitiesOf(deps.snapshot().items, post.account);
    const remove = post.kind === "post" ? caps?.delete_post : caps?.delete_comment;
    return { reply: caps?.reply === true, delete: post.self && remove === true };
  }

  function model() {
    const draft = w.current;
    const accounts = draft ? accountsOf(draft) : [];
    return {
      drafts: w.drafts,
      current: draft,
      accounts,
      titled: accounts.some((a) => a.chosen && takesTitle(a.caps)),
      ready: draft ? readyOf(draft) : [],
      review: w.review,
      busy: w.busy,
      error: w.error,
      help: w.help,
    };
  }

  return { actions, model, postActions, publishTo, store, state: w };
}
