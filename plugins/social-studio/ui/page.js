// The studio's page: the views (Feed, Replies, Numbers, Drafts), the accounts by network, the
// filters, a windowed list of posts with the open one beside it (with Reply and Delete), each
// account's numbers and the composer. It draws the models studio.js and writer.js hand it and says
// what the person did through `deps`; it reads no data itself.
import { mountComposer } from "./composer.js";
import { el, mark, postDetail, postRow, ROW } from "./rows.js";
import { mountTalk } from "./talk.js";
import { createWindow } from "./window.js";

/**
 * @typedef {import("./studio.js").Model} Model
 * @typedef {import("./rows.js").Words} Words
 * @typedef {Words & {
 *   number(value: number, unit: string): string,
 *   setView(view: string): void,
 *   setFilter(filter: { network?: string | null, account?: string | null, text?: string }): void,
 *   select(key: string | null): void,
 *   connect(): void,
 *   writing(): import("./composer.js").Writing,
 *   write: import("./composer.js").Writer["actions"],
 * } & Omit<import("./talk.js").Deps, "t">} Deps
 */

const VIEWS = ["feed", "replies", "numbers", "drafts"];

/** A line through a series' points, scaled to its own range; flat when it does not move. */
function spark(
  /** @type {Document} */ doc,
  /** @type {{ t: string, v: number }[]} */ points,
  hue = 1,
) {
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 100 24");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("class", "spark");
  svg.setAttribute("aria-hidden", "true");
  if (points.length < 2) return svg;
  const values = points.map((p) => p.v);
  const [low, high] = [Math.min(...values), Math.max(...values)];
  const y = (/** @type {number} */ v) => (high === low ? 12 : 22 - ((v - low) / (high - low)) * 20);
  const line = doc.createElementNS("http://www.w3.org/2000/svg", "polyline");
  line.setAttribute(
    "points",
    values
      .map((v, i) => `${((i / (values.length - 1)) * 100).toFixed(2)},${y(v).toFixed(2)}`)
      .join(" "),
  );
  line.setAttribute("style", `stroke: var(--desk-chart-${hue})`);
  svg.append(line);
  return svg;
}

