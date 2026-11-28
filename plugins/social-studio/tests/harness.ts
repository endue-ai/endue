// Mounts Social Studio on the SDK's test host over jsdom: the page from ui/index.html, the
// plugin's catalogs, and an index holding the social item vectors of specs/item/v0 (Instagram on
// conn_1, Reddit on conn_2) and whatever a test adds. connector.list answers the two accounts of
// endue.social; store.* keeps what the studio saves, so a remount reads it back.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AccountConnectorPower,
  type ConnectorInfo,
  type ConnectorInstance,
  type Item,
  type MessageCatalog,
  type Permission,
  StubError,
  type StubHandlers,
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
  {
    permission: "cmd:invoke",
    ids: ["desk.connectors.open", "*.post.publish", "*.post.reply", "*.post.delete"],
  },
  { permission: "shell:open", schemes: ["https"] },
  { permission: "connector:manage" },
  { permission: "brain:ask" },
  { permission: "account:manage" },
];

type MountOptions = {
  items?: Item[];
  instances?: ConnectorInstance[];
  store?: Record<string, unknown>;
  language?: "en" | "ko";
  /** Files by path, kept between mounts when the same object is passed again. */
  files?: Map<string, string>;
  /** What dialog.open answers: the files the person picks. */
  picked?: string[];
  /** What the key may do, and what it may after account.connectors.enable (null: refused). */
  may?: AccountConnectorPower[];
  enabled?: AccountConnectorPower[] | null;
  /** The social commands' answers by command id; a throw is the network's refusal. */
  answers?: Record<string, (args: Record<string, unknown>) => unknown>;
  /** The brain's answer to writing help. */
  suggestion?: string;
  settings?: Record<string, unknown>;
  refuse?: Parameters<typeof createTestHost>[0]["refuse"];
};

/** The drafts folder in memory: fs.list, read, write, mkdir, copy and trash as the core does. */
function memoryFiles(files: Map<string, string>, trashed: string[]) {
  const under = (dir: string) => [...files.keys()].filter((p) => p.startsWith(`${dir}/`));
  return {
    "fs.list": ({ path }: { path: string }) => {
      const names = new Map<string, { name: string; kind: string; size?: number }>();
      for (const p of under(path)) {
        const [name, ...deeper] = p.slice(path.length + 1).split("/");
        if (!name) continue;
        const size = files.get(p)?.length ?? 0;
        names.set(name, deeper.length > 0 ? { name, kind: "dir" } : { name, kind: "file", size });
      }
      if (names.size === 0 && !files.has(`${path}/`))
        throw new StubError("not_found", `${path} does not exist`);
      return { entries: [...names.values()] };
    },
    "fs.read": ({ path }: { path: string }) => {
      const content = files.get(path);
      if (content === undefined) throw new StubError("not_found", `${path} does not exist`);
      return { content, encoding: "utf8" };
    },
    "fs.write": ({ path, content }: { path: string; content: string }) => {
      files.set(path, content);
      return {};
    },
    "fs.mkdir": ({ path }: { path: string }) => {
      if (under(path).length === 0) files.set(`${path}/`, "");
      return {};
    },
    "fs.copy": ({ from, to }: { from: string; to: string }) => {
      const content = files.get(from);
      if (content === undefined) throw new StubError("not_found", `${from} does not exist`);
      files.set(to, content);
      return {};
    },
    "fs.trash": ({ path }: { path: string }) => {
      for (const p of [...under(path), `${path}/`]) files.delete(p);
      trashed.push(path);
      return {};
    },
  };
}

export async function mount(options: MountOptions = {}) {
  const html = readFileSync(join(here, "../ui/index.html"), "utf8");
  document.documentElement.innerHTML = new DOMParser()
    .parseFromString(html, "text/html")
    .documentElement.innerHTML.replace(/<script[\s\S]*?<\/script>/g, "");
  const store = options.store ?? {};
  const opened: string[] = [];
  const connectorsOpened: unknown[] = [];
  const files = options.files ?? new Map<string, string>();
  const trashed: string[] = [];
  /** The social commands invoked, in order. */
  const invoked: { id: string; args: Record<string, unknown> }[] = [];
  const enabled: unknown[] = [];
  const asked: string[] = [];
  let may: AccountConnectorPower[] = options.may ?? ["read", "publish", "delete"];
  const socialCommand = (id: string) => (args: unknown) => {
    const a = args as Record<string, unknown>;
    invoked.push({ id, args: a });
    const answer = options.answers?.[id];
    return answer
      ? answer(a)
      : { id: `p${invoked.length}`, url: `https://example.com/p${invoked.length}` };
  };
  const turns: string[] = [];
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
      ...(memoryFiles(files, trashed) as unknown as StubHandlers),
      "dialog.open": () =>
        options.picked
          ? { cancelled: false, paths: options.picked }
          : { cancelled: true, paths: [] },
      "account.connectors.status": () => ({ enabled: true, may, connectors: [] }),
      "account.connectors.enable": ({ allow }) => {
        enabled.push(allow);
        if (options.enabled === null)
          return { enabled: true, may, connectors: [], problem: "Not now." };
        may = options.enabled ?? [...may, ...(allow ?? [])];
        return { enabled: true, may, connectors: [] };
      },
      "brain.ask": ({ prompt }) => {
        asked.push(prompt);
        const turnId = `turn_${asked.length}`;
        turns.push(turnId);
        return { turnId };
      },
    },
    commands: {
      "desk.connectors.open": (args) => {
        connectorsOpened.push(args);
        return {};
      },
      "endue.social.post.publish": socialCommand("endue.social.post.publish"),
      "endue.social.post.reply": socialCommand("endue.social.post.reply"),
      "endue.social.post.delete": socialCommand("endue.social.post.delete"),
    },
    settings: options.settings ?? {},
    ...(options.refuse ? { refuse: options.refuse } : {}),
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
  /** The brain answers the last writing help it was asked for. */
  const answerHelp = (text = options.suggestion ?? "") => {
    host.emit({
      event: "brain.turn",
      data: { turnId: turns.at(-1), kind: "completed", text: "", structured: { text } },
    } as never);
  };
  return {
    host,
    store,
    opened,
    connectorsOpened,
    files,
    trashed,
    invoked,
    enabled,
    asked,
    answerHelp,
    writer: mounted.writer,
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
