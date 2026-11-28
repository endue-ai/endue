/**
 * Presentation around the existing composer; sending, IME and command matching stay in Composer.
 * At rest and under the pointer the talk line is one row, `[orb] [Talk to Eris] [chip] … [key]`;
 * open, two: `[grip] [chip] … [who answers]` over `[orb] [field] [agents +] [microphone] [key]`
 * (FT-04, ADR 0407). The chip names what the next line is about (`talk-address.ts`) and a link joins
 * the line to that window (`talk-link.ts`).
 */
import { DENSITIES, generateMesh, position, VIEW_IDLE } from "../eris/mesh";
import { selectAgent, spaceAgents } from "../system/agents";
import type { ShellCtx } from "./context";
import { h, listen, render } from "./dom";
import { icon } from "./icons";
import { addressBook } from "./talk-address";
import { addressName, talkChip } from "./talk-chip";
import { mountTalkLink } from "./talk-link";
import { mountTalkPlace } from "./talk-place";

const TALK = "desk.shell.talk";

function orb(): SVGSVGElement {
  const mesh = generateMesh({ ...DENSITIES.airy, view: VIEW_IDLE });
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "talk-orb");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute(
    "d",
    mesh.faces
      .filter((f) => f.n[2] > 0)
      .map((f) => {
        const points = f.v.map((v) => {
          const vertex = mesh.vertices[v];
          const p = vertex ? position(mesh, vertex) : [0, 0];
          return `${(12 + (p[0] ?? 0) * 10).toFixed(2)},${(12 - (p[1] ?? 0) * 10).toFixed(2)}`;
        });
        return `M${points.join("L")}Z`;
      })
      .join(""),
  );
  svg.append(path);
  return svg;
}

/** Who answers a line: the agent it goes to, else the brain Eris answers with (FT-01). */
function whoAnswers(ctx: ShellCtx): string {
  const s = ctx.store.get();
  const address = addressBook(ctx.store).current(s);
  if (address.kind === "agent") return addressName(ctx, address);
  const brain =
    (s.brain.mode === "cloud" ? s.brain.answering : undefined) ??
    s.brain.brain ??
    (s.brain.mode === "local" ? "local" : "endue");
  return ctx.tr(brain);
}

