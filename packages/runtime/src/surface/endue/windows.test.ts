// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { sampleAgentId } from "../../bridge/studio-fixtures";
import { loadEndue } from "../../system/endue";
import { endueAgentBody } from "./agent";
import { endueSpaceBody } from "./space";
import { settle, testDesk } from "./test-desk";

const MISO = sampleAgentId(1);
const offs: (() => void)[] = [];
afterEach(() => {
  for (const off of offs.splice(0)) off();
  document.body.replaceChildren();
});

async function mounted(body: "agent" | "space", id: string, lang: "en" | "ko" = "en") {
  const desk = testDesk(lang);
  // The desk's commands, as the Agents plugin hears them: every run, in order.
  const ran: { command: string; args?: unknown }[] = [];
  (desk.ctx as unknown as { runtime: Record<string, unknown> }).runtime.commands = {
    run: async (command: string, args?: unknown) => void ran.push({ command, args }),
  };
  desk.signIn();
  await loadEndue(desk.ctx);
  const { el, off } =
    body === "agent" ? endueAgentBody(desk.ctx, id) : endueSpaceBody(desk.ctx, id);
  if (off) offs.push(off);
  document.body.append(el);
  await settle();
  return { ...desk, el, ran };
}

const face = (el: HTMLElement, side: "front" | "back") =>
  el.querySelector<HTMLElement>(`[data-face="${side}"]`);
const click = (el: HTMLElement, action: string, side: "front" | "back") =>
  face(el, side)?.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)?.click();
const fact = (el: HTMLElement, key: string) =>
  el.querySelector(`[data-fact="${key}"] dd`)?.textContent;

const tab = (el: HTMLElement, key: "home" | "studio") =>
  el.querySelector<HTMLButtonElement>(`[data-tab="${key}"]`)?.click();
const studioPanel = (el: HTMLElement) => el.querySelector<HTMLElement>(".thread-studio");
const studioRow = (el: HTMLElement, id: string) =>
  studioPanel(el)?.querySelector<HTMLElement>(`[data-row="${id}"]`);
const pressIn = (el: HTMLElement, selector: string) =>
  studioPanel(el)?.querySelector<HTMLButtonElement>(selector)?.click();
const texts = (el: ParentNode | null | undefined, selector: string) =>
  [...(el?.querySelectorAll(selector) ?? [])].map((n) => n.textContent);