/** @param {Document} doc @param {Deps} deps */
export function mountPage(doc, deps) {
  const get = (/** @type {string} */ id) => /** @type {HTMLElement} */ (doc.getElementById(id));
  const t = deps.t;
  /** @type {Model | undefined} */
  let model;
  const list = createWindow(get("list"), {
    height: ROW,
    draw: (/** @type {{ post: import("./model.js").Post, seen?: boolean }} */ row) =>
      postRow(doc, deps, {
        post: row.post,
        selected: row.post.key === model?.selected?.key,
        unseen: row.seen === false,
        ...(row.post.kind === "mention" ? { note: t("mention") } : {}),
      }),
  });

  get("list").addEventListener("click", (e) => {
    const row = /** @type {HTMLElement | null} */ (
      /** @type {Element} */ (e.target).closest(".row")
    );
    if (row?.dataset.key) deps.select(row.dataset.key);
  });
  get("list").addEventListener("keydown", (e) => {
    if (!model || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
    const rows = rowsOf(model);
    const at = rows.findIndex((r) => r.post.key === model?.selected?.key);
    const next = Math.max(0, Math.min(rows.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)));
    if (rows[next]) {
      e.preventDefault();
      deps.select(rows[next].post.key);
      list.reveal(next);
      /** @type {HTMLElement | null} */ (
        get("list").querySelector('[aria-selected="true"]')
      )?.focus();
    }
  });
  doc.addEventListener("keydown", (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    if (e.metaKey || e.ctrlKey || e.altKey || target.closest?.("input, textarea, select")) return;
    if (!get("review").hidden) return;
    if (e.key === "Escape" && model?.selected) return deps.select(null);
    const view = VIEWS[Number(e.key) - 1];
    if (view) {
      e.preventDefault();
      deps.setView(view);
    }
  });
  get("search").addEventListener("input", (e) =>
    deps.setFilter({ text: /** @type {HTMLInputElement} */ (e.target).value }),
  );
  get("network").addEventListener("change", (e) =>
    deps.setFilter({ network: /** @type {HTMLSelectElement} */ (e.target).value || null }),
  );
  get("connect").onclick = () => deps.connect();
  const composer = mountComposer(doc, get("compose"), deps, deps.write);
  const talk = mountTalk(doc, deps);

  const rowsOf = (/** @type {Model} */ m) =>
    m.view === "feed" ? m.feed.map((post) => ({ post })) : m.view === "replies" ? m.replies : [];

  function views(/** @type {Model} */ m) {
    const tabs = VIEWS.map((view, i) => {
      const tab = el(doc, "button", "desk-tab", t(`views.${view}`));
      tab.type = "button";
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(m.view === view));
      tab.setAttribute("aria-keyshortcuts", String(i + 1));
      tab.onclick = () => deps.setView(view);
      if (view === "replies" && m.unseen > 0)
        tab.append(el(doc, "span", "badge", String(m.unseen)));
      return tab;
    });
    get("views").setAttribute("aria-label", t("views.label"));
    get("views").replaceChildren(...tabs);
  }

  function accounts(/** @type {Model} */ m) {
    const heading = el(doc, "h2", "aside-title", t("accounts"));
    const all = el(doc, "button", "account desk-btn desk-btn-quiet", t("allAccounts"));
    all.type = "button";
    all.setAttribute("aria-pressed", String(!m.filter.account && !m.filter.network));
    all.onclick = () => deps.setFilter({ network: null, account: null });
    const groups = m.groups.map((g) => {
      const group = el(doc, "section", "network");
      const title = el(doc, "h3", "network-title");
      title.append(mark(doc, g.network), el(doc, "span", "", g.network.name));
      group.append(title);
      for (const a of g.accounts) {
        const b = el(doc, "button", "account desk-btn desk-btn-quiet");
        b.type = "button";
        b.dataset.account = a.key;
        b.setAttribute("aria-pressed", String(m.filter.account === a.key));
        b.onclick = () => deps.setFilter({ network: a.network.id, account: a.key });
        const state = a.reauth ? t("reconnect") : (a.sentence ?? t(`state.${a.state}`));
        b.append(
          el(doc, "span", "account-title", a.title),
          el(doc, "span", `account-state state-${a.state}`, state),
        );
        group.append(b);
      }
      return group;
    });
    get("accounts").replaceChildren(heading, all, ...groups);
  }

  function filters(/** @type {Model} */ m) {
    const select = /** @type {HTMLSelectElement} */ (get("network"));
    const any = el(doc, "option", "", t("allNetworks"));
    /** @type {HTMLOptionElement} */ (any).value = "";
    const options = m.networks.map((n) => {
      const o = /** @type {HTMLOptionElement} */ (el(doc, "option", "", n.name));
      o.value = n.id;
      return o;
    });
    select.replaceChildren(any, ...options);
    select.value = m.filter.network ?? "";
    select.setAttribute("aria-label", t("allNetworks"));
    const search = /** @type {HTMLInputElement} */ (get("search"));
    search.placeholder = search.ariaLabel = t("search");
    if (search.value !== m.filter.text) search.value = m.filter.text;
  }

  function numbers(/** @type {Model} */ m) {
    const cards = m.numbers.map(({ account, series, best }) => {
      const card = el(doc, "section", "card");
      const title = el(doc, "h2", "card-title");
      title.append(mark(doc, account.network), el(doc, "span", "", account.title));
      card.append(title);
      if (series.length === 0) card.append(el(doc, "p", "card-empty", t("empty.numbers")));
      for (const s of series) {
        const latest = s.points[s.points.length - 1];
        const line = el(doc, "div", "series");
        line.dataset.metric = s.metric;
        const value = latest
          ? t("latest", { value: deps.number(latest.v, s.unit), at: deps.when(latest.t) })
          : "";
        line.append(
          el(
            doc,
            "span",
            "series-name",
            t(`series.${s.metric}`) === `series.${s.metric}` ? s.metric : t(`series.${s.metric}`),
          ),
          el(doc, "span", "series-value", value),
          spark(doc, s.points, account.network.hue),
        );
        card.append(line);
      }
      if (best.length > 0) {
        card.append(el(doc, "h3", "card-sub", t("best")));
        const ol = el(doc, "ol", "best");
        for (const post of best) {
          const li = el(doc, "li");
          li.append(postRow(doc, deps, { post, selected: false }));
          ol.append(li);
        }
        ol.onclick = (e) => {
          const row = /** @type {HTMLElement | null} */ (
            /** @type {Element} */ (e.target).closest(".row")
          );
          if (!row?.dataset.key) return;
          deps.setView("feed");
          deps.select(row.dataset.key);
        };
        card.append(ol);
      }
      return card;
    });
    get("numbers").replaceChildren(...cards);
  }

  /** What the status line and the empty pane say. */
  function words(/** @type {Model} */ m, /** @type {number} */ rows) {
    const status =
      m.state === "reading"
        ? t("reading")
        : m.state === "denied"
          ? t("notAllowed")
          : m.state === "failed"
            ? t("failed", { why: m.why })
            : "";
    get("status").textContent = status;
    const none = m.state === "ready" && !m.connected;
    const empty = none
      ? t("none")
      : m.state !== "ready" || rows > 0
        ? ""
        : m.filtered
          ? t("noMatch")
          : t(`empty.${m.view}`);
    get("empty").hidden = empty === "";
    get("empty-text").textContent = empty;
    get("connect").hidden = !none;
    get("connect").textContent = t("connect");
  }

  /** The open post's detail; Reply and Delete stay below it, built once. */
  function detail(/** @type {Model} */ next, /** @type {boolean} */ listed) {
    const box = get("detail");
    const open = listed ? next.selected : undefined;
    get("main").classList.toggle("has-detail", Boolean(open));
    box.hidden = !open;
    talk.draw(open);
    if (!open) return box.replaceChildren();
    const article = postDetail(doc, deps, {
      post: open,
      ...(next.answers ? { answers: next.answers } : {}),
      close: () => deps.select(null),
    });
    const shown = box.firstElementChild;
    if (shown && shown !== talk.box) shown.replaceWith(article);
    else box.prepend(article);
    if (talk.box.parentElement !== box) box.append(talk.box);
  }

  function draw(/** @type {Model} */ next) {
    model = next;
    doc.title = get("title").textContent = t("title");
    views(next);
    const drafting = next.view === "drafts";
    get("studio").classList.toggle("is-drafting", drafting);
    for (const id of ["accounts", "filters", "pane"]) get(id).hidden = drafting;
    get("compose").hidden = !drafting;
    if (drafting) {
      get("empty").hidden = true;
      get("connect").hidden = true;
      get("status").textContent = "";
      composer.draw(deps.writing(), get("review"));
      return;
    }
    const review = get("review");
    if (!review.hidden) {
      review.hidden = true;
      review.replaceChildren();
      delete review.dataset.shows;
    }
    accounts(next);
    filters(next);
    const rows = rowsOf(next);
    const listed = next.view !== "numbers";
    get("list").hidden = !listed;
    get("list").setAttribute("aria-label", t(`views.${next.view}`));
    get("numbers").hidden = listed;
    if (listed) list.set(rows);
    else numbers(next);
    detail(next, listed);
    words(next, listed ? rows.length : next.numbers.length);
  }

  return {
    draw,
    focus(/** @type {string} */ where) {
      if (where === "compose") return composer.focus();
      /** @type {HTMLElement | null} */ (get(where)?.querySelector("button"))?.focus();
    },
    /** How many rows the list has in the page now. */
    drawn: () => list.drawn(),
  };
}
