/**
 * The composer of an agent's window (ADR 0411): a field that grows from one line to 200 px, a
 * menu ("Open on endue.ai", "Copy link"), the microphone (FT-02 writes into the field) and Send,
 * which becomes Stop while a run is in flight. Built once, so the draft and the caret survive
 * every redraw; `update` changes only what it says. Enter sends, Shift+Enter starts a line.
 */
import { audioContext, openMic } from "../../../eris/ear";
import type { Ear } from "../../../eris/talk";
import type { ShellCtx } from "../../../shell/context";
import { h } from "../../../shell/dom";
import { icon } from "../../../shell/icons";
import { text } from "../parts";

export interface ComposerState {
  name: string;
  /** A new chat: the placeholder names the agent. */
  fresh: boolean;
  running: boolean;
  /** Why it cannot send now (offline), or "". */
  blocked: string;
}

export interface Composer {
  el: HTMLElement;
  update(state: ComposerState): void;
  focus(): void;
  dispose(): void;
}

const MAX_FIELD = 200;

export function composer(
  ctx: ShellCtx,
  act: { send(text: string): void; stop(): void; openWeb(): void; copyLink(): void },
): Composer {
  let state: ComposerState = { name: "", fresh: true, running: false, blocked: "" };
  let ear: Ear | undefined;
  const field = h("textarea", {
    class: "input thread-field",
    rows: "1",
    "data-key": "thread-field",
  }) as HTMLTextAreaElement;
  const grow = () => {
    field.style.height = "auto";
    field.style.height = `${Math.min(field.scrollHeight, MAX_FIELD)}px`;
  };
  const submit = () => {
    if (state.running) return act.stop();
    const line = field.value.trim();
    if (!line || state.blocked) return;
    field.value = "";
    grow();
    act.send(line);
  };
  field.addEventListener("input", grow);
  field.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });
  const menu = h(
    "div",
    { class: "thread-menu", role: "menu", hidden: true },
    h(
      "button",
      {
        class: "menu-item",
        type: "button",
        role: "menuitem",
        "data-action": "open-web",
        onClick: () => {
          close();
          act.openWeb();
        },
      },
      text(ctx, "threadOpenWeb"),
    ),
    h(
      "button",
      {
        class: "menu-item",
        type: "button",
        role: "menuitem",
        "data-action": "copy-link",
        onClick: () => {
          close();
          act.copyLink();
        },
      },
      text(ctx, "threadCopyLink"),
    ),
  );
  const more = h(
    "button",
    {
      class: "icon-button thread-more",
      type: "button",
      "aria-haspopup": "menu",
      "aria-expanded": "false",
      "aria-label": text(ctx, "threadMenu"),
      "data-action": "thread-menu",
      onClick: () => (menu.hidden ? openMenu() : close()),
    },
    icon("plus", 16),
  );
  function openMenu() {
    menu.hidden = false;
    more.setAttribute("aria-expanded", "true");
    menu.querySelector<HTMLButtonElement>("button")?.focus();
  }
  function close() {
    menu.hidden = true;
    more.setAttribute("aria-expanded", "false");
  }
  menu.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
      more.focus();
    }
  });
  const mic = h(
    "button",
    {
      class: "icon-button thread-mic",
      type: "button",
      "aria-pressed": "false",
      "aria-label": text(ctx, "threadMic"),
      "data-action": "dictate",
      onClick: () => void dictate(),
    },
    icon("mic", 16),
  );
  async function dictate() {
    if (ear) {
      const heard = await ear.close();
      ear = undefined;
      mic.setAttribute("aria-pressed", "false");
      if (heard.trim()) field.value = [field.value.trim(), heard.trim()].filter(Boolean).join(" ");
      grow();
      field.focus();
      return;
    }
    const lang = ctx.store.get().lang;
    const opened = await openMic(lang, audioContext(), ctx.bridge.audio);
    if (opened && typeof opened === "object") {
      ear = opened;
      mic.setAttribute("aria-pressed", "true");
    }
  }
  const send = h("button", {
    class: "btn btn-primary thread-send",
    type: "button",
    "data-action": "send",
    onClick: submit,
  });
  const note = h("p", { class: "thread-blocked", hidden: true });
  const keys = h(
    "p",
    { class: "thread-keys" },
    h("kbd", { class: "thread-kbd" }, "Enter"),
    h("span", { "data-keys": "send" }),
    h("kbd", { class: "thread-kbd" }, "Shift"),
    h("kbd", { class: "thread-kbd" }, "Enter"),
    h("span", { "data-keys": "line" }),
  );
  const el = h(
    "div",
    { class: "thread-compose" },
    note,
    h(
      "div",
      { class: "thread-composer" },
      field,
      h(
        "div",
        { class: "thread-tools" },
        h("span", { class: "thread-menu-wrap" }, more, menu),
        h("span", { class: "thread-spacer" }),
        mic,
        send,
      ),
    ),
    keys,
  );
  return {
    el,
    update(next) {
      state = next;
      const name = next.name;
      field.placeholder = next.fresh
        ? text(ctx, "threadMessage", { name })
        : text(ctx, "threadReply");
      field.setAttribute("aria-label", text(ctx, "threadReplyTo", { name }));
      send.textContent = text(ctx, next.running ? "threadStop" : "threadSend");
      send.dataset.action = next.running ? "stop" : "send";
      send.className = next.running ? "btn thread-send" : "btn btn-primary thread-send";
      send.toggleAttribute("disabled", !next.running && next.blocked !== "");
      note.hidden = !next.blocked;
      note.textContent = next.blocked;
      const [sendKey, lineKey] = keys.querySelectorAll("span");
      if (sendKey) sendKey.textContent = text(ctx, "threadKeysSend");
      if (lineKey) lineKey.textContent = text(ctx, "threadKeysLine");
    },
    focus: () => field.focus(),
    dispose() {
      void ear?.close();
    },
  };
}
