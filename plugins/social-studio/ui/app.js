// Social Studio put together: the page over the document, the studio (reading) and the writer
// (drafts, publishing, replies) over the SDK context, and the words between them (the plugin's
// catalogs, dates and numbers in the desk's language). main.js mounts it in the desk; the tests
// mount it on the SDK's test host over jsdom.
import { answerWriters } from "./agent-write.js";
import { mountPage } from "./page.js";
import { createStudio } from "./studio.js";
import { createWriter } from "./writer.js";

/**
 * @param {import("@endue-ai/plugin-sdk").PluginContext} ctx
 * @param {Document} doc
 * @param {{ zone?: string }} [options]
 */
export async function mountStudio(ctx, doc, options = {}) {
  await ctx.messages.ready;
  const zone = options.zone ? { timeZone: options.zone } : {};
  /** @type {ReturnType<typeof createStudio> | undefined} */
  let studio;
  const act = () => {
    if (!studio) throw new Error("Social Studio is not mounted yet.");
    return studio.actions;
  };
  const t = (/** @type {string} */ id, /** @type {Record<string, unknown>} */ params = {}) =>
    ctx.messages.t(id, /** @type {never} */ (params));
  const snapshot = () => studio?.snapshot() ?? { items: [], accounts: [], posts: [] };
  const writer = createWriter(ctx, {
    snapshot,
    redraw: () => studio?.redraw(),
    t,
    language: () => ctx.messages.language(),
  });
  const page = mountPage(doc, {
    t,
    when: (at) => {
      const date = new Date(at);
      return Number.isNaN(date.getTime())
        ? at
        : new Intl.DateTimeFormat(ctx.messages.language(), {
            dateStyle: "medium",
            timeStyle: "short",
            ...zone,
          }).format(date);
    },
    number: (value, unit) => {
      const language = ctx.messages.language();
      if (unit === "ratio")
        return new Intl.NumberFormat(language, {
          style: "percent",
          maximumFractionDigits: 1,
        }).format(value);
      const n = new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(value);
      return unit === "seconds" ? `${n} s` : n;
    },
    open: (url) => act().open(url),
    setView: (view) => act().setView(view),
    setFilter: (filter) => act().setFilter(filter),
    select: (key) => act().select(key),
    connect: () => act().connect(),
    writing: () => writer.model(),
    write: writer.actions,
    postActions: (post) => writer.postActions(post),
    reply: (post, text) => writer.actions.reply(post, text),
    deletePost: (post) => writer.actions.deletePost(post),
  });
  studio = createStudio(ctx, page, {
    reason: (what) => ctx.messages.t(`grant.${what}`),
    entered: (view) => {
      if (view === "drafts") void writer.actions.refresh();
    },
  });
  answerWriters((name, handler) => ctx.commands.on(name, handler), {
    writer,
    posts: () => snapshot().posts,
    known: (key) => snapshot().accounts.some((a) => a.key === key),
  });
  doc.defaultView?.addEventListener("pagehide", () => void writer.actions.flush().catch(() => {}));
  const words = () => {
    doc.documentElement.lang = ctx.messages.language();
    studio?.redraw();
  };
  ctx.messages.onChange(words);
  doc.documentElement.lang = ctx.messages.language();
  await studio.start();
  return { studio, page, writer };
}
