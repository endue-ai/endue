// Social Studio put together: the page over the document, the studio over the SDK context, and
// the words between them (the plugin's catalogs, dates and numbers in the desk's language). main.js
// mounts it in the desk; the tests mount it on the SDK's test host over jsdom.
import { mountPage } from "./page.js";
import { createStudio } from "./studio.js";

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
  const page = mountPage(doc, {
    t: (id, params) => ctx.messages.t(id, /** @type {never} */ (params)),
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
  });
  studio = createStudio(ctx, page);
  const words = () => {
    doc.documentElement.lang = ctx.messages.language();
    studio?.redraw();
  };
  ctx.messages.onChange(words);
  doc.documentElement.lang = ctx.messages.language();
  await studio.start();
  return { studio, page };
}
