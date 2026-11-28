// Test page: endue.social-studio (plugins/social-studio) over the desk.* policies on the browser
// stub, with an index holding the social profile (specs/connector/v0 README, Social profile) for
// three accounts of endue.social: Instagram and Threads connected, Reddit signed out. Never shipped.
import type { ConnectorInstance, Item, PluginManifest } from "@endue-ai/bridge";
import studioManifest from "../../../../plugins/social-studio/plugin.json";
import "../../src/desk.css";
import { browserCore } from "../../src/bridge/core";
import { createRuntime, ManualClock } from "../../src/index";

const manifests = import.meta.glob<PluginManifest>("../../../../plugins/*/plugin.json", {
  eager: true,
  import: "default",
});
const policies = Object.values(manifests).filter(
  (m) => m.id.startsWith("desk.") && m.id !== "desk.shell" && m.kind === "policy",
);

const ACCOUNTS = [
  { instance: "conn_ig", network: "instagram", title: "Studio on Instagram", handle: "studio" },
  { instance: "conn_th", network: "threads", title: "Studio on Threads", handle: "studio" },
  { instance: "conn_rd", network: "reddit", title: "Studio on Reddit", handle: "studio_team" },
];
const source = (instance: string) => ({ connector: "endue.social", instance });
const at = (day: number, hour = 9) => new Date(Date.UTC(2026, 10, day, hour)).toISOString();

type Post = {
  id: string;
  account: number;
  text: string;
  day: number;
  hour?: number;
  kind?: "post" | "reply" | "mention";
  self?: boolean;
  replyTo?: string;
  author?: [string, string];
  counts?: Record<string, number>;
  media?: Array<{ kind: string; alt?: string }>;
};
const POSTS: Post[] = [
  {
    id: "ig1",
    account: 0,
    day: 27,
    text: "Autumn drop\nNew colors in the shop today: moss, rust and slate.",
    counts: { likes: 128, replies: 14 },
    media: [{ kind: "image", alt: "Three jackets on a rail" }],
  },
  {
    id: "ig2",
    account: 0,
    day: 24,
    text: "Behind the seams: how a jacket comes together in our studio.",
    counts: { likes: 86, replies: 6 },
    media: [{ kind: "video" }],
  },
  {
    id: "th1",
    account: 1,
    day: 28,
    text: "We are opening a second workshop next month. Ask us anything.",
    counts: { likes: 42, replies: 19, reposts: 5 },
  },
  {
    id: "th2",
    account: 1,
    day: 22,
    text: "Fabric samples are back in stock.",
    counts: { likes: 17, replies: 2 },
  },
  {
    id: "rd1",
    account: 2,
    day: 26,
    text: "Our studio tour\nCome see the shop and the cutting tables.",
    counts: { likes: 301, replies: 48 },
  },
  {
    id: "c1",
    account: 0,
    day: 27,
    hour: 14,
    kind: "reply",
    self: false,
    replyTo: "ig1",
    author: ["mira.k", "Mira K."],
    text: "The moss one is perfect. Do you ship to Busan?",
    counts: { likes: 3 },
  },
  {
    id: "c2",
    account: 1,
    day: 28,
    hour: 11,
    kind: "reply",
    self: false,
    replyTo: "th1",
    author: ["leo_makes", "Leo"],
    text: "Will the new workshop take visitors?",
  },
  {
    id: "m1",
    account: 2,
    day: 28,
    hour: 8,
    kind: "mention",
    self: false,
    author: ["sewing_daily", "Sewing Daily"],
    text: "u/studio_team made the jacket in this thread, worth a look.",
  },
  {
    id: "c3",
    account: 0,
    day: 25,
    kind: "reply",
    self: false,
    replyTo: "ig2",
    author: ["jun.h", "Jun"],
    text: "Love seeing the process!",
  },
];

const items: Item[] = POSTS.map((p) => {
  const a = ACCOUNTS[p.account] ?? ACCOUNTS[0];
  if (!a) throw new Error("no account");
  const self = p.self ?? true;
  return {
    id: p.id,
    source: source(a.instance),
    kind: "entry",
    title: p.text.split("\n")[0] ?? p.text,
    body: p.text,
    url: `https://${a.network}.example/p/${p.id}`,
    feed: a.title,
    publishedAt: at(p.day, p.hour),
    updatedAt: at(p.day, p.hour),
    raw: {
      network: a.network,
      account: a.instance,
      postKind: p.kind ?? "post",
      handle: self ? a.handle : (p.author?.[0] ?? ""),
      authorName: self ? "Studio" : (p.author?.[1] ?? ""),
      self,
      media: p.media ?? [],
      ...(p.replyTo ? { replyTo: p.replyTo } : {}),
      ...(p.counts ?? {}),
    },
  } as Item;
});
const series = (
  instance: string,
  network: string,
  metric: string,
  unit: string,
  from: number,
  step: number,
) =>
  ({
    id: metric,
    source: source(instance),
    kind: "metric",
    title: metric,
    series: metric,
    unit,
    points: Array.from({ length: 14 }, (_, i) => ({
      t: at(15 + i, 0),
      v: Math.round((from + step * i + (i % 3) * step * 0.6) * 1000) / 1000,
    })),
    updatedAt: at(29, 0),
    raw: { network, account: instance },
  }) as unknown as Item;
items.push(
  series("conn_ig", "instagram", "followers", "count", 1180, 9),
  series("conn_ig", "instagram", "reach", "count", 5200, 140),
  series("conn_ig", "instagram", "engagement", "ratio", 0.041, 0.0012),
  series("conn_th", "threads", "followers", "count", 640, 6),
);

const instances: ConnectorInstance[] = ACCOUNTS.map((a) => ({
  ...source(a.instance),
  title: a.title,
  status:
    a.network === "reddit"
      ? { state: "error", error: { message: "Signed out of Reddit.", reauth: true } }
      : { state: "connected", lastSyncAt: at(29, 0) },
}));

const clock = new ManualClock();
const core = browserCore({
  manifests: [...policies, studioManifest as PluginManifest],
  open: () => {},
  handlers: {
    "connector.list": () => ({
      connectors: [
        {
          id: "endue.social",
          title: "Social networks",
          instances,
          resources: [
            { kind: "entry", actions: ["endue.social.post.publish"] },
            { kind: "record" },
            { kind: "metric" },
          ],
        },
      ],
    }),
  },
});
for (const item of items) core.upsert(item);
const runtime = createRuntime({
  root: document.getElementById("desk") as HTMLElement,
  bridge: core.client,
  clock,
  platform: "other",
  plugins: { url: (id, path, revision) => `/plugins/${id}/${path}?v=${revision}` },
});

window.__desk = { clock, runtime, stub: core.stub, commands: [] };
