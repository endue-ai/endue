// @vitest-environment jsdom
// The writing side on the SDK's test host: drafts as files, the composer's previews against each
// account's capabilities, the review, publishing account by account, writing help, and Reply and
// Delete in a post's detail.
import { describe, expect, it } from "vitest";
import type { Item } from "../../../packages/bridge/src/index";
import { mount, RD, sample, vector } from "./harness";

const ROOT = "~/Documents/Social Studio/Drafts";
const PICTURE = "~/Pictures/jacket.jpg";
type Mounted = Awaited<ReturnType<typeof mount>>;

/** Reddit's account record: a title it requires, one picture, no video, deleting allowed. */
function redditRecord(): Item {
  const base = vector("record-social-account") as Item & { fields: Record<string, unknown> };
  const capabilities = {
    text: { max: 40000, required: false },
    title: { max: 300, required: true },
    media: {
      image: { max_count: 1, max_bytes: 20971520, types: ["image/jpeg", "image/png"] },
      video: false,
      required: false,
    },
    reply: true,
    delete_post: true,
    delete_comment: true,
  };
  return {
    ...base,
    id: "t2_s",
    source: RD,
    raw: { network: "reddit", account: RD.instance },
    fields: { ...base.fields, network: "reddit", capabilities },
  } as Item;
}

const items = () => [...sample(), redditRecord()];
const click = (el: Element | null | undefined) => (el as HTMLElement | null)?.click();
const type = (el: Element | null | undefined, value: string) => {
  const field = el as HTMLInputElement | HTMLTextAreaElement;
  field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
};
const text = (m: Mounted, selector: string) => m.$$(selector).map((e) => e.textContent ?? "");
/** Settle until `done` holds: publishing goes through several bridge calls per account. */
async function until(m: Mounted, done: () => unknown) {
  for (let i = 0; i < 40 && !done(); i++) await m.settle();
}
const button = (m: Mounted, name: string) =>
  m.$$("button").find((b) => b.textContent === name && !b.closest("[hidden]"));

/** A mounted studio in Drafts with a new draft open. */
async function drafting(options: Parameters<typeof mount>[0] = {}) {
  const m = await mount({ items: items(), ...options });
  m.key("4");
  await m.settle();
  click(m.$(".compose-new"));
  await m.settle();
  return m;
}
async function choose(m: Mounted, ...keys: string[]) {
  for (const key of keys) click(m.$(`.compose-account input[data-account="${key}"]`));
  await m.settle();
}
async function withPicture(m: Mounted) {
  click(m.$(".compose-add"));
  await m.settle();
}

