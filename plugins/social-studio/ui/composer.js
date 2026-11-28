// The Drafts view: the drafts (the last changed first), the open one (title where an account takes
// one, text, pictures with alt text, the accounts to publish to, writing help) and one preview per
// chosen account: the count against its limit, its pictures, what keeps it out and how it answered.
// A field is built once and a list only when its members change, so typing keeps its caret.
import { kindOf } from "./fit.js";
import { firstLines } from "./model.js";
import { drawReview, mediaText, problemText } from "./review.js";
import { el, mark } from "./rows.js";

/**
 * @typedef {ReturnType<import("./writer.js").createWriter>} Writer
 * @typedef {ReturnType<Writer["model"]>} Writing
 * @typedef {Writing["accounts"][number]} Choice
 * @typedef {{
 *   t(id: string, params?: Record<string, unknown>): string, when(at: string): string,
 *   number(value: number, unit: string): string, open(url: string): void,
 * }} Words
 */

/**
 * @param {Document} doc
 * @param {HTMLElement} box
 * @param {Words} w
 * @param {Writer["actions"]} act
 */
export function mountComposer(doc, box, w, act) {
  const button = (
    /** @type {string} */ cls,
    /** @type {string} */ text,
    /** @type {() => void} */ click,
  ) => {
    const b = /** @type {HTMLButtonElement} */ (el(doc, "button", `desk-btn ${cls}`, text));
    b.type = "button";
    b.onclick = click;
    return b;
  };
  const list = el(doc, "nav", "compose-drafts");
  const fresh = button("desk-btn-secondary compose-new", "", () => void act.create());
  const drafts = el(doc, "ul", "draft-list");
  list.append(fresh, drafts);
  const editor = el(doc, "div", "compose-editor");
  const none = el(doc, "div", "compose-none");
  const noneText = el(doc, "p");
  none.append(noneText);
  const title = /** @type {HTMLInputElement} */ (el(doc, "input", "desk-field compose-title"));
  title.oninput = () => act.edit({ title: title.value });
  const text = /** @type {HTMLTextAreaElement} */ (el(doc, "textarea", "desk-field compose-text"));
  text.rows = 8;
  text.oninput = () => act.edit({ text: text.value });
  const media = el(doc, "ul", "compose-media");
  const add = button("desk-btn-secondary compose-add", "", () => void act.addPictures());
  const accounts = el(doc, "fieldset", "compose-accounts");
  const legend = el(doc, "legend");
  const choices = el(doc, "div", "compose-choices");
  accounts.append(legend, choices);
  const helper = el(doc, "div", "compose-help");
  const publish = button("desk-btn-primary compose-publish", "", () => void act.review(true));
  const trash = button("desk-btn-quiet compose-trash", "", () => {
    const id = shown;
    if (id) void act.remove(id);
  });
  const actions = el(doc, "div", "compose-actions");
  actions.append(publish, trash);
  const error = el(doc, "p", "compose-error");
  error.setAttribute("role", "alert");
  editor.append(title, text, media, add, accounts, helper, actions, error);
  const previews = el(doc, "div", "compose-previews");
  box.replaceChildren(list, none, editor, previews);
  /** @type {string | null} */
  let shown = null;
  /** What each list was last built from. */
  const built = { drafts: "", media: "", accounts: "" };
  const once = (/** @type {keyof typeof built} */ part, /** @type {unknown} */ from) => {
    const sig = JSON.stringify(from);
    if (built[part] === sig) return false;
    built[part] = sig;
    return true;
  };

  function draftList(/** @type {Writing} */ m) {
    fresh.textContent = w.t("newDraft");
    list.setAttribute("aria-label", w.t("views.drafts"));
    // The open draft as typed, the others as last listed.
    const rows = m.drafts
      .map((listed) => (listed.id === m.current?.id ? m.current : listed))
      .map((d) => ({
        id: d.id,
        line: firstLines(d.text || d.title, 80) || w.t("untitled"),
        when: d.updated ? w.when(d.updated) : "",
        published: Object.values(d.outcome).filter((o) => o.state === "published").length,
      }));
    if (once("drafts", [rows, m.current?.id, w.t("untitled")]))
      drafts.replaceChildren(
        ...rows.map((r) => {
          const li = el(doc, "li");
          const b = button("desk-btn-quiet draft", "", () => void act.open(r.id));
          b.dataset.draft = r.id;
          b.setAttribute("aria-current", String(r.id === m.current?.id));
          const foot = [r.when, r.published ? w.t("publishedTo", { count: r.published }) : ""];
          b.append(
            el(doc, "span", "draft-line", r.line),
            el(doc, "span", "draft-foot", foot.filter(Boolean).join(" · ")),
          );
          li.append(b);
          return li;
        }),
      );
  }

  function pictures(/** @type {import("./drafts.js").Draft} */ draft) {
    if (once("media", [draft.id, draft.media.map((m) => m.file), w.t("alt")]))
      media.replaceChildren(
        ...draft.media.map((d) => {
          const li = el(doc, "li", "compose-medium");
          li.dataset.file = d.file;
          const alt = /** @type {HTMLInputElement} */ (el(doc, "input", "desk-field medium-alt"));
          alt.placeholder = alt.ariaLabel = w.t("alt");
          alt.oninput = () => act.medium(d.file, alt.value);
          const remove = button("desk-btn-quiet medium-remove", w.t("removeMedium"), () =>
            act.medium(d.file, null),
          );
          remove.ariaLabel = w.t("removeNamed", { name: d.file });
          const name = `${w.t(`media.${kindOf(d.type)}`)} · ${d.file}`;
          li.append(el(doc, "span", "medium-name", name), alt, remove);
          return li;
        }),
      );
    for (const li of media.children) {
      const alt = /** @type {HTMLInputElement} */ (li.querySelector(".medium-alt"));
      const d = draft.media.find((m) => m.file === /** @type {HTMLElement} */ (li).dataset.file);
      if (d && doc.activeElement !== alt && alt.value !== d.alt) alt.value = d.alt;
    }
  }

  function chooser(/** @type {Writing} */ m) {
    legend.textContent = w.t("publishTo");
    const keys = m.accounts.map((a) => [a.key, a.title, a.network.id]);
    if (once("accounts", keys))
      choices.replaceChildren(
        ...m.accounts.map((a) => {
          const label = el(doc, "label", "compose-account");
          const check = /** @type {HTMLInputElement} */ (el(doc, "input"));
          check.type = "checkbox";
          check.dataset.account = a.key;
          check.onchange = () => act.toggle(a.key);
          label.append(check, mark(doc, a.network), el(doc, "span", "", a.title));
          return label;
        }),
      );
    const chosen = new Set(m.accounts.filter((a) => a.chosen).map((a) => a.key));
    for (const check of choices.querySelectorAll("input[data-account]")) {
      const box = /** @type {HTMLInputElement} */ (check);
      box.checked = chosen.has(box.dataset.account ?? "");
    }
    if (m.accounts.length === 0)
      choices.replaceChildren(el(doc, "p", "", w.t("compose.noAccounts")));
  }

  function help(/** @type {Writing} */ m) {
    const chosen = m.accounts.filter((a) => a.chosen);
    const limits = chosen.flatMap((a) => (typeof a.fit.max === "number" ? [a.fit.max] : []));
    const tightest = limits.length > 0 ? Math.min(...limits) : undefined;
    const over = chosen.find((a) => a.fit.max === tightest);
    const network = (over ?? chosen[0])?.network.name;
    const parts = [];
    const asking = m.help?.state === "asking";
    if (network && m.current?.text.trim()) {
      if (tightest && over && over.fit.count > tightest) {
        const shorten = button(
          "desk-btn-quiet help-shorten",
          w.t("help.shorten", { max: tightest }),
          () => void act.help("shorten", network, tightest),
        );
        shorten.disabled = asking;
        parts.push(shorten);
      }
      const adapt = button(
        "desk-btn-quiet help-adapt",
        w.t("help.adapt", { network }),
        () => void act.help("adapt", network),
      );
      adapt.disabled = asking;
      parts.push(adapt);
    }
    if (m.help) {
      const answer = el(doc, "div", `help-answer help-${m.help.state}`);
      const said =
        m.help.state === "asking"
          ? w.t("help.asking")
          : m.help.state === "failed"
            ? w.t("help.failed", { why: m.help.text })
            : m.help.text;
      answer.append(el(doc, "p", "help-text", said));
      if (m.help.state === "ready")
        answer.append(
          button("desk-btn-secondary help-keep", w.t("help.keep"), () => act.keepHelp(true)),
        );
      if (!asking)
        answer.append(
          button("desk-btn-quiet help-discard", w.t("help.discard"), () => act.keepHelp(false)),
        );
      parts.push(answer);
    }
    helper.replaceChildren(...parts);
  }

  function edit(/** @type {Writing} */ m) {
    const draft = m.current;
    none.hidden = Boolean(draft);
    editor.hidden = !draft;
    noneText.textContent = w.t("compose.empty");
    if (!draft) {
      shown = null;
      return;
    }
    if (shown !== draft.id) {
      shown = draft.id;
      title.value = draft.title;
      text.value = draft.text;
    }
    if (doc.activeElement !== text && text.value !== draft.text) text.value = draft.text;
    if (doc.activeElement !== title && title.value !== draft.title) title.value = draft.title;
    title.hidden = !m.titled;
    title.placeholder = title.ariaLabel = w.t("compose.title");
    text.placeholder = text.ariaLabel = w.t("compose.text");
    add.textContent = w.t("addPictures");
    pictures(draft);
    chooser(m);
    help(m);
    publish.textContent = m.busy ? w.t("publishing") : w.t("publish");
    publish.disabled = m.busy || m.ready.length === 0;
    trash.textContent = w.t("deleteDraft");
    error.textContent = m.error;
  }

  function preview(/** @type {Choice} */ a, /** @type {Writing} */ m) {
    const card = el(doc, "section", "preview");
    card.dataset.account = a.key;
    const head = el(doc, "h3", "preview-title");
    head.append(mark(doc, a.network), el(doc, "span", "", a.title));
    const max = a.fit.max;
    const count =
      typeof max === "number"
        ? w.t("count.limit", { count: w.number(a.fit.count, "count"), max: w.number(max, "count") })
        : w.t("count.free", { count: a.fit.count });
    const over = typeof max === "number" && a.fit.count > max;
    card.append(head, el(doc, "p", `preview-count${over ? " is-over" : ""}`, count));
    const pictured = mediaText(w, m.current?.media ?? []);
    if (pictured) card.append(el(doc, "p", "preview-media", pictured));
    const problems = problemText(w, a);
    if (a.fit.unknown) problems.push(w.t("fit.unknown", { network: a.network.name }));
    if (problems.length > 0) {
      const ul = el(doc, "ul", "preview-problems");
      ul.append(...problems.map((p) => el(doc, "li", "", p)));
      card.append(ul);
    }
    const o = a.outcome;
    if (!o) return card;
    const line = el(doc, "div", `outcome outcome-${o.state}`);
    line.dataset.state = o.state;
    if (o.state === "published") {
      line.append(el(doc, "span", "", w.t("outcome.published")));
      const url = o.url;
      if (url)
        line.append(
          button("desk-btn-quiet", w.t("openOn", { network: a.network.name }), () => w.open(url)),
        );
    } else {
      const said =
        o.state === "unknown" ? w.t("outcome.unknown", { network: a.network.name }) : o.why;
      line.append(el(doc, "span", "", said));
      const retry = button(
        "desk-btn-secondary outcome-retry",
        w.t("tryAgain"),
        () => void act.publish([a.key]),
      );
      retry.disabled = m.busy || a.fit.problems.length > 0;
      line.append(retry);
    }
    card.append(line);
    return card;
  }

  /** @param {Writing} m @param {HTMLElement} overlay */
  function draw(m, overlay) {
    draftList(m);
    edit(m);
    const chosen = m.accounts.filter((a) => a.chosen);
    previews.hidden = !m.current || chosen.length === 0;
    previews.setAttribute("aria-label", w.t("previews"));
    previews.replaceChildren(...(m.current ? chosen.map((a) => preview(a, m)) : []));
    drawReview(doc, overlay, w, m, act);
  }
  return { draw, focus: () => (shown ? text : fresh).focus() };
}
