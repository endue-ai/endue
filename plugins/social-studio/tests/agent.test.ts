// @vitest-environment jsdom
// What an agent reads through Social Studio: the accounts, the posts, the replies and mentions and
// an account's numbers, as data from the index, leaving the screen as it is; and show, which opens
// one post.
import { describe, expect, it } from "vitest";
import { IG, mount, RD } from "./harness";

describe("Social Studio for agents", () => {
  it("accounts answer each account with what its network lets it do", async () => {
    const m = await mount();
    const answer = (await m.host.invoke("endue.social-studio.accounts", {})) as {
      accounts: Array<Record<string, unknown>>;
    };
    expect(
      answer.accounts.map((a) => [a.title, a.network, a.state, a.handle, a.followers]),
    ).toEqual([
      ["Studio on Instagram", "instagram", "connected", "studio", 1200],
      ["Studio on Reddit", "reddit", "connected", undefined, undefined],
    ]);
    expect(answer.accounts[0]?.capabilities).toMatchObject({ reply: true });
  });

  it("posts answer the accounts' own posts, newest first, narrowed as asked", async () => {
    const m = await mount();
    const all = (await m.host.invoke("endue.social-studio.posts", {})) as {
      posts: Array<Record<string, unknown>>;
      more: boolean;
    };
    expect(all.posts.map((p) => [p.network, p.id, p.counts])).toEqual([
      ["reddit", "t3_k1", { likes: 30, replies: 2 }],
      ["instagram", "18011", { likes: 12, replies: 3 }],
    ]);
    expect(all.posts[1]).toMatchObject({
      source: IG,
      media: ["image"],
      url: "https://instagram.example/p/18011",
    });
    expect(all.more).toBe(false);
    const one = (await m.host.invoke("endue.social-studio.posts", { source: RD, limit: 1 })) as {
      posts: Array<{ id: string }>;
    };
    expect(one.posts.map((p) => p.id)).toEqual(["t3_k1"]);
    const words = (await m.host.invoke("endue.social-studio.posts", { query: "autumn" })) as {
      posts: Array<{ id: string }>;
    };
    expect(words.posts.map((p) => p.id)).toEqual(["18011"]);
  });

  it("replies answer the unseen first, or those to one post", async () => {
    const m = await mount();
    const all = (await m.host.invoke("endue.social-studio.replies", {})) as {
      replies: Array<Record<string, unknown>>;
      unseen: number;
    };
    expect(all.replies.map((r) => [r.id, r.kind, r.seen])).toEqual([
      ["t1_m1", "mention", false],
      ["c1", "reply", false],
    ]);
    expect(all.unseen).toBe(2);
    const to = (await m.host.invoke("endue.social-studio.replies", {
      source: IG,
      id: "18011",
    })) as {
      replies: Array<{ id: string }>;
    };
    expect(to.replies.map((r) => r.id)).toEqual(["c1"]);
  });

  it("numbers answer one account's series and best posts", async () => {
    const m = await mount();
    const answer = (await m.host.invoke("endue.social-studio.numbers", { source: IG })) as {
      series: Array<Record<string, unknown>>;
      best: Array<{ id: string }>;
    };
    expect(answer.series.map((s) => [s.metric, s.unit, s.latest])).toEqual([
      ["followers", "count", { t: "2026-11-28T00:00:00Z", v: 1200 }],
      ["reach", "count", { t: "2026-11-28T00:00:00Z", v: 1200 }],
    ]);
    expect(answer.best.map((p) => p.id)).toEqual(["18011"]);
    await expect(m.host.invoke("endue.social-studio.numbers", {})).rejects.toThrow(/source/);
  });

  it("reading leaves the screen as it is; show opens the post", async () => {
    const m = await mount();
    const before = document.body.innerHTML;
    for (const id of ["accounts", "posts", "replies"])
      await m.host.invoke(`endue.social-studio.${id}`, {});
    await m.host.invoke("endue.social-studio.numbers", { source: RD });
    expect(document.body.innerHTML).toBe(before);
    expect(await m.host.invoke("endue.social-studio.show", { source: IG, id: "c1" })).toEqual({
      shown: true,
    });
    expect(m.$("#views [aria-selected=true]")?.textContent).toContain("Replies");
    expect(m.$("#detail .detail-text")?.textContent).toBe("Love the green one");
    expect(m.host.visible).toBe(true);
    await expect(
      m.host.invoke("endue.social-studio.show", { source: IG, id: "gone" }),
    ).rejects.toThrow(/No such post/);
  });
});
