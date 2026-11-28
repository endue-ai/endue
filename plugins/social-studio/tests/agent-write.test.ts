// @vitest-environment jsdom
// What an agent writes through Social Studio: a draft it makes, the drafts as data, and publish,
// reply and delete, which send exactly what their args say or nothing.
import { describe, expect, it } from "vitest";
import { IG, mount, RD } from "./harness";

const PICTURE = "~/Pictures/jacket.jpg";
const files = () => new Map([[PICTURE, "JPEG"]]);

describe("Social Studio writes for agents", () => {
  it("draft makes a draft with its pictures copied in, and drafts reads it back", async () => {
    const m = await mount({ files: files() });
    const made = await m.host.invoke("endue.social-studio.draft", {
      text: "Autumn drop",
      accounts: [IG],
      media: [{ path: PICTURE, alt: "A green jacket" }],
    });
    expect(made).toMatchObject({
      text: "Autumn drop",
      accounts: [IG],
      media: [{ file: "jacket.jpg", alt: "A green jacket", type: "image/jpeg" }],
      outcome: [],
    });
    const id = (made as { draft: string }).draft;
    expect(m.files.get(`~/Documents/Social Studio/Drafts/${id}/jacket.jpg`)).toBe("JPEG");
    const { drafts } = (await m.host.invoke("endue.social-studio.drafts", {})) as {
      drafts: { draft: string }[];
    };
    expect(drafts.map((d) => d.draft)).toEqual([id]);
    expect(await m.host.invoke("endue.social-studio.current", {})).toEqual({ draft: null });
    await expect(
      m.host.invoke("endue.social-studio.draft", {
        text: "x",
        media: [{ path: "~/notes.pdf" }],
      }),
    ).rejects.toThrow("notes.pdf is not a picture or a video.");
  });

  it("publish sends what its args say, refuses a draft that says otherwise, never twice", async () => {
    const m = await mount({ files: files() });
    const { draft } = (await m.host.invoke("endue.social-studio.draft", {
      text: "Autumn drop",
      accounts: [IG, RD],
      media: [{ path: PICTURE, alt: "A green jacket" }],
    })) as { draft: string };
    const args = {
      draft,
      accounts: [IG, RD],
      text: "Autumn drop",
      media: [{ file: "jacket.jpg", alt: "A green jacket" }],
    };
    await expect(
      m.host.invoke("endue.social-studio.publish", { ...args, text: "Autumn drop!" }),
    ).rejects.toThrow("The draft no longer says what this would publish");
    await expect(
      m.host.invoke("endue.social-studio.publish", { ...args, media: [] }),
    ).rejects.toThrow("no longer says");
    expect(m.invoked).toEqual([]);

    const answered = (await m.host.invoke("endue.social-studio.publish", args)) as {
      results: { source: unknown; state: string; url?: string }[];
    };
    expect(answered.results).toEqual([
      { source: IG, state: "published", id: "p1", url: "https://example.com/p1" },
      { source: RD, state: "published", id: "p2", url: "https://example.com/p2" },
    ]);
    const path = `~/Documents/Social Studio/Drafts/${draft}/jacket.jpg`;
    expect(m.invoked[0]?.args).toEqual({
      instance: "conn_1",
      text: "Autumn drop",
      media: [{ path, alt: "A green jacket" }],
    });
    await m.host.invoke("endue.social-studio.publish", args);
    expect(m.invoked).toHaveLength(2);
  });

  it("an account that cannot take the post is refused without being invoked", async () => {
    const m = await mount({ files: files() });
    const { draft } = (await m.host.invoke("endue.social-studio.draft", {
      text: "No picture",
    })) as { draft: string };
    const answered = (await m.host.invoke("endue.social-studio.publish", {
      draft,
      accounts: [IG],
      text: "No picture",
    })) as { results: unknown[] };
    expect(answered.results).toEqual([{ source: IG, state: "refused", why: "fit.mediaRequired" }]);
    expect(m.invoked).toEqual([]);
  });

  it("reply and delete act on a post as posts names it, where the network lets them", async () => {
    const m = await mount();
    expect(
      await m.host.invoke("endue.social-studio.reply", { source: IG, id: "18011", text: "Thanks" }),
    ).toEqual({ replied: true, id: "p1" });
    expect(m.invoked[0]).toEqual({
      id: "endue.social.post.reply",
      args: { instance: "conn_1", id: "18011", text: "Thanks" },
    });
    await expect(
      m.host.invoke("endue.social-studio.delete", { source: IG, id: "18011" }),
    ).rejects.toThrow("Instagram does not let this post be deleted from here.");
    await expect(
      m.host.invoke("endue.social-studio.reply", { source: IG, id: "nope", text: "Hi" }),
    ).rejects.toThrow("No such post");
    expect(m.invoked).toHaveLength(1);
  });
});
