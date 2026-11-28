// @vitest-environment jsdom
// Social Studio on the test host: the Feed, Replies and Numbers over the social item vectors of two
// networks, the accounts with their status, and what a network's text and links may not do.
import { describe, expect, it } from "vitest";
import { IG, instance, mount, post, RD, sample } from "./harness";

const click = (el: Element | null | undefined) => (el as HTMLElement | null)?.click();
const tab = (m: Awaited<ReturnType<typeof mount>>, name: string) =>
  m.$$("#views .desk-tab").find((t) => t.textContent?.startsWith(name));

describe("Social Studio", () => {
  it("the feed is every account's posts, newest first", async () => {
    const m = await mount();
    expect(m.rows()).toEqual([
      "Studio: Our studio tour Come see the shop.",
      "Studio: Autumn drop New colors in the shop today.",
    ]);
    const first = m.$("#list .row");
    expect(first?.querySelector(".mark")?.textContent).toBe("Rd");
    expect(first?.querySelector(".row-where")?.textContent).toBe("@studio · Studio on Reddit");
    expect(first?.querySelector(".row-foot")?.textContent).toBe("30 likes · 2 replies");
    expect(m.$$("#list .row")[1]?.querySelector(".row-foot")?.textContent).toBe(
      "12 likes · 3 replies · Image",
    );
    expect(first?.querySelector("time")?.getAttribute("datetime")).toBe("2026-11-21T09:00:00Z");

    const network = m.$<HTMLSelectElement>("#network");
    if (!network) throw new Error("no network filter");
    network.value = "instagram";
    network.dispatchEvent(new Event("change"));
    expect(m.rows()).toEqual(["Studio: Autumn drop New colors in the shop today."]);
    network.value = "";
    network.dispatchEvent(new Event("change"));

    click(m.$(`[data-account="endue.social/conn_2"]`));
    expect(m.rows()).toEqual(["Studio: Our studio tour Come see the shop."]);
    click(m.$$("#accounts .account")[0]);

    const search = m.$<HTMLInputElement>("#search");
    if (!search) throw new Error("no search");
    search.value = "autumn";
    search.dispatchEvent(new Event("input"));
    expect(m.rows()).toEqual(["Studio: Autumn drop New colors in the shop today."]);
    search.value = "nothing like this";
    search.dispatchEvent(new Event("input"));
    expect(m.$("#empty-text")?.textContent).toBe("Nothing matches.");
  });

  it("a post opens beside the list with its whole text and its way to the network", async () => {
    const m = await mount();
    click(m.$$("#list .row")[1]);
    const detail = m.$("#detail");
    expect(detail?.hidden).toBe(false);
    expect(detail?.querySelector(".detail-text")?.textContent).toBe(
      "Autumn drop\nNew colors in the shop today.",
    );
    expect(detail?.querySelector(".medium")?.textContent).toBe("Image: A green jacket");
    click(
      [...(detail?.querySelectorAll("button") ?? [])].find(
        (b) => b.textContent === "Open on Instagram",
      ),
    );
    await m.settle();
    expect(m.opened).toEqual(["https://instagram.example/p/18011"]);
    m.key("Escape");
    expect(m.$("#detail")?.hidden).toBe(true);
  });

  it("replies show the unseen first with the post they answer", async () => {
    const m = await mount();
    expect(tab(m, "Replies")?.querySelector(".badge")?.textContent).toBe("2");
    click(tab(m, "Replies"));
    expect(m.rows()).toEqual(["A fan: u/studio_team made this", "A fan: Love the green one"]);
    expect(m.$$("#list .row-unseen")).toHaveLength(2);
    click(m.$$("#list .row")[1]);
    expect(m.$("#detail .detail-answers")?.textContent).toBe(
      "Replying to: Autumn drop New colors in the shop today.",
    );
    await m.settle();
    expect(m.store.seen).toEqual(["endue.social/conn_1/c1"]);
    expect(m.rows()).toEqual(["A fan: u/studio_team made this", "A fan: Love the green one"]);
    expect(m.$$("#list .row-unseen")).toHaveLength(1);

    const again = await mount({ store: m.store });
    expect(tab(again, "Replies")?.querySelector(".badge")?.textContent).toBe("1");
  });

  it("numbers show each account's series and its best posts", async () => {
    const m = await mount({
      items: [
        ...sample(),
        post("p2", { text: "Second", at: "2026-11-25T09:00:00Z", counts: { likes: 40 } }),
      ],
    });
    click(tab(m, "Numbers"));
    const cards = m.$$("#numbers .card");
    expect(cards.map((c) => c.querySelector(".card-title")?.textContent)).toEqual([
      "IgStudio on Instagram",
      "RdStudio on Reddit",
    ]);
    const ig = cards[0];
    expect(
      [...(ig?.querySelectorAll(".series") ?? [])].map(
        (s) => s.querySelector(".series-name")?.textContent,
      ),
    ).toEqual(["Followers", "Reach"]);
    expect(ig?.querySelector('[data-metric="followers"] .series-value')?.textContent).toBe(
      "1,200, Nov 28, 2026, 12:00 AM",
    );
    expect(ig?.querySelector("polyline")?.getAttribute("points")).toBe("0.00,22.00 100.00,2.00");
    expect([...(ig?.querySelectorAll(".best .row-text") ?? [])].map((r) => r.textContent)).toEqual([
      "Second",
      "Autumn drop New colors in the shop today.",
    ]);
    expect(cards[1]?.querySelector(".card-empty")?.textContent).toContain("No numbers yet");
  });

  it("accounts are grouped by network with their status", async () => {
    const m = await mount({
      instances: [
        instance(IG, "Studio on Instagram", {
          state: "error",
          error: { message: "Signed out", reauth: true },
        }),
        instance(RD, "Studio on Reddit", {
          state: "paused",
          error: { message: "Turn on the endue account's connectors in Settings, Connections." },
        }),
      ],
    });
    const groups = m.$$("#accounts .network").map((g) => g.textContent);
    expect(groups).toEqual([
      "IgInstagramStudio on InstagramReconnect on endue.ai",
      "RdRedditStudio on RedditTurn on the endue account's connectors in Settings, Connections.",
    ]);

    const none = await mount({ items: [], instances: [] });
    expect(none.$("#empty-text")?.textContent).toContain("No social account is connected yet");
    click(none.$("#connect"));
    await none.settle();
    expect(none.connectorsOpened).toEqual([{ connector: "endue.social" }]);
  });

  it("text from a network is never HTML", async () => {
    const m = await mount({ items: [post("x1", { text: '<img src=x onerror="alert(1)">hi' })] });
    expect(m.$$("#list img")).toHaveLength(0);
    expect(m.rows()).toEqual(['Studio: <img src=x onerror="alert(1)">hi']);
    click(m.$("#list .row"));
    expect(m.$$("#detail img")).toHaveLength(0);
    expect(m.$("#detail .detail-text")?.textContent).toBe('<img src=x onerror="alert(1)">hi');
  });

  it("media from a network show as their kind, never as a remote image", async () => {
    const m = await mount();
    click(m.$$("#list .row")[1]);
    expect(document.querySelectorAll("img, video, iframe")).toHaveLength(0);
  });

  it("links open through shell.open, https only", async () => {
    const m = await mount({ items: [post("h1", { url: "http://example.com/h1" })] });
    click(m.$("#list .row"));
    expect(
      [...(m.$("#detail")?.querySelectorAll("button") ?? [])].map((b) => b.textContent),
    ).toEqual(["Close"]);
  });

  it("the lists are windowed", async () => {
    const many = Array.from({ length: 5000 }, (_, i) =>
      post(`n${i}`, { at: new Date(Date.UTC(2026, 9, 1) + i * 60_000).toISOString() }),
    );
    const m = await mount({ items: many });
    expect(m.$("#list .window-spacer")?.style.height).toBe(`${5000 * 76}px`);
    expect(m.page.drawn()).toBeLessThanOrEqual(24 + 12);
    expect(m.rows()[0]).toBe("Studio: Post n4999");
  });

  it("keys and the command switch views", async () => {
    const m = await mount();
    m.key("2");
    expect(tab(m, "Replies")?.getAttribute("aria-selected")).toBe("true");
    m.key("3");
    expect(m.$("#numbers")?.hidden).toBe(false);
    m.key("1", m.$("#search") ?? document.body);
    expect(m.$("#numbers")?.hidden).toBe(false);
    m.key("1");
    expect(m.$("#list")?.hidden).toBe(false);
    expect(await m.host.invoke("endue.social-studio.view", { view: "replies" })).toEqual({
      view: "replies",
    });
    expect(tab(m, "Replies")?.getAttribute("aria-selected")).toBe("true");
    await expect(m.host.invoke("endue.social-studio.view", { view: "drafts" })).rejects.toThrow();
  });

  it("speaks the desk's language", async () => {
    const m = await mount({ language: "ko" });
    expect(m.$("#title")?.textContent).toBe("SNS 스튜디오");
    expect(document.documentElement.lang).toBe("ko");
  });
});
