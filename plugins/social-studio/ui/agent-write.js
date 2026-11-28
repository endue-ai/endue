// What an agent writes through Social Studio (ADR 0088): a draft it makes (`draft`), the drafts and
// the open one as data (`drafts`, `current`), and `publish`, `reply` and `delete`, which plugin.json
// marks agent and irreversible, so they run only after the person approves a card showing their
// args. `publish` names the text, title and pictures it sends and refuses when the draft no longer
// says them, so the card shows exactly what goes out.
import { TEXT_MAX } from "./agent.js";
import { accountKey, itemKey } from "./model.js";

/**
 * @typedef {import("./drafts.js").Draft} Draft
 * @typedef {import("./model.js").Post} Post
 * @typedef {ReturnType<import("./writer.js").createWriter>} Writer
 */

const asString = (/** @type {unknown} */ v) => (typeof v === "string" ? v : undefined);
const sourceOf = (/** @type {unknown} */ v) => {
  const s = /** @type {{ connector?: unknown, instance?: unknown }} */ (v);
  return typeof s?.connector === "string" && typeof s?.instance === "string"
    ? { connector: s.connector, instance: s.instance }
    : undefined;
};
const sourceOfKey = (/** @type {string} */ key) => {
  const at = key.indexOf("/");
  return { connector: key.slice(0, at), instance: key.slice(at + 1) };
};
const mediaOf = (/** @type {unknown} */ v) =>
  (Array.isArray(v) ? v : []).map((m) => ({
    file: asString(m?.file) ?? "",
    alt: asString(m?.alt) ?? "",
  }));

/** A draft as an agent reads it. */
export function draftAnswer(/** @type {Draft} */ d) {
  return {
    draft: d.id,
    text: d.text.length > TEXT_MAX ? `${d.text.slice(0, TEXT_MAX)}…` : d.text,
    title: d.title,
    accounts: d.accounts.map(sourceOfKey),
    media: d.media.map((m) => ({ file: m.file, alt: m.alt, type: m.type, size: m.size })),
    outcome: Object.entries(d.outcome).map(([key, o]) => ({ source: sourceOfKey(key), ...o })),
    updated: d.updated,
  };
}

/**
 * @param {(name: string, handler: (args: unknown) => unknown) => unknown} answer
 * @param {{ writer: Writer, posts(): Post[], known(key: string): boolean }} deps
 */
export function answerWriters(answer, { writer, posts, known }) {
  const args = (/** @type {unknown} */ a) => /** @type {Record<string, unknown>} */ (a ?? {});
  const keysOf = (/** @type {unknown} */ list) =>
    (Array.isArray(list) ? list : []).map((s) => {
      const source = sourceOf(s);
      if (!source || !known(accountKey(source)))
        throw new Error("Name each account { connector, instance } as accounts answers it.");
      return accountKey(source);
    });
  /** The draft by id, the open one when it is open (with what was typed last). */
  const draftOf = async (/** @type {unknown} */ id) => {
    if (typeof id !== "string" || !id) throw new Error("Name the draft as drafts answers it.");
    await writer.actions.flush();
    if (writer.state.current?.id === id) return writer.state.current;
    return writer.store.read(id).catch(() => {
      throw new Error(`No draft ${id}: drafts lists them.`);
    });
  };
  const postOf = (/** @type {Record<string, unknown>} */ a) => {
    const source = sourceOf(a.source);
    const id = asString(a.id);
    const key = source && id ? itemKey(source, id) : "";
    const post = posts().find((p) => p.key === key);
    if (!post)
      throw new Error("No such post in the index: name it { source, id } as posts answers.");
    return post;
  };

  answer("endue.social-studio.draft", async (raw) => {
    const a = args(raw);
    const text = asString(a.text);
    if (text === undefined) throw new Error("A draft needs its text.");
    const draft = writer.store.create({
      text,
      title: asString(a.title) ?? "",
      accounts: keysOf(a.accounts),
    });
    await writer.store.save(draft);
    for (const m of Array.isArray(a.media) ? a.media : []) {
      const path = asString(m?.path);
      if (!path) continue;
      const medium = await writer.store.addMedium(draft, path).catch((e) => {
        throw e?.code === "unsupported_type"
          ? new Error(`${e.message} is not a picture or a video.`)
          : e;
      });
      medium.alt = asString(m?.alt) ?? "";
    }
    await writer.store.save(draft);
    await writer.actions.refresh();
    return draftAnswer(draft);
  });

  answer("endue.social-studio.drafts", async () => ({
    drafts: (await writer.store.list()).map(draftAnswer),
  }));
  answer("endue.social-studio.current", () => {
    const d = writer.state.current;
    return { draft: d ? draftAnswer(d) : null };
  });

  answer("endue.social-studio.publish", async (raw) => {
    const a = args(raw);
    const draft = await draftOf(a.draft);
    const media = draft.media.map((m) => ({ file: m.file, alt: m.alt }));
    const same =
      asString(a.text) === draft.text &&
      (asString(a.title) ?? "") === draft.title &&
      JSON.stringify(mediaOf(a.media)) === JSON.stringify(media);
    if (!same)
      throw new Error(
        "The draft no longer says what this would publish: read it with drafts and ask again.",
      );
    const keys = keysOf(a.accounts);
    if (keys.length === 0) throw new Error("Name the accounts to publish to.");
    const choices = writer.choices(draft);
    const ready = [];
    /** @type {Record<string, unknown>[]} */
    const results = [];
    for (const key of keys) {
      const c = choices.find((x) => x.key === key);
      const problem = c?.fit.problems[0];
      if (problem) results.push({ source: sourceOfKey(key), state: "refused", why: problem.id });
      else ready.push(key);
    }
    if (ready.length > 0)
      for (const r of await writer.publishTo(draft, ready)) {
        const { account, ...outcome } = r;
        results.push({ source: sourceOfKey(account), ...outcome });
      }
    await writer.actions.refresh();
    return { results };
  });

  answer("endue.social-studio.reply", async (raw) => {
    const a = args(raw);
    const post = postOf(a);
    const text = asString(a.text)?.trim();
    if (!text) throw new Error("A reply needs its text.");
    if (!writer.postActions(post).reply)
      throw new Error(`${post.network.name} does not take replies from here.`);
    const answer = /** @type {any} */ (await writer.actions.reply(post, text));
    return { replied: true, ...(typeof answer?.id === "string" ? { id: answer.id } : {}) };
  });

  answer("endue.social-studio.delete", async (raw) => {
    const post = postOf(args(raw));
    if (!writer.postActions(post).delete)
      throw new Error(`${post.network.name} does not let this post be deleted from here.`);
    await writer.actions.deletePost(post);
    return { deleted: true };
  });
}
