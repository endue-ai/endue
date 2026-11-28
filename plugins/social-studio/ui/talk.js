// Under a post's detail: Reply, where the account's network takes replies, and Delete, on the
// account's own post where the network lets it, asking once and naming the post. Built once and
// shown or hidden, so a reply being written keeps its caret while the list changes around it.
import { firstLines } from "./model.js";
import { el } from "./rows.js";
import { wordsOf } from "./writer.js";

/**
 * @typedef {import("./model.js").Post} Post
 * @typedef {{
 *   t(id: string, params?: Record<string, unknown>): string,
 *   postActions(post: Post): { reply: boolean, delete: boolean },
 *   reply(post: Post, text: string): Promise<unknown>,
 *   deletePost(post: Post): Promise<unknown>,
 * }} Deps
 */

/** @param {Document} doc @param {Deps} deps */
export function mountTalk(doc, deps) {
  const t = deps.t;
  const button = (/** @type {string} */ cls, /** @type {() => void} */ click) => {
    const b = /** @type {HTMLButtonElement} */ (el(doc, "button", `desk-btn ${cls}`));
    b.type = "button";
    b.onclick = click;
    return b;
  };
  const box = el(doc, "div", "talk");
  const bar = el(doc, "div", "talk-bar");
  const reply = button("desk-btn-secondary talk-reply", () => go("replying"));
  const remove = button("desk-btn-quiet talk-delete", () => go("confirming"));
  bar.append(reply, remove);
  const form = el(doc, "div", "talk-form");
  const text = /** @type {HTMLTextAreaElement} */ (el(doc, "textarea", "desk-field talk-text"));
  text.rows = 3;
  text.oninput = () => draw(post);
  const send = button("desk-btn-primary talk-send", () => void sendReply());
  const cancel = button("desk-btn-quiet talk-cancel", () => go("idle"));
  form.append(text, send, cancel);
  const confirm = el(doc, "div", "talk-confirm");
  confirm.setAttribute("role", "alertdialog");
  const question = el(doc, "p", "talk-question");
  const yes = button("desk-btn-primary talk-yes", () => void deleteIt());
  const no = button("desk-btn-quiet talk-no", () => go("idle"));
  confirm.append(question, yes, no);
  const note = el(doc, "p", "talk-note");
  note.setAttribute("role", "status");
  box.append(bar, form, confirm, note);

  /** @type {Post | undefined} */
  let post;
  /** @type {"idle" | "replying" | "confirming" | "sending"} */
  let mode = "idle";
  let said = "";

  const go = (/** @type {typeof mode} */ next) => {
    mode = next;
    if (next !== "sending") said = "";
    draw(post);
    (next === "replying" ? text : next === "confirming" ? no : reply).focus();
  };
  async function sendReply() {
    const p = post;
    const words = text.value.trim();
    if (!p || !words) return;
    mode = "sending";
    draw(p);
    try {
      await deps.reply(p, words);
      text.value = "";
      said = t("talk.replied", { network: p.network.name });
      mode = "idle";
    } catch (e) {
      said = t("talk.failed", { why: wordsOf(e) });
      mode = "replying";
    }
    draw(post);
  }
  async function deleteIt() {
    const p = post;
    if (!p) return;
    mode = "sending";
    draw(p);
    try {
      await deps.deletePost(p);
      said = t("talk.deleted", { network: p.network.name });
    } catch (e) {
      said = t("talk.failed", { why: wordsOf(e) });
    }
    mode = "idle";
    draw(post);
  }

  /** Show what the post allows; another post starts over. */
  function draw(/** @type {Post | undefined} */ next) {
    if (next?.key !== post?.key) {
      mode = "idle";
      said = "";
      text.value = "";
    }
    post = next;
    const may = post ? deps.postActions(post) : { reply: false, delete: false };
    box.hidden = !post || (!may.reply && !may.delete && !said);
    reply.textContent = t("talk.reply");
    remove.textContent = t("talk.delete");
    reply.hidden = !may.reply;
    remove.hidden = !may.delete;
    bar.hidden = mode !== "idle";
    form.hidden = !(mode === "replying" || (mode === "sending" && text.value.trim() !== ""));
    text.placeholder = text.ariaLabel = t("talk.placeholder");
    send.textContent = t("talk.send");
    cancel.textContent = t("cancel");
    send.disabled = mode === "sending" || !text.value.trim();
    confirm.hidden = mode !== "confirming";
    const named = post ? firstLines(post.text || post.title, 80) : "";
    question.textContent = post
      ? t("talk.confirm", { network: post.network.name, post: named })
      : "";
    yes.textContent = t("talk.deleteYes");
    no.textContent = t("cancel");
    note.textContent = said;
  }
  return { box, draw };
}
