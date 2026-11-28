// Mounts Social Studio on the SDK's test host over jsdom: the page from ui/index.html, the
// plugin's catalogs, and an index holding the social item vectors of specs/item/v0 (Instagram on
// conn_1, Reddit on conn_2) and whatever a test adds. connector.list answers the two accounts of
// endue.social; store.* keeps what the studio saves, so a remount reads it back.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ConnectorInfo,
  ConnectorInstance,
  Item,
  MessageCatalog,
  Permission,
} from "../../../packages/bridge/src/index";
import { defineUiPlugin } from "../../../packages/plugin-sdk/src/index";
import { createTestHost, type TestHost } from "../../../packages/plugin-sdk/src/testing/index";
import { mountStudio } from "../ui/app.js";

const here = import.meta.dirname;
const repo = join(here, "../../..");
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));

/** One item vector of specs/item/v0, by name. */
export const vector = (name: string): Item =>
  json(join(repo, `specs/item/v0/vectors/valid/${name}.json`)).instance ??
  json(join(repo, `specs/item/v0/vectors/valid/${name}.json`));

export const manifest = () => json(join(here, "../plugin.json"));
export const catalog = (language: string): MessageCatalog =>
  json(join(here, `../messages/${language}.json`));

export const IG = { connector: "endue.social", instance: "conn_1" };
export const RD = { connector: "endue.social", instance: "conn_2" };

type PostOptions = {
  source?: { connector: string; instance: string };
  network?: string;
  kind?: "post" | "reply" | "mention";
  self?: boolean;
  text?: string;
  at?: string;
  counts?: Record<string, number>;
  replyTo?: string;
  handle?: string;
  author?: string;
  url?: string;
};

/** A social entry like the Instagram post vector, with what a test changes. */
export function post(id: string, o: PostOptions = {}): Item {
  const base = vector("entry-social-post") as Item & { raw: Record<string, unknown> };
  const source = o.source ?? IG;
  const at = o.at ?? "2026-11-20T09:00:00Z";
  const text = o.text ?? `Post ${id}`;
  const raw: Record<string, unknown> = {
    network: o.network ?? (source === RD ? "reddit" : "instagram"),
    account: source.instance,
    postKind: o.kind ?? "post",
    handle: o.handle ?? (o.self === false ? "fan" : "studio"),
    authorName: o.author ?? (o.self === false ? "A fan" : "Studio"),
    self: o.self ?? true,
    media: [],
    ...(o.replyTo ? { replyTo: o.replyTo } : {}),
    ...(o.counts ?? {}),
  };
  return {
    ...base,
    id,
    source,
    title: text.split("\n")[0] ?? text,
    body: text,
    url: o.url ?? `https://example.com/${id}`,
    feed: source === RD ? "Studio on Reddit" : "Studio on Instagram",
    publishedAt: at,
    updatedAt: at,
    raw,
  } as Item;
}

/** The two networks' items: posts, a reply each way, a mention, the account and its numbers. */
export function sample(): Item[] {
  const reach = {
    ...vector("metric-social-followers"),
    id: "reach",
    title: "reach",
    series: "reach",
  };
  return [
    vector("entry-social-post"),
    vector("entry-social-reply"),
    vector("record-social-account"),
    vector("metric-social-followers"),
    reach as Item,
    post("t3_k1", {
      source: RD,
      text: "Our studio tour\nCome see the shop.",
      at: "2026-11-21T09:00:00Z",
      counts: { likes: 30, replies: 2 },
    }),
    post("c1", {
      self: false,
      kind: "reply",
      replyTo: "18011",
      text: "Love the green one",
      at: "2026-11-20T12:00:00Z",
      counts: { likes: 1 },
    }),
    post("t1_m1", {
      source: RD,
      self: false,
      kind: "mention",
      text: "u/studio_team made this",
      at: "2026-11-22T08:00:00Z",
    }),
  ];
}

const instance = (
  source: { connector: string; instance: string },
  title: string,
  status: ConnectorInstance["status"] = { state: "connected" },
): ConnectorInstance => ({ ...source, title, status });

/** endue.social as connector.list answers it, with these instances. */
export function social(instances: ConnectorInstance[]): ConnectorInfo {
  return {
    id: "endue.social",
    title: "Social networks",
    instances,
    resources: [
      {
        kind: "entry",
        actions: [
          "endue.social.post.publish",
          "endue.social.post.reply",
          "endue.social.post.delete",
        ],
      },
      { kind: "record" },
      { kind: "metric" },
    ],
  };
}
export const ACCOUNTS = () => [
  instance(IG, "Studio on Instagram"),
  instance(RD, "Studio on Reddit"),
];
export { instance };

export const GRANTS: Permission[] = [
  { permission: "data:read", kinds: ["entry", "metric", "record"] },
  { permission: "cmd:invoke", ids: ["desk.connectors.open"] },
  { permission: "shell:open", schemes: ["https"] },
  { permission: "connector:manage" },
];

type MountOptions = {
  items?: Item[];
  instances?: ConnectorInstance[];
  store?: Record<string, unknown>;
  language?: "en" | "ko";
};

export async function mount(options: MountOptions = {}) {
  const html = readFileSync(join(here, "../ui/index.html"), "utf8");
  document.documentElement.innerHTML = new DOMParser()
    .parseFromString(html, "text/html")
    .documentElement.innerHTML.replace(/<script[\s\S]*?<\/script>/g, "");
  const store = options.store ?? {};
  const opened: string[] = [];
  const connectorsOpened: unknown[] = [];
  const host: TestHost = createTestHost({
    pluginId: "endue.social-studio",
    handlers: {
      "connector.list": () => ({ connectors: [social(options.instances ?? ACCOUNTS())] }),
      "store.get": ({ key }) => (key in store ? { value: store[key] } : {}),
      "store.set": ({ key, value }) => {
        store[key] = value;
        return {};
      },
      "shell.open": ({ target }) => {
        opened.push(target);
        return { opened: true };
      },
    },
    commands: {
      "desk.connectors.open": (args) => {
        connectorsOpened.push(args);
        return {};
      },
    },
    manifestCommands: manifest().contributes.commands,
    grants: GRANTS,
    language: options.language ?? "en",
    messages: { folder: "messages", catalogs: { en: catalog("en"), ko: catalog("ko") } },
  });
  for (const item of options.items ?? sample()) host.upsert(item);
  let mounted: Awaited<ReturnType<typeof mountStudio>> | undefined;
  await defineUiPlugin(
    {
      async mount(ctx) {
        mounted = await mountStudio(ctx, document, { zone: "UTC" });
      },
    },
    host.transport,
  );
  const settle = async () => {
    for (let i = 0; i < 6; i++) await host.settle();
    await new Promise((resolve) => setTimeout(resolve, 5));
    for (let i = 0; i < 4; i++) await host.settle();
  };
  await settle();
  if (!mounted) throw new Error("the plugin did not mount");
  const $ = <T extends Element = HTMLElement>(selector: string) =>
    document.querySelector<T>(selector);
  const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)];
  return {
    host,
    store,
    opened,
    connectorsOpened,
    settle,
    page: mounted.page,
    $,
    $$,
    /** The rows of the list now, as `who: text`. */
    rows: () =>
      $$("#list .row").map(
        (r) =>
          `${r.querySelector(".row-who")?.textContent}: ${r.querySelector(".row-text")?.textContent}`,
      ),
    key: (key: string, target: EventTarget = document.body) =>
      target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })),
  };
}