export function mountTalkChrome(root: HTMLElement, ctx: ShellCtx): () => void {
  const el = root.querySelector<HTMLElement>(".composer");
  const input = el?.querySelector<HTMLInputElement>(".composer-input");
  if (!el || !input) return () => {};
  el.classList.add("talk-pill");
  const book = addressBook(ctx.store);
  let hovered = false;
  let focused = false;
  let picking = false;
  const label = () => {
    const address = book.current(ctx.store.get());
    return address.kind === "agent"
      ? ctx.tr("talkToLaunch", { x: addressName(ctx, address) })
      : ctx.tr("composerLabel");
  };
  const show = () => {
    ctx.store.set((s) => ({ composer: { ...s.composer, open: true } }));
    input.focus();
  };
  // At rest the pill is the small orb, this hint, the chip and the key (ADR 0254, ADR 0407).
  const launchText = h("span", { class: "talk-hint" });
  const launch = h(
    "button",
    {
      class: "talk-launch",
      type: "button",
      "aria-controls": "composer-input",
      "aria-keyshortcuts": "Alt+Space",
      onClick: show,
    },
    orb(),
    launchText,
  );
  const fieldOrb = h("span", { class: "talk-field-orb", "aria-hidden": "true" }, orb());
  const shortcut = h("kbd", { class: "talk-shortcut", "aria-hidden": "true" });
  const grip = h(
    "span",
    { class: "talk-grip", "aria-hidden": "true", title: ctx.tr("talkGrip") },
    "⠿",
  );
  const who = h("span", { class: "talk-who" });
  const agents = h("div", {
    class: "popover talk-agent-list",
    id: "talk-agent-list",
    role: "group",
    hidden: true,
  });
  const agentButton = h(
    "button",
    {
      class: "talk-agent-button icon-button",
      type: "button",
      "aria-controls": "talk-agent-list",
      onClick: () => {
        picking = !picking;
        draw();
        if (picking) agents.querySelector("button")?.focus();
      },
    },
    icon("plus", 16),
  );
  // FT-02's spoken turn; the words so far show under Eris as she hears them.
  const mic = h(
    "button",
    { class: "talk-mic icon-button", type: "button", onClick: () => ctx.eris?.talk?.() },
    icon("mic", 16),
  );
  const chip = talkChip(ctx, () => draw());
  // Tab order open: chip, field, agents, microphone.
  el.append(launch, grip, chip.el, who, fieldOrb, agentButton, mic, shortcut, agents);
  const field = el.querySelector<HTMLElement>(".composer-field");
  if (field) {
    agentButton.before(field);
    field.style.removeProperty("height");
  }
  const place = mountTalkPlace(el, ctx);
  const shell = (root.closest(".shell") as HTMLElement | null) ?? document.body;
  const link = mountTalkLink(shell, ctx, {
    pill: el,
    address: () => book.current(ctx.store.get()),
    lit: () => hovered || focused || ctx.store.get().composer.open || book.pinned(),
  });
  /** Drawing moves focus (a list drawn again, a part hidden), which draws again: not while drawing. */
  let drawing = false;
  const draw = () => {
    if (drawing) return;
    drawing = true;
    try {
      paint();
    } finally {
      drawing = false;
    }
  };
  const paint = () => {
    const s = ctx.store.get();
    const open = s.composer.open;
    el.dataset.state = open ? "edit" : hovered || focused ? "hover" : "idle";
    const address = chip.draw();
    el.dataset.address = address.kind;
    launchText.textContent = label();
    launch.setAttribute("aria-label", label());
    launch.setAttribute("aria-expanded", String(open));
    launch.hidden = open;
    input.tabIndex = open ? 0 : -1;
    input.setAttribute("aria-label", label());
    shortcut.textContent = ctx.keyOf(TALK) ?? "";
    shortcut.hidden = !shortcut.textContent;
    launch.setAttribute(
      "aria-keyshortcuts",
      ctx.runtime.keymap
        .bindings()
        .filter((b) => b.command === TALK)
        .map((b) => b.combo)
        .join(" "),
    );
    input.placeholder = ctx.tr("talkPlaceholder");
    who.textContent = ctx.tr("talkAnswers", { x: whoAnswers(ctx) });
    const available = spaceAgents(s);
    agentButton.hidden = !open;
    agentButton.setAttribute("aria-label", ctx.tr("agents"));
    agentButton.setAttribute("aria-expanded", String(picking));
    mic.hidden = !open || !ctx.eris?.talk;
    mic.setAttribute("aria-label", ctx.tr("talkMic"));
    agents.setAttribute("aria-label", ctx.tr("agents"));
    agents.hidden = !picking || !open;
    render(agents, () =>
      available.length
        ? available.map((agent) =>
            h(
              "button",
              {
                class: "menu-item",
                type: "button",
                "data-key": `talk-${agent.id}`,
                onClick: () => {
                  picking = false;
                  selectAgent(ctx, agent.id);
                  // The line goes to the agent picked, until the person clears it.
                  book.pin(ctx.store.get(), {
                    kind: "agent",
                    agent: agent.id,
                    local: false,
                    window: `agent:${agent.id}`,
                    view: `agent:${agent.id}`,
                  });
                  draw();
                  input.focus();
                },
              },
              agent.name,
            ),
          )
        : [h("p", { class: "pop-row" }, ctx.tr("empty"))],
    );
    // Its state decides its size, and so how far from the edges a moved pill has to stay.
    place.draw();
    link.draw();
  };
  const hover = (on: boolean) => () => {
    hovered = on;
    draw();
  };
  const offs = [
    ctx.runtime.commands.define(TALK, {
      title: () => ctx.tr("cmdComposer"),
      owner: "desk.shell",
      keywords: ["talk", "eris", "말하기"],
      run: () => {
        if (!document.querySelector("dialog[open], .scrim")) show();
      },
    }),
    ctx.runtime.keymap.onChange(draw),
    // Moving from the empty input into its agent picker is still editing the same composer.
    listen(
      input,
      "blur",
      (e) => {
        if (el.contains((e as FocusEvent).relatedTarget as Node | null))
          e.stopImmediatePropagation();
      },
      { capture: true },
    ),
    // Backspace in an empty field clears the address, Escape a pinned one; Alt+Up cycles it.
    listen(
      input,
      "keydown",
      (e) => {
        const k = e as KeyboardEvent;
        if (k.isComposing) return;
        const empty = input.value === "";
        const s = ctx.store.get();
        if (k.key === "ArrowUp" && k.altKey) {
          k.preventDefault();
          k.stopImmediatePropagation();
          book.cycle(s);
          draw();
        } else if (
          empty &&
          book.current(s).kind !== "eris" &&
          (k.key === "Backspace" || (k.key === "Escape" && book.pinned()))
        ) {
          // Escape on a pinned address clears it, and the next one closes the line; on an address
          // that follows the window in use, Escape closes the line as it always has.
          if (k.key === "Escape") {
            k.preventDefault();
            k.stopImmediatePropagation();
          }
          book.clear(s);
          draw();
        }
      },
      { capture: true },
    ),
    ctx.store.watch(
      (s) => [
        s.composer.open,
        s.agents,
        s.spaceAgents,
        s.lang,
        s.focused,
        s.wm,
        s.sweep.selected,
        s.brain,
        s.desktop,
      ],
      () => {
        if (!ctx.store.get().composer.open) picking = false;
        draw();
      },
    ),
    listen(el, "pointerenter", hover(true)),
    listen(el, "pointerleave", hover(false)),
    listen(el, "focusin", () => {
      focused = true;
      draw();
    }),
    listen(el, "focusout", (e) => {
      if (el.contains((e as FocusEvent).relatedTarget as Node | null)) return;
      focused = false;
      draw();
    }),
    listen(el, "click", (e) => {
      if ((e.target as Element).closest("button, input, .composer-list, .talk-agent-list")) return;
      show();
    }),
    listen(agents, "keydown", (e) => {
      if ((e as KeyboardEvent).key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      picking = false;
      draw();
      input.focus();
    }),
    listen(document, "pointerdown", (e) => {
      if (picking && !el.contains(e.target as Node)) {
        picking = false;
        draw();
      }
    }),
  ];
  draw();
  return () => {
    for (const off of offs) off();
    place.dispose();
    link.dispose();
    for (const part of [launch, grip, chip.el, who, fieldOrb, agentButton, mic, shortcut, agents])
      part.remove();
    el.classList.remove("talk-pill");
    delete el.dataset.state;
    delete el.dataset.address;
  };
}
