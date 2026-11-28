// Drafts are files: a folder each under ~/Documents/Social Studio/Drafts with the text as Markdown
// (post.md), the rest as draft.json (title, accounts, pictures and their alt text, how each account
// answered) and the pictures beside them, so a person can open, edit and keep them in git. Reads and
// writes go through the bridge (fs.*); removing a draft moves its folder to the trash (ADR 0125).
import { typeOf } from "./fit.js";

/**
 * @typedef {import("./fit.js").Medium} Medium
 * @typedef {{ state: "published", id?: string, url?: string }
 *   | { state: "failed" | "unknown", why: string }} Outcome
 * @typedef {{
 *   id: string, text: string, title: string, accounts: string[], media: Medium[],
 *   outcome: Record<string, Outcome>, created: string, updated: string,
 * }} Draft
 * @typedef {{ call(method: string, params: Record<string, unknown>): Promise<any> }} Bridge
 */

export const HOME = "~/Documents/Social Studio";
export const ROOT = `${HOME}/Drafts`;
export const READ = Object.freeze({ permission: "fs:read", paths: [`${HOME}/**`] });
export const WRITE = Object.freeze({ permission: "fs:write", paths: [`${HOME}/**`] });

const codeOf = (/** @type {unknown} */ e) =>
  String(/** @type {{ code?: unknown }} */ (e)?.code ?? "");
const strings = (/** @type {unknown} */ v) =>
  Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];

/** A draft read from its folder, with what is missing filled in. */
function draftOf(/** @type {string} */ id, /** @type {any} */ meta, /** @type {string} */ text) {
  const media = Array.isArray(meta?.media) ? meta.media : [];
  return /** @type {Draft} */ ({
    id,
    text,
    title: typeof meta?.title === "string" ? meta.title : "",
    accounts: strings(meta?.accounts),
    media: media
      .filter((/** @type {any} */ m) => typeof m?.file === "string")
      .map((/** @type {any} */ m) => ({
        file: m.file,
        alt: typeof m.alt === "string" ? m.alt : "",
        type: typeof m.type === "string" ? m.type : typeOf(m.file),
        size: typeof m.size === "number" ? m.size : 0,
      })),
    outcome: meta?.outcome && typeof meta.outcome === "object" ? meta.outcome : {},
    created: typeof meta?.created === "string" ? meta.created : "",
    updated: typeof meta?.updated === "string" ? meta.updated : "",
  });
}

/**
 * @param {Bridge} bridge
 * @param {{ now?: () => Date, random?: () => number }} [clock]
 */
export function createDrafts(bridge, clock = {}) {
  const now = clock.now ?? (() => new Date());
  const random = clock.random ?? Math.random;
  const folder = (/** @type {string} */ id) => `${ROOT}/${id}`;

  /** Every draft, the last changed first. A missing folder is no drafts yet. */
  async function list() {
    const answer = await bridge
      .call("fs.list", { path: ROOT, scope: READ })
      .catch((e) => (codeOf(e) === "not_found" ? { entries: [] } : Promise.reject(e)));
    const folders = answer.entries.filter((/** @type {any} */ e) => e.kind === "dir");
    const drafts = await Promise.all(
      folders.map((/** @type {any} */ e) => read(e.name).catch(() => undefined)),
    );
    return /** @type {Draft[]} */ (drafts.filter(Boolean)).sort((a, b) =>
      a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : a.id.localeCompare(b.id),
    );
  }

  /** @param {string} id */
  async function read(id) {
    const meta = await bridge.call("fs.read", { path: `${folder(id)}/draft.json`, scope: READ });
    const text = await bridge
      .call("fs.read", { path: `${folder(id)}/post.md`, scope: READ })
      .then((r) => String(r.content))
      .catch(() => "");
    return draftOf(id, JSON.parse(meta.content), text);
  }

  /** Write the draft's two files; its folder is made the first time. */
  async function save(/** @type {Draft} */ draft) {
    draft.updated = now().toISOString();
    const { id, text, ...meta } = draft;
    const json = `${JSON.stringify(meta, null, 2)}\n`;
    const write = (/** @type {string} */ name, /** @type {string} */ content) =>
      bridge.call("fs.write", {
        path: `${folder(id)}/${name}`,
        content,
        createDirs: true,
        scope: WRITE,
      });
    await write("post.md", text);
    await write("draft.json", json);
  }

  /** A new draft, not written yet: its id is when it was made and four random letters. */
  function create(/** @type {Partial<Draft>} */ init = {}) {
    const at = now();
    const stamp = at.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
    const tail = Math.floor(random() * 36 ** 4)
      .toString(36)
      .padStart(4, "0");
    return draftOf(`${stamp}-${tail}`, { created: at.toISOString(), ...init }, init.text ?? "");
  }

  /**
   * Copy a file the person chose into the draft's folder; the medium it becomes. A type endue AI
   * does not take is refused with its name.
   * @param {Draft} draft
   * @param {string} path
   */
  async function addMedium(draft, path) {
    const name = path.split("/").pop() ?? "picture";
    const type = typeOf(name);
    if (!type) throw Object.assign(new Error(name), { code: "unsupported_type" });
    const taken = new Set(draft.media.map((m) => m.file));
    let file = name;
    for (let n = 2; taken.has(file); n++) file = `${n}-${name}`;
    const to = `${folder(draft.id)}/${file}`;
    await bridge.call("fs.mkdir", { path: folder(draft.id), parents: true, scope: WRITE });
    await bridge.call("fs.copy", {
      from: path,
      to,
      scope: WRITE,
      fromScope: { permission: "fs:read", paths: [path] },
    });
    const listed = await bridge.call("fs.list", { path: folder(draft.id), scope: READ });
    const size = listed.entries.find((/** @type {any} */ e) => e.name === file)?.size ?? 0;
    /** @type {Medium} */
    const medium = { file, alt: "", type, size };
    draft.media.push(medium);
    return medium;
  }

  /** Move the draft's folder to the trash. */
  const remove = (/** @type {string} */ id) =>
    bridge.call("fs.trash", { path: folder(id), scope: WRITE });

  /** The path of a file of the draft, as the core reads it to upload it. */
  const pathOf = (/** @type {Draft} */ draft, /** @type {string} */ file) =>
    `${folder(draft.id)}/${file}`;

  return { list, read, save, create, addMedium, remove, pathOf };
}
