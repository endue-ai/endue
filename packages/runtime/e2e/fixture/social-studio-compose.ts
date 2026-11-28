// Test page: endue.social-studio's Drafts view on the browser stub. Three accounts of endue.social
// with their records' capabilities (Instagram needs a picture, Threads takes 500 characters,
// Reddit is signed out), drafts kept in memory as files, a picked picture, a key that may not
// publish until the account lets it, and the social commands answered here: Threads refuses its
// first post. Never shipped.
import type { ConnectorInstance, Item, PluginManifest } from "@endue-ai/bridge";
import studioManifest from "../../../../plugins/social-studio/plugin.json";
import "../../src/desk.css";
import { StubError } from "@endue-ai/bridge";
import { browserCore } from "../../src/bridge/core";
import { createRuntime, ManualClock } from "../../src/index";

const manifests = import.meta.glob<PluginManifest>("../../../../plugins/*/plugin.json", {
  eager: true,
  import: "default",
});
const policies = Object.values(manifests).filter(
  (m) => m.id.startsWith("desk.") && m.id !== "desk.shell" && m.kind === "policy",
);

const SOCIAL = "endue.social";
const ACCOUNTS = [
  { instance: "conn_ig", network: "instagram", title: "Studio on Instagram" },
  { instance: "conn_th", network: "threads", title: "Studio on Threads" },
  { instance: "conn_rd", network: "reddit", title: "Studio on Reddit" },
];
const CAPABILITIES: Record<string, unknown> = {
  instagram: {
    text: { max: 2200, required: false },
    title: false,
    media: {
      image: { max_count: 10, max_bytes: 8388608, types: ["image/jpeg", "image/png"] },
      video: { max_count: 1, max_bytes: 104857600, types: ["video/mp4"] },
      required: true,
    },
    reply: true,
    delete_post: false,
    delete_comment: true,
  },
  threads: {
    text: { max: 500, required: false },
    title: false,
    media: {
      image: { max_count: 10, max_bytes: 8388608, types: ["image/jpeg", "image/png"] },
      video: false,
      required: false,
    },
    reply: true,
    delete_post: true,
    delete_comment: true,
  },
  reddit: {
    text: { max: 40000, required: false },
    title: { max: 300, required: true },
    media: { image: { max_count: 1, types: ["image/jpeg", "image/png"] }, video: false },
    reply: true,
    delete_post: true,
    delete_comment: true,
  },
};
const source = (instance: string) => ({ connector: SOCIAL, instance });
const at = (day: number) => new Date(Date.UTC(2026, 10, day, 9)).toISOString();

const items: Item[] = ACCOUNTS.flatMap((a, i) => [
  {
    id: `${a.instance}-account`,
    source: source(a.instance),
    kind: "record",
    title: a.title,
    updatedAt: at(29),
    raw: { network: a.network, account: a.instance },
    fields: { network: a.network, capabilities: CAPABILITIES[a.network] },
  } as unknown as Item,
  {
    id: `${a.instance}-p1`,
    source: source(a.instance),
    kind: "entry",
    title: "Fabric samples are back in stock.",
    body: "Fabric samples are back in stock.",
    url: `https://${a.network}.example/p/${i}`,
    feed: a.title,
    publishedAt: at(20 + i),
    updatedAt: at(20 + i),
    raw: {
      network: a.network,
      account: a.instance,
      postKind: "post",
      handle: "studio",
      authorName: "Studio",
      self: true,
      media: [],
      likes: 10 + i,
    },
  } as unknown as Item,
]);

const instances: ConnectorInstance[] = ACCOUNTS.map((a) => ({
  ...source(a.instance),
  title: a.title,
  status:
    a.network === "reddit"
      ? { state: "error", error: { message: "Signed out of Reddit.", reauth: true } }
      : { state: "connected", lastSyncAt: at(29) },
}));

/** The drafts folder and the picture the person picks, in memory. */
const files = new Map<string, string>([["~/Pictures/jacket.jpg", "JPEG bytes"]]);
const under = (dir: string) => [...files.keys()].filter((p) => p.startsWith(`${dir}/`));
let may = ["read"];

const clock = new ManualClock();
const core = browserCore({
  manifests: [...policies, studioManifest as PluginManifest],
  open: () => {},
  ask: () => ({ text: "Fabric samples are back: moss, rust and slate. Come by the shop." }),
  handlers: {
    "connector.list": () => ({
      connectors: [
        {
          id: SOCIAL,
          title: "Social networks",
          instances,
          resources: [
            { kind: "entry", actions: [`${SOCIAL}.post.publish`] },
            { kind: "record" },
            { kind: "metric" },
          ],
        },
      ],
    }),
    "fs.list": ({ path }) => {
      const entries = new Map<string, { name: string; kind: "dir" | "file"; size?: number }>();
      for (const p of under(path)) {
        const [name, ...deeper] = p.slice(path.length + 1).split("/");
        if (!name) continue;
        const size = files.get(p)?.length ?? 0;
        entries.set(name, deeper.length ? { name, kind: "dir" } : { name, kind: "file", size });
      }
      if (entries.size === 0) throw new StubError("not_found", `${path} does not exist`);
      return { entries: [...entries.values()] } as never;
    },
    "fs.read": ({ path }) => {
      const content = files.get(path);
      if (content === undefined) throw new StubError("not_found", `${path} does not exist`);
      return { content, encoding: "utf8" } as never;
    },
    "fs.write": ({ path, content }) => {
      files.set(path, String(content));
      return {} as never;
    },
    "fs.mkdir": () => ({}) as never,
    "fs.copy": ({ from, to }) => {
      files.set(to, files.get(from) ?? "");
      return {} as never;
    },
    "fs.trash": ({ path }) => {
      for (const p of under(path)) files.delete(p);
      return {} as never;
    },
    "dialog.open": () => ({ cancelled: false, paths: ["~/Pictures/jacket.jpg"] }),
    "account.connectors.status": () => ({ enabled: true, may, connectors: [] }) as never,
    "account.connectors.enable": () => {
      may = ["read", "publish", "delete"];
      return { enabled: true, may, connectors: [] } as never;
    },
  },
});
for (const item of items) core.upsert(item);

/** The social commands, answered as endue would: Threads refuses its first post. */
let threadsRefused = false;
core.client.onEvent((event) => {
  if (event.event !== "cmd.invoked" || !event.data.id.startsWith(`${SOCIAL}.post.`)) return;
  const { invocationId, args } = event.data;
  const instance = (args as { instance?: string } | undefined)?.instance;
  const answer =
    instance === "conn_th" && !threadsRefused
      ? { error: { code: "failed" as const, message: "Threads did not take the link: try again." } }
      : { result: { id: `${instance}-new`, url: `https://example.com/${instance}/new` } };
  if (instance === "conn_th") threadsRefused = true;
  void core.client.call("cmd.answer", { invocationId, ...answer }, { caller: SOCIAL });
});
for (const what of ["publish", "reply", "delete"])
  void core.client.call(
    "cmd.register",
    { id: `${SOCIAL}.post.${what}`, title: what },
    {
      caller: SOCIAL,
    },
  );

const runtime = createRuntime({
  root: document.getElementById("desk") as HTMLElement,
  bridge: core.client,
  clock,
  platform: "other",
  plugins: { url: (id, path, revision) => `/plugins/${id}/${path}?v=${revision}` },
});

window.__desk = { clock, runtime, stub: core.stub, commands: [] };
