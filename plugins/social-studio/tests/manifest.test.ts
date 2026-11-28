import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import type { PluginManifest } from "../../../packages/bridge/src/index";
import { lintPlugin } from "../../../scripts/ui-lint.mjs";

const root = join(import.meta.dirname, "../../..");
const folder = join(root, "plugins/social-studio");
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const manifest = () => readJson(join(folder, "plugin.json")) as PluginManifest;

function manifestValidator() {
  const ajv = new Ajv2020({ strict: true, allErrors: true, validateFormats: false });
  for (const spec of ["plugin/v0", "item/v0", "view/v0", "connector/v0"]) {
    const dir = join(root, "specs", spec);
    for (const name of readdirSync(dir)
      .filter((n) => n.endsWith(".schema.json"))
      .sort())
      ajv.addSchema(readJson(join(dir, name)) as object);
  }
  const validate = ajv.getSchema("https://endue.ai/specs/plugin/v0/plugin.schema.json");
  if (!validate) throw new Error("cannot compile plugin.schema.json");
  return validate;
}

/** Every message id the code reads: t("id") and t(`prefix.${…}`) for the prefixes it builds. */
function idsRead(): string[] {
  const ui = join(folder, "ui");
  const code = readdirSync(ui)
    .filter((n) => n.endsWith(".js"))
    .map((n) => readFileSync(join(ui, n), "utf8"))
    .join("\n");
  const plain = [...code.matchAll(/\bt\("([a-zA-Z.]+)"/g)].map((m) => m[1] ?? "");
  const built = {
    "views.": ["feed", "replies", "numbers"],
    "state.": ["connected", "syncing", "stale", "error", "paused"],
    "count.": ["likes", "replies", "reposts", "views"],
    "media.": ["image", "video", "link", "other"],
    "empty.": ["feed", "replies", "numbers"],
    "series.": ["followers", "reach", "engagement"],
  };
  return [
    ...new Set([...plain, ...Object.entries(built).flatMap(([p, ids]) => ids.map((i) => p + i))]),
  ];
}

describe("plugin.json", () => {
  it("is a UI plugin that reads social items, opens Connections and https links", () => {
    const validate = manifestValidator();
    const studio = manifest();
    expect(validate(studio), JSON.stringify(validate.errors)).toBe(true);
    expect(studio).toMatchObject({
      id: "endue.social-studio",
      kind: "ui",
      entry: "ui/index.html",
      messages: "messages",
    });
    expect(existsSync(join(folder, studio.entry ?? "missing"))).toBe(true);
    expect(studio.permissions).toEqual([
      { permission: "data:read", kinds: ["entry", "metric", "record"] },
      // The empty state's Open Connections.
      { permission: "cmd:invoke", ids: ["desk.connectors.open"] },
      // A post opens on its network.
      { permission: "shell:open", schemes: ["https"] },
      // connector.list: the accounts and their state.
      { permission: "connector:manage" },
    ]);
  });

  it("lets an agent read without changing anything, and show a post", () => {
    const commands = manifest().contributes?.commands ?? [];
    expect(commands.map((c) => c.id)).toEqual(
      ["open", "view", "accounts", "posts", "replies", "numbers", "show"].map(
        (id) => `endue.social-studio.${id}`,
      ),
    );
    const agent = commands.filter((c) => c.agent);
    expect(agent.filter((c) => !c.readOnly).map((c) => c.id)).toEqual(["endue.social-studio.show"]);
    expect(commands.some((c) => c.irreversible)).toBe(false);
  });

  it("has every word it reads in English and Korean", () => {
    const en = readJson(join(folder, "messages/en.json")) as Record<string, unknown>;
    const ko = readJson(join(folder, "messages/ko.json")) as Record<string, unknown>;
    for (const id of idsRead()) {
      expect(en[id], id).toBeDefined();
      expect(ko[id], id).toBeDefined();
    }
    expect(Object.keys(ko).sort()).toEqual(Object.keys(en).sort());
    expect(ko.title).toBe("SNS 스튜디오");
  });

  it("reads every colour, font, size, radius and duration from the theme", () => {
    expect(lintPlugin("social-studio")).toEqual([]);
  });

  it("keeps every file under 400 lines and the README under 40", () => {
    for (const name of readdirSync(join(folder, "ui"))) {
      const lines = readFileSync(join(folder, "ui", name), "utf8").split("\n").length;
      expect(lines, name).toBeLessThanOrEqual(400);
    }
    expect(
      readFileSync(join(folder, "README.md"), "utf8").trimEnd().split("\n").length,
    ).toBeLessThanOrEqual(40);
  });
});