describe("an endue agent's window (ADR 0411)", () => {
  it("the_window_shows_the_agents_conversations", async () => {
    const { el } = await mounted("agent", MISO);
    await settle();
    expect(el.querySelector(".thread-head .thread-name")?.textContent).toBe("Miso");
    expect(el.querySelector(".thread-head .thread-handle")?.textContent).toBe("@miso");
    // The side: New chat, then Miso's conversations, the newest first and open.
    const side = el.querySelector(".thread-side");
    expect(side?.querySelector("[data-action=new-chat]")?.textContent).toBe("New chat");
    expect(texts(side, ".thread-side-title")).toEqual([
      "Move Friday's dentist",
      "Sort this week's mail",
    ]);
    expect(side?.querySelector("[aria-current=true]")?.getAttribute("data-conversation")).toBe(
      "cnv_sample1",
    );
    // Its run is in flight: the star marks the row.
    expect(side?.querySelector("[data-conversation=cnv_sample1] .thread-star")).not.toBeNull();
    // The thread: the person's bubbles, the agent's prose, a turn's work, the new-messages line.
    expect(texts(el, ".thread-bubble")).toEqual([
      "Move Friday's dentist",
      "Thanks. Can you go on?",
    ]);
    expect(texts(el, ".thread-prose p")).toEqual([
      "I looked into it.",
      "Here is what I found so far.",
      "On it.",
    ]);
    expect(el.querySelector(".thread-work-line")?.textContent).toBe(
      "Work completed · 14 s · 3 tools",
    );
    expect(texts(el, ".thread-used .tag")).toEqual(["Search the web", "Read a page"]);
    const rows = [...el.querySelectorAll(".thread-list > li")].map((li) => li.className);
    expect(rows.indexOf("thread-new")).toBe(3);
    expect(el.querySelector(".thread-new")?.textContent).toBe("New messages");
    expect(el.querySelector(".thread-time")?.textContent).toBe("32m");
    // The composer: Reply into this conversation, Send, the keys under it.
    const field = el.querySelector<HTMLTextAreaElement>(".thread-field");
    expect(field?.placeholder).toBe("Reply");
    expect(field?.getAttribute("aria-label")).toBe("Reply to Miso");
    expect(el.querySelector(".thread-send")?.textContent).toBe("Send");
    expect(el.querySelector(".thread-keys")?.textContent).toBe("EnterSendShiftEnterNew line");
  });

  it("unfolds a turn's work into its tool groups", async () => {
    const { el } = await mounted("agent", MISO);
    await settle();
    const head = el.querySelector<HTMLButtonElement>(".thread-work-head");
    expect(head?.getAttribute("aria-expanded")).toBe("false");
    head?.click();
    const groups = el.querySelector(".thread-work-groups");
    expect(groups?.hasAttribute("hidden")).toBe(false);
    expect(texts(groups, ".thread-group-label")).toEqual(["Search the web", "Read a page"]);
    expect(texts(groups, ".thread-group-calls")).toEqual(["×2", "×1"]);
  });

  it("sends a line into the conversation it shows and the answer comes in", async () => {
    const { el, bridge } = await mounted("agent", MISO);
    await settle();
    const field = el.querySelector<HTMLTextAreaElement>(".thread-field");
    if (!field) throw new Error("no composer");
    field.value = "Make it Thursday";
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle();
    await settle();
    expect(texts(el, ".thread-bubble").at(-1)).toBe("Make it Thursday");
    expect(texts(el, ".thread-prose p").at(-1)).toBe("Here is what I found.");
    expect(bridge.fake.thread.messages.cnv_sample1?.at(-2)?.text).toBe("Make it Thursday");
    expect(field.value).toBe("");
  });

  it("a new chat starts a conversation at its first send", async () => {
    const { el, bridge } = await mounted("agent", MISO);
    await settle();
    el.querySelector<HTMLButtonElement>("[data-action=new-chat]")?.click();
    await settle();
    expect(el.querySelector(".thread-intro .endue-title")?.textContent).toBe("Miso");
    const field = el.querySelector<HTMLTextAreaElement>(".thread-field");
    expect(field?.placeholder).toBe("Message Miso");
    if (!field) throw new Error("no composer");
    field.value = "Plan my week";
    el.querySelector<HTMLButtonElement>("[data-action=send]")?.click();
    await settle();
    await settle();
    expect(texts(el, ".thread-bubble")).toEqual(["Plan my week"]);
    expect(texts(el, ".thread-prose p")).toEqual(["Here is what I found."]);
    expect(Object.keys(bridge.fake.thread.messages)).toContain("cnv_new_1");
  });

  it("a run held open can be stopped, and a failed one offers Try again", async () => {
    const { el, bridge } = await mounted("agent", MISO);
    await settle();
    const field = el.querySelector<HTMLTextAreaElement>(".thread-field");
    if (!field) throw new Error("no composer");
    bridge.fake.thread.hold();
    field.value = "Draft the note";
    el.querySelector<HTMLButtonElement>("[data-action=send]")?.click();
    await settle();
    const run = bridge.fake.thread.held();
    run?.delta("Dear team,");
    expect(el.querySelector(".thread-run .thread-prose")?.textContent).toBe("Dear team,");
    expect(el.querySelector(".thread-send")?.textContent).toBe("Stop");
    el.querySelector<HTMLButtonElement>("[data-action=stop]")?.click();
    await settle();
    expect(bridge.fake.thread.stopped).toEqual([run?.runId]);
    expect(el.querySelector(".thread-run")?.textContent).toBe("Stopped.");

    bridge.fake.thread.hold();
    field.value = "Try the flights";
    el.querySelector<HTMLButtonElement>("[data-action=send]")?.click();
    await settle();
    bridge.fake.thread.held()?.fail("the model timed out");
    expect(el.querySelector(".thread-callout[data-tone=danger]")?.textContent).toContain(
      "The run failed: the model timed out",
    );
    el.querySelector<HTMLButtonElement>("[data-action=try-again]")?.click();
    await settle();
    await settle();
    expect(texts(el, ".thread-bubble").at(-1)).toBe("Try the flights");
    expect(texts(el, ".thread-prose p").at(-1)).toBe("Here is what I found.");
  });

  it("an_inactive_agent_has_no_composer", async () => {
    const { el, store } = await mounted("agent", sampleAgentId(2));
    expect(el.querySelector(".thread-composer")).toBeNull();
    expect(el.querySelector(".thread-inactive p")?.textContent).toBe(
      "This agent is not taking work.",
    );
    el.querySelector<HTMLButtonElement>("[data-action=open-studio-tab]")?.click();
    await settle();
    expect(store.get().endue.flipped).toEqual([`endue-agent:${sampleAgentId(2)}`]);
  });

  it("shows the agent's face in its header once the core has read it (ADR 0232)", async () => {
    const { el, studio } = await mounted("agent", MISO);
    await settle();
    const picture = el.querySelector<HTMLImageElement>(".thread-head .endue-avatar img");
    expect(picture?.getAttribute("src")).toBe(studio.pictures[MISO]);
  });

  it("home_and_studio_are_tabs", async () => {
    const { el, store } = await mounted("agent", MISO);
    expect(texts(el, "[role=tab]")).toEqual(["Home", "Studio"]);
    expect(el.querySelector("[data-tab=home]")?.getAttribute("aria-selected")).toBe("true");
    expect(studioPanel(el)?.hidden).toBe(true);
    tab(el, "studio");
    await settle();
    expect(store.get().endue.flipped).toEqual([`endue-agent:${MISO}`]);
    expect(el.querySelector("[data-tab=studio]")?.getAttribute("aria-selected")).toBe("true");
    expect(el.querySelector<HTMLElement>(".thread-home")?.hidden).toBe(true);
    const back = studioPanel(el);
    expect(back?.hidden).toBe(false);
    // Three columns, as endue.ai's Studio has them, the agent's sheet in the middle.
    expect(texts(back, ".studio-col-head")).toEqual([
      "01Where requests come in",
      "02Where the agent handles them",
      "03What it reaches",
    ]);
    expect(
      [...(back?.querySelectorAll("[data-col='in'] [data-row]") ?? [])].map((r) =>
        r.getAttribute("data-row"),
      ),
    ).toEqual(["console", "channel", "live", "api", "mcp"]);
    const hub = back?.querySelector("[data-hub]");
    expect(hub?.querySelector(".studio-name")?.textContent).toBe("Miso");
    expect(hub?.querySelector(".studio-sentence")?.textContent).toBe(
      "Takes requests from Console chat · Acme · API, handles them with 2 built-in tools, and leaves results in Outputs.",
    );
    expect(back?.querySelector("svg.studio-lines")?.getAttribute("aria-hidden")).toBe("true");
    expect(texts(back, ".endue-actions [data-action]")).toEqual(["Read again", "Edit in Studio"]);
    tab(el, "home");
    await settle();
    expect(studioPanel(el)?.hidden).toBe(true);
    expect(store.get().endue.flipped).toEqual([]);
  });

  it("unfolds a way in where it stands, one at a time, and keeps the focus on it", async () => {
    const { el } = await mounted("agent", MISO);
    tab(el, "studio");
    await settle();
    const head = (id: string) =>
      studioRow(el, id)?.querySelector<HTMLButtonElement>("[data-row-head]");
    expect(head("live")?.getAttribute("aria-expanded")).toBe("false");
    head("live")?.focus();
    head("live")?.click();
    expect(head("live")?.getAttribute("aria-expanded")).toBe("true");
    expect(studioRow(el, "live")?.querySelector(".studio-row-body p")?.textContent).toBe(
      "Turn it on to chat at endue.live/@miso.",
    );
    expect(document.activeElement).toBe(head("live"));
    head("mcp")?.click();
    expect(studioRow(el, "live")?.querySelector(".studio-row-body")).toBeNull();
  });

  it("opens each part of the board in the Agents Studio, and nothing of endue.ai", async () => {
    const { el, bridge, ran } = await mounted("agent", MISO);
    tab(el, "studio");
    await settle();
    pressIn(el, '[data-section="prompt"]');
    await settle();
    pressIn(el, '[data-key="studio-foot-settings"]');
    await settle();
    pressIn(el, '[data-action="open-studio"]');
    await settle();
    const studio = (facet: string) => [
      { command: "desk.plugins.open", args: { plugin: "endue.agents" } },
      { command: "endue.agents.studio", args: { agent: MISO, facet } },
    ];
    expect(ran.slice(0, 4)).toEqual([...studio("prompt"), ...studio("settings")]);
    expect(ran.at(-1)).toEqual({
      command: "endue.agents.studio",
      args: { agent: MISO, facet: "identity" },
    });
    expect(bridge.fake.opened).toEqual([]);
  });

  it("speaks the desk's language", async () => {
    const { el } = await mounted("agent", MISO, "ko");
    await settle();
    expect(texts(el, "[role=tab]")).toEqual(["홈", "스튜디오"]);
    expect(el.querySelector("[data-action=new-chat]")?.textContent).toBe("새 대화");
    expect(el.querySelector(".thread-side-heading")?.textContent).toBe("최근");
    expect(el.querySelector<HTMLTextAreaElement>(".thread-field")?.placeholder).toBe("답장");
    expect(el.querySelector(".thread-send")?.textContent).toBe("보내기");
    expect(el.querySelector(".thread-new")?.textContent).toBe("새 메시지");
    expect(el.querySelector(".thread-work-line")?.textContent).toBe("작업 완료 · 14초 · 도구 3개");
    expect(el.querySelector(".thread-time")?.textContent).toBe("32분");
    tab(el, "studio");
    await settle();
    expect(studioPanel(el)?.querySelector(".studio-col-head")?.textContent).toBe(
      "01요청이 들어오는 곳",
    );
  });

  it("shows a notice once the desk is signed out", async () => {
    const { el, ctx, bridge } = await mounted("agent", MISO);
    await bridge.account.signOut();
    await loadEndue(ctx);
    expect(el.querySelector(".endue-notice")?.textContent).toBe("Sign in to see it again");
  });
});