describe("Social Studio drafts", () => {
  it("a draft is a folder of files that holds the last keystroke", async () => {
    const files = new Map<string, string>();
    const m = await drafting({ files });
    type(m.$(".compose-text"), "Autumn drop");
    await new Promise((resolve) => setTimeout(resolve, 350));
    await m.settle();
    const [folder] = [...files.keys()].filter((p) => p.endsWith("/post.md"));
    expect(folder).toMatch(
      /^~\/Documents\/Social Studio\/Drafts\/\d{8}-\d{6}-[a-z0-9]{4}\/post\.md$/,
    );
    expect(files.get(folder ?? "")).toBe("Autumn drop");
    const meta = JSON.parse(files.get((folder ?? "").replace("post.md", "draft.json")) ?? "{}");
    expect(meta).toMatchObject({ title: "", accounts: [], media: [], outcome: {} });

    const again = await mount({ items: items(), files });
    again.key("4");
    await again.settle();
    expect(text(again, ".draft .draft-line")).toEqual(["Autumn drop"]);
    click(again.$(".draft"));
    await again.settle();
    expect(again.$<HTMLTextAreaElement>(".compose-text")?.value).toBe("Autumn drop");
    click(again.$(".compose-trash"));
    await again.settle();
    expect(again.trashed).toEqual([(folder ?? "").replace("/post.md", "")]);
    expect(text(again, ".draft")).toEqual([]);
  });

  it("each chosen account previews the draft against what it takes", async () => {
    const m = await drafting({ files: new Map([[PICTURE, "JPEG"]]), picked: [PICTURE] });
    type(m.$(".compose-text"), "Autumn drop");
    await choose(m, "endue.social/conn_1", "endue.social/conn_2");
    expect(m.$(".compose-title")?.hidden).toBe(false);
    const preview = (key: string) => m.$(`.preview[data-account="${key}"]`);
    expect(preview("endue.social/conn_1")?.querySelector(".preview-count")?.textContent).toBe(
      "11 of 2,200 characters",
    );
    expect(text(m, '.preview[data-account="endue.social/conn_1"] .preview-problems li')).toEqual([
      "Instagram needs a picture or a video.",
    ]);
    expect(text(m, '.preview[data-account="endue.social/conn_2"] .preview-problems li')).toEqual([
      "Reddit needs a title.",
    ]);
    expect(m.$<HTMLButtonElement>(".compose-publish")?.disabled).toBe(true);

    await withPicture(m);
    const id = m.writer.state.current?.id;
    expect(m.files.get(`${ROOT}/${id}/jacket.jpg`)).toBe("JPEG");
    expect(text(m, ".medium-name")).toEqual(["Image · jacket.jpg"]);
    expect(text(m, '.preview[data-account="endue.social/conn_1"] .preview-problems li')).toEqual(
      [],
    );
    expect(m.$(".preview-media")?.textContent).toBe("1 picture");
    expect(m.$<HTMLButtonElement>(".compose-publish")?.disabled).toBe(false);
    type(m.$(".compose-text"), "x".repeat(2205));
    await m.settle();
    expect(text(m, '.preview[data-account="endue.social/conn_1"] .preview-problems li')).toEqual([
      "5 over Instagram's limit of 2200 characters.",
    ]);
  });

  it("an account that must be reconnected says so and stays out", async () => {
    const m = await drafting({
      instances: [
        {
          connector: "endue.social",
          instance: "conn_1",
          title: "Studio on Instagram",
          status: { state: "error", error: { message: "Expired", reauth: true } },
        } as never,
      ],
    });
    type(m.$(".compose-text"), "Hello");
    await choose(m, "endue.social/conn_1");
    expect(text(m, ".preview-problems li")[0]).toBe("Reconnect on endue.ai");
    expect(m.$<HTMLButtonElement>(".compose-publish")?.disabled).toBe(true);
  });

  it("the review names exactly what each account receives and invokes nothing before its button", async () => {
    const m = await drafting({ files: new Map([[PICTURE, "JPEG"]]), picked: [PICTURE] });
    type(m.$(".compose-text"), "Autumn drop");
    await choose(m, "endue.social/conn_1", "endue.social/conn_2");
    type(m.$(".compose-title"), "Our autumn colors");
    await withPicture(m);
    type(m.$(".medium-alt"), "A green jacket");
    await m.settle();
    click(m.$(".compose-publish"));
    await m.settle();
    const dialog = m.$('#review [role="dialog"]');
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(dialog?.querySelector("h2")?.textContent).toBe("Publish to 2 accounts?");
    expect(text(m, ".review-name > span:not(.mark)")).toEqual([
      "Studio on Instagram",
      "Studio on Reddit",
    ]);
    expect(text(m, ".review-heading")).toEqual(["Our autumn colors"]);
    expect(text(m, ".review-text")).toEqual(["Autumn drop", "Autumn drop"]);
    expect(text(m, ".review-media li")[0]).toBe(
      "Image · jacket.jpg · described as “A green jacket”",
    );
    expect(m.$(".review-final")?.textContent).toBe(
      "A published post cannot be taken back from here.",
    );
    expect(m.invoked).toEqual([]);
    click(m.$(".review-cancel"));
    await m.settle();
    expect(m.$("#review")?.hidden).toBe(true);
    expect(m.invoked).toEqual([]);

    click(m.$(".compose-publish"));
    await m.settle();
    click(m.$(".review-publish"));
    await until(m, () => m.$$(".outcome").length === 2);
    const id = m.writer.state.current?.id;
    const media = [{ path: `${ROOT}/${id}/jacket.jpg`, alt: "A green jacket" }];
    expect(m.invoked).toEqual([
      {
        id: "endue.social.post.publish",
        args: { instance: "conn_1", text: "Autumn drop", media },
      },
      {
        id: "endue.social.post.publish",
        args: { instance: "conn_2", text: "Autumn drop", title: "Our autumn colors", media },
      },
    ]);
    expect(text(m, ".outcome-published > span")).toEqual(["Published", "Published"]);
    click(button(m, "Open on Instagram"));
    await m.settle();
    expect(m.opened).toEqual(["https://example.com/p1"]);
  });

  it("one account failing leaves the others published, and Try again sends only it", async () => {
    let refuse = true;
    const m = await drafting({
      files: new Map([[PICTURE, "JPEG"]]),
      picked: [PICTURE],
      answers: {
        "endue.social.post.publish": (args) => {
          if (args.instance === "conn_2" && refuse) throw new Error("Titles over 300 are refused.");
          return { id: `${args.instance}-1` };
        },
      },
    });
    type(m.$(".compose-text"), "Autumn drop");
    await choose(m, "endue.social/conn_1", "endue.social/conn_2");
    type(m.$(".compose-title"), "Colors");
    await withPicture(m);
    click(m.$(".compose-publish"));
    await m.settle();
    click(m.$(".review-publish"));
    await until(m, () => m.$$(".outcome").length === 2);
    const outcome = (key: string) => m.$(`.preview[data-account="${key}"] .outcome`);
    expect(outcome("endue.social/conn_1")?.dataset.state).toBe("published");
    expect(outcome("endue.social/conn_2")?.textContent).toContain("Titles over 300 are refused.");
    refuse = false;
    click(outcome("endue.social/conn_2")?.querySelector(".outcome-retry"));
    await until(m, () => outcome("endue.social/conn_2")?.dataset.state === "published");
    expect(m.invoked.map((i) => i.args.instance)).toEqual(["conn_1", "conn_2", "conn_2"]);
    expect(outcome("endue.social/conn_2")?.dataset.state).toBe("published");
    expect(m.$<HTMLButtonElement>(".compose-publish")?.disabled).toBe(true);
    expect(text(m, ".draft-foot")[0]).toContain("Published to 2 accounts");
  });

  it("with no answer it says the post may be up and to look first", async () => {
    const m = await drafting({ refuse: { "cmd.invoke": "timeout" } });
    type(m.$(".compose-text"), "Hello Reddit");
    await choose(m, "endue.social/conn_2");
    type(m.$(".compose-title"), "Hello");
    await m.settle();
    click(m.$(".compose-publish"));
    await m.settle();
    click(m.$(".review-publish"));
    await until(m, () => m.$(".outcome"));
    const line = m.$(".outcome");
    expect(line?.dataset.state).toBe("unknown");
    expect(line?.textContent).toContain(
      "the post may be up on Reddit: look there before trying again",
    );
  });

  it("publishing first asks the account to let the key publish; refused, nothing goes", async () => {
    const m = await drafting({ may: ["read"], enabled: null });
    type(m.$(".compose-text"), "Hello Reddit");
    await choose(m, "endue.social/conn_2");
    type(m.$(".compose-title"), "Hello");
    await m.settle();
    click(m.$(".compose-publish"));
    await until(m, () => m.$(".review-key"));
    expect(m.$(".review-key")?.textContent).toContain("Your endue key may not publish yet");
    click(m.$(".review-publish"));
    await until(m, () => m.$(".compose-error")?.textContent);
    expect(m.enabled).toEqual([["publish"]]);
    expect(m.invoked).toEqual([]);
    expect(m.$(".compose-error")?.textContent).toContain("Not now.");
  });

  it("writing help shows a suggestion that goes in only when kept", async () => {
    const m = await drafting({ suggestion: "Autumn is here 🍂" });
    type(m.$(".compose-text"), "Our new autumn colors are in the shop today");
    await choose(m, "endue.social/conn_1");
    click(button(m, "Adapt for Instagram"));
    await until(m, () => m.asked.length > 0);
    expect(m.asked[0]).toContain("Adapt this social media post for Instagram");
    expect(m.$(".help-text")?.textContent).toBe("Writing a suggestion…");
    m.answerHelp();
    await until(m, () => m.$(".help-keep"));
    expect(m.$(".help-text")?.textContent).toBe("Autumn is here 🍂");
    expect(m.$<HTMLTextAreaElement>(".compose-text")?.value).toContain("Our new autumn");
    click(m.$(".help-keep"));
    await m.settle();
    expect(m.$<HTMLTextAreaElement>(".compose-text")?.value).toBe("Autumn is here 🍂");
    expect(m.$(".help-answer")).toBeNull();
  });
});

