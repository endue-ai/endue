// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { sampleAgentId } from "../../bridge/studio-fixtures";
import { loadEndue } from "../../system/endue";
import { endueAgentBody } from "./agent";
import { EPOCH, settle, testDesk } from "./test-desk";

const MISO = sampleAgentId(1);
const PIP = sampleAgentId(2);
const offs: (() => void)[] = [];
afterEach(() => {
  for (const off of offs.splice(0)) off();
  document.body.replaceChildren();
});

async function mounted(id = MISO, lang: "en" | "ko" = "en") {
  const desk = testDesk(lang);
  desk.signIn();
  await loadEndue(desk.ctx);
  const { el, off } = endueAgentBody(desk.ctx, id);
  if (off) offs.push(off);
  document.body.append(el);
  await settle();
  await settle();
  return { ...desk, el, side: desk.studio.side };
}

const press = (el: ParentNode | null | undefined, selector: string) => {
  const button = el?.querySelector<HTMLButtonElement>(selector);
  if (!button) throw new Error(`nothing to press at ${selector}`);
  button.click();
};
const texts = (el: ParentNode | null | undefined, selector: string) =>
  [...(el?.querySelectorAll(selector) ?? [])].map((n) => n.textContent);
const topics = (el: HTMLElement) => el.querySelector("[data-section=topics]");
const panel = (el: HTMLElement) => el.querySelector<HTMLElement>(".thread-panel");