describe("an endue space's window (ADR 0129)", () => {
  it("shows the space's card: glyph, goal, front desk, agents and what is open", async () => {
    const { el } = await mounted("space", "sp_sample001");
    const front = face(el, "front");
    expect(front?.querySelector(".endue-avatar")?.textContent).toBe("🚀");
    expect(front?.querySelector(".endue-handle")?.textContent).toBe("Front desk · Miso");
    expect(front?.querySelector(".endue-desc")?.textContent).toBe(
      "Ship the launch page and its first mail",
    );
    expect(front?.querySelectorAll(".endue-members .endue-member")).toHaveLength(3);
    expect(
      [...(front?.querySelectorAll(".endue-chips li") ?? [])].map((c) => c.textContent),
    ).toEqual(["Agents · 3", "In progress · 2", "Needs you · 1"]);
  });

  it("turns over to the space's status, work, results and rooms", async () => {
    const { el } = await mounted("space", "sp_sample001");
    click(el, "studio", "front");
    await settle();
    expect(fact(el, "status")).toBe("Active");
    expect(fact(el, "attention")).toBe("1");
    expect(fact(el, "rooms")).toBe("2 · 3 unread · 1 discussing");
    const titles = (list: string) =>
      [...el.querySelectorAll(`[data-list="${list}"] .endue-line-title`)].map((l) => l.textContent);
    expect(titles("work")).toEqual(["Write the first mail", "Pick the hero image"]);
    expect(titles("results")).toEqual(["Launch page draft", "Competitor table"]);
    expect(titles("rooms")).toEqual(["Copy", "Research"]);
  });

  it("opens one of the person's own agents from the space's Studio", async () => {
    const { el, store } = await mounted("space", "sp_sample001");
    click(el, "studio", "front");
    await settle();
    el.querySelector<HTMLButtonElement>(`[data-member="${sampleAgentId(3)}"]`)?.click();
    expect(store.get().focused).toBe(`endue-agent:${sampleAgentId(3)}`);
  });

  it("names a part endue AI did not answer for", async () => {
    const desk = testDesk();
    desk.signIn();
    const launch = desk.studio.spaces[0];
    if (!launch) throw new Error("a sample space");
    launch.detail.rooms = [];
    launch.detail.problems = [
      { part: "rooms", code: "offline", message: "endue AI did not answer" },
    ];
    await loadEndue(desk.ctx);
    const { el, off } = endueSpaceBody(desk.ctx, "sp_sample001");
    if (off) offs.push(off);
    document.body.append(el);
    await settle();
    expect(face(el, "back")?.querySelector('[role="alert"]')?.textContent).toBe(
      "Rooms: endue AI did not answer",
    );
  });
});
