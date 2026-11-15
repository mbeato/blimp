// Visuals (docs/superpowers/specs/2026-10-26-visuals-design.md, 2026-11-15-visuals-3d-design.md): pages a session
// showed with blimp's show tool (visuals/mcp.ts). Each is a copy as it was then: a folder, <socket dir>/visuals/<id>/,
// with the page as index.html and the files it came with (a model, a photo), and <id>.json beside it saying what it
// is. Kept 30 days and at most 2 GB in all, so a card shows what you were shown even after the files change. Copies
// from before visuals could be folders are <id>.html. The visual key, which reads only /visuals/<key>/...
// (server.ts), comes from a token.

import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, sep } from "node:path";
import { guardFile, HttpError } from "../files";
import { blimpDir } from "../sessions";

export type Visual = { id: string; title: string; session: string; dir: string; source: string; at: number };

export const MAX_PAGE = 2 * 1024 * 1024;
export const MAX_FOLDER = 100 * 1024 * 1024;
export const MAX_FILES = 500;
export const MAX_KEPT = 2 * 1024 ** 3;
export const MAX_TITLE = 80;
export const KEEP_MS = 30 * 24 * 3600 * 1000;
export const PAGE = "index.html";

export const isVisualId = (id: string) => /^[0-9a-f]{12}$/.test(id);
export const visualsDir = () => join(blimpDir(), "visuals");

const utf8 = (b: Buffer) => {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(b);
    return true;
  } catch {
    return false;
  }
};

const mb = (bytes: number) => (bytes / 1048576).toFixed(1);

type Part = { rel: string; from: string; size: number };

// Every file in a folder and under it, by its path from the folder. Names that start with a dot are skipped (.git,
// .DS_Store). A symlink is refused, as is anything guardFile refuses and a top-level kit (blimp's own).
function folderParts(root: string, name: string): Part[] {
  const parts: Part[] = [];
  let bytes = 0;
  const walk = (dir: string, under: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.name.startsWith(".")) continue;
      const rel = under ? `${under}/${e.name}` : e.name;
      if (e.isSymbolicLink()) throw new HttpError(400, `a link can't be shown, only files: ${rel}`);
      if (!under && e.name === "kit") throw new HttpError(400, "the folder has its own kit: that name is blimp's, so call yours something else");
      if (e.isDirectory()) {
        walk(join(dir, e.name), rel);
        continue;
      }
      if (!e.isFile()) continue;
      const from = guardFile(join(dir, e.name));
      const size = statSync(from).size;
      bytes += size;
      parts.push({ rel, from, size });
      if (parts.length > MAX_FILES) throw new HttpError(413, `the folder has over ${MAX_FILES} files: show a folder with only what the page loads`);
      if (bytes > MAX_FOLDER) throw new HttpError(413, `the folder is over ${MAX_FOLDER / 1048576} MB: show a folder with only what the page loads`);
    }
  };
  walk(root, "");
  if (!parts.some((p) => p.rel === PAGE)) throw new HttpError(400, `no ${PAGE} in ${name}: a folder's page is its ${PAGE}`);
  return parts;
}