describe("the side of an agent's window (ADR 0411, FT-07)", () => {
  it("a_topic_reads_its_threads_when_unfolded", async () => {
    const { el, side } = await mounted();
    expect(texts(topics(el), ".thread-topic .thread-side-title")).toEqual([
      "# launch-plan",
      "# weekly-review",
    ]);
    expect(el.querySelector("[data-count=topics]")?.textContent).toBe("2");
    expect(side.reads.filter((r) => r.startsWith("threads:"))).toEqual([]);
    press(topics(el), "[data-key=topic-tp_launch]");
    await settle();
    expect(side.reads.filter((r) => r.startsWith("threads:"))).toEqual(["threads:tp_launch"]);
    const unfolded = el.querySelector("[data-topic=tp_launch]");
    expect(unfolded?.querySelector(".thread-topic")?.getAttribute("aria-expanded")).toBe("true");
    expect(texts(unfolded, ".thread-topic-threads [data-conversation] .thread-side-title")).toEqual(
      ["Pricing page copy", "Launch checklist"],
    );
    // The recent list keeps the person's conversations; a topic's threads stay in their topic.
    expect(texts(el, "[data-section=threadRecent] .thread-side-title")).not.toContain(
      "Pricing page copy",
    );
    // A thread opens in the thread, where the composer continues it.
    press(unfolded, "[data-conversation=cnv_topic1]");
    await settle();
    expect(el.querySelector("[data-conversation=cnv_topic1]")?.getAttribute("aria-current")).toBe(
      "true",
    );
    expect(
      el.querySelectorAll(".thread-list .thread-bubble, .thread-list .thread-answer").length,
    ).toBeGreaterThan(0);
    // Folded and unfolded again, the threads are not read twice.
    press(topics(el), "[data-key=topic-tp_launch]");
    press(topics(el), "[data-key=topic-tp_launch]");
    await settle();
    expect(side.reads.filter((r) => r.startsWith("threads:"))).toEqual(["threads:tp_launch"]);
  });

  it("new_thread_opens_an_empty_thread_in_that_topic", async () => {
    const { el, bridge, side } = await mounted();
    press(topics(el), "[data-key=topic-tp_weekly]");
    await settle();
    press(el, "[data-key=new-thread-tp_weekly]");
    await settle();
    expect(el.querySelector(".thread-intro")).not.toBeNull();
    const field = el.querySelector<HTMLTextAreaElement>(".thread-field");
    if (!field) throw new Error("no composer");
    field.value = "Plan week 48";
    field.dispatchEvent(new Event("input"));
    press(el, "[data-action=send]");
    await settle();
    await settle();
    const made = bridge.fake.thread.messages;
    const conversation = Object.keys(made).find((id) =>
      made[id]?.some((m) => m.text === "Plan week 48"),
    );
    expect(conversation).toBeDefined();
    const threads = side.reads.filter((r) => r === "threads:tp_weekly");
    expect(threads.length).toBe(2);
    expect(
      texts(el.querySelector("[data-topic=tp_weekly]"), ".thread-topic-threads .thread-side-title"),
    ).toContain("Plan week 48");
  });

  it("routines_say_what_starts_them", async () => {
    const { el } = await mounted();
    press(el, "[data-side-tab=home]");
    expect(el.querySelector("[data-count=routines]")?.textContent).toBe("3");
    press(el, "[data-panel=routines]");
    const shown = panel(el);
    expect(shown?.hidden).toBe(false);
    expect(el.querySelector<HTMLElement>(".thread-home")?.hidden).toBe(true);
    expect(texts(shown, "[data-routine] .thread-side-title")).toEqual([
      "Morning brief",
      "New lead",
      "Weekly digest",
    ]);
    expect(texts(shown, "[data-starts]")).toEqual([
      "Every weekday at 9:00",
      "When its webhook is called",
      "Every Monday at 8:00",
    ]);
    expect(texts(shown, ".thread-routine-state")).toEqual(["On", "On", "Off"]);
    expect(texts(shown, "[data-routine=rt_brief] .thread-panel-sub")[1]).toBe("Ran 3h · done");
    expect(texts(shown, "[data-routine=rt_lead] .thread-panel-sub")[1]).toBe("Has not run yet");
    press(shown, "[data-action=panel-back]");
    expect(panel(el)?.hidden).toBe(true);
  });

  it("outputs_show_their_count_from_the_facets", async () => {
    const { el, bridge } = await mounted();
    press(el, "[data-side-tab=home]");
    expect(el.querySelector("[data-count=outputs]")?.textContent).toBe("4");
    press(el, "[data-panel=outputs]");
    expect(panel(el)?.querySelector("[data-list=outputs]")?.textContent).toContain(
      "4 made · the newest changed",
    );
    press(panel(el), "[data-action=open-outputs]");
    await settle();
    expect(bridge.fake.opened.at(-1)).toBe(`https://endue.ai/agents/${MISO}`);
  });

  it("each_list_says_when_it_is_empty_or_unread", async () => {
    const empty = await mounted(PIP);
    expect(empty.el.querySelector("[data-section=topics] [data-none]")?.textContent).toBe(
      "No topics yet.",
    );
    press(empty.el, "[data-side-tab=home]");
    press(empty.el, "[data-panel=routines]");
    expect(panel(empty.el)?.querySelector("[data-none]")?.textContent).toBe("No routines yet.");

    const { el, ctx, side } = await mounted();
    side.failing["studio.topics.list"] = "endue AI did not answer";
    // The focus reads again only after five minutes.
    el.dispatchEvent(new FocusEvent("focusin"));
    await settle();
    expect(side.reads.filter((r) => r.startsWith("topics:")).length).toBe(1);
    (ctx as unknown as { wall: () => number }).wall = () => EPOCH + 5 * 60_000;
    el.dispatchEvent(new FocusEvent("focusin"));
    await settle();
    expect(side.reads.filter((r) => r.startsWith("topics:")).length).toBe(2);
    const unread = topics(el)?.querySelector("[data-unread]");
    expect(unread?.textContent).toContain("Could not read this: endue AI did not answer");
    delete side.failing["studio.topics.list"];
    press(unread, "[data-action=side-read-again]");
    await settle();
    expect(topics(el)?.querySelector("[data-unread]")).toBeNull();
    expect(texts(topics(el), ".thread-topic .thread-side-title")).toHaveLength(2);
  });
});