describe("Reply and Delete", () => {
  const open = async (m: Mounted, words: string) => {
    click(m.$$("#list .row").find((r) => r.textContent?.includes(words)));
    await m.settle();
  };

  it("reply where the network takes replies", async () => {
    const m = await mount({ items: items() });
    await open(m, "Autumn drop");
    expect(m.$(".talk-delete")?.hidden).toBe(true);
    click(m.$(".talk-reply"));
    type(m.$(".talk-text"), "Thank you!");
    click(m.$(".talk-send"));
    await m.settle();
    expect(m.invoked).toEqual([
      {
        id: "endue.social.post.reply",
        args: { instance: "conn_1", id: "18011", text: "Thank you!" },
      },
    ]);
    expect(m.$(".talk-note")?.textContent).toBe("Replied on Instagram.");
  });

  it("delete the account's own post, asking once and naming it", async () => {
    const m = await mount({ items: items() });
    await open(m, "Our studio tour");
    click(m.$(".talk-delete"));
    await m.settle();
    expect(m.$(".talk-question")?.textContent).toBe(
      "Delete “Our studio tour Come see the shop.” on Reddit? This cannot be undone.",
    );
    expect(m.invoked).toEqual([]);
    click(m.$(".talk-yes"));
    await m.settle();
    expect(m.invoked).toEqual([
      { id: "endue.social.post.delete", args: { instance: "conn_2", id: "t3_k1" } },
    ]);
  });
});