// The page at path, or the folder at path with its page as index.html (absolute, or relative to dir, the session's
// folder), for session, copied. Under home and never one of blimp's own files, as every file route's are (guardFile).
export function makeVisual(session: string, dir: string, path: string, title: string, now = Date.now()): Visual {
  const name = title.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (!name) throw new HttpError(400, "a title is required");
  if (name.length > MAX_TITLE) throw new HttpError(400, `the title must be at most ${MAX_TITLE} characters`);
  const source = guardFile(isAbsolute(path) ? path : join(dir, path));
  let parts: Part[];
  try {
    const st = statSync(source);
    if (st.isDirectory()) parts = folderParts(source, path);
    else if (st.isFile()) parts = [{ rel: PAGE, from: source, size: st.size }];
    else throw new HttpError(400, `not a file or a folder: ${path}`);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(404, `no such file: ${path}`);
  }
  const page = parts.find((p) => p.rel === PAGE)!;
  if (page.size > MAX_PAGE) throw new HttpError(413, `the page is ${mb(page.size)} MB, over 2 MB: draw data with the kit, and keep big files beside the page in its folder`);
  if (!utf8(readFileSync(page.from))) throw new HttpError(400, "the page isn't UTF-8 text");
  const v: Visual = { id: randomBytes(6).toString("hex"), title: name, session, dir, source, at: now };
  const copy = join(visualsDir(), v.id);
  mkdirSync(copy, { recursive: true, mode: 0o700 });
  try {
    for (const p of parts) {
      const to = join(copy, p.rel);
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
      copyFileSync(p.from, to);
      chmodSync(to, 0o600);
    }
  } catch (e) {
    rmSync(copy, { recursive: true, force: true });
    throw new HttpError(500, `the copy failed: ${(e as Error).message}`);
  }
  writeFileSync(join(visualsDir(), `${v.id}.json`), JSON.stringify(v) + "\n", { mode: 0o600 });
  trimVisuals(v.id);
  return v;
}

// Where a copy's page is: in its folder, or the one file an earlier blimpd kept.
const pagePath = (id: string) => [join(visualsDir(), id, PAGE), join(visualsDir(), `${id}.html`)].find((p) => existsSync(p));

export function visualPage(id: string): Buffer | undefined {
  if (!isVisualId(id)) return;
  try {
    const p = pagePath(id);
    return p ? readFileSync(p) : undefined;
  } catch {}
}

// A file of a copy by its path from the page, or nothing: for a path that leaves the copy's folder, a folder, a
// link, or a name that isn't there.
export function visualFile(id: string, rel: string): string | undefined {
  if (!isVisualId(id) || !rel || rel.includes("\0")) return;
  const root = join(visualsDir(), id);
  const p = join(root, rel);
  if (!p.startsWith(root + sep)) return;
  try {
    return lstatSync(p).isFile() ? p : undefined;
  } catch {}
}

export const isKept = (id: string) => isVisualId(id) && !!pagePath(id);

// What's kept, one per id: its files' size and when it was made (its newest entry's time).
function kept(): { id: string; bytes: number; at: number }[] {
  let names: string[];
  try {
    names = readdirSync(visualsDir());
  } catch {
    return [];
  }
  const size = (p: string): number => {
    const st = lstatSync(p);
    return st.isDirectory() ? readdirSync(p).reduce((n, e) => n + size(join(p, e)), 0) : st.size;
  };
  const all = new Map<string, { id: string; bytes: number; at: number }>();
  for (const n of names) {
    const id = n.replace(/\.(html|json)$/, "");
    const v = all.get(id) ?? { id, bytes: 0, at: 0 };
    try {
      v.bytes += size(join(visualsDir(), n));
      v.at = Math.max(v.at, statSync(join(visualsDir(), n)).mtimeMs);
    } catch {}
    all.set(id, v);
  }
  return [...all.values()];
}

const drop = (id: string) => {
  for (const n of [id, `${id}.html`, `${id}.json`]) rmSync(join(visualsDir(), n), { recursive: true, force: true });
};

// Over 2 GB in all, the oldest copies go first, never the one just made.
export function trimVisuals(keep?: string, max = MAX_KEPT) {
  const all = kept().sort((a, b) => a.at - b.at);
  let total = all.reduce((n, v) => n + v.bytes, 0);
  for (const v of all) {
    if (total <= max) return;
    if (v.id === keep) continue;
    drop(v.id);
    total -= v.bytes;
  }
}

// Copies made over 30 days ago go, then the oldest of what's over 2 GB: when blimpd starts, and once a day (server.ts).
export function cleanVisuals(now = Date.now()) {
  for (const v of kept()) if (now - v.at > KEEP_MS) drop(v.id);
  trimVisuals();
}

// HMAC-SHA256 of a token (the Mac's or the phone's) with the text "blimp visuals", hex. No token: none.
export const visualKey = (token: string) => (token ? createHmac("sha256", token).update("blimp visuals").digest("hex") : "");
