// Visuals (docs/superpowers/specs/2026-10-26-visuals-design.md): pages a session showed with blimp's show tool
// (visuals/mcp.ts). Each is a copy of the page as it was then, <socket dir>/visuals/<id>.html, with <id>.json saying
// what it is, kept 30 days, so a card shows what you were shown even after the file changes. The visual key, which
// reads only /visuals/<key>/... (server.ts), comes from a token.

import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { guardFile, HttpError } from "../files";
import { blimpDir } from "../sessions";

export type Visual = { id: string; title: string; session: string; dir: string; source: string; at: number };

export const MAX_PAGE = 2 * 1024 * 1024;
export const MAX_TITLE = 80;
export const KEEP_MS = 30 * 24 * 3600 * 1000;

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

// The page at path (absolute, or relative to dir, the session's folder) for session, copied. Under home and never
// one of blimp's own files, as every file route's are (guardFile).
export function makeVisual(session: string, dir: string, path: string, title: string, now = Date.now()): Visual {
  const name = title.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (!name) throw new HttpError(400, "a title is required");
  if (name.length > MAX_TITLE) throw new HttpError(400, `the title must be at most ${MAX_TITLE} characters`);
  const source = guardFile(isAbsolute(path) ? path : join(dir, path));
  let size: number;
  try {
    const st = statSync(source);
    if (!st.isFile()) throw new HttpError(400, `not a file: ${path}`);
    size = st.size;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(404, `no such file: ${path}`);
  }
  if (size > MAX_PAGE) throw new HttpError(413, `the page is ${(size / 1048576).toFixed(1)} MB, over 2 MB: draw data with the kit, not big images`);
  const bytes = readFileSync(source);
  if (!utf8(bytes)) throw new HttpError(400, "the page isn't UTF-8 text");
  const v: Visual = { id: randomBytes(6).toString("hex"), title: name, session, dir, source, at: now };
  mkdirSync(visualsDir(), { recursive: true, mode: 0o700 });
  writeFileSync(join(visualsDir(), `${v.id}.html`), bytes, { mode: 0o600 });
  writeFileSync(join(visualsDir(), `${v.id}.json`), JSON.stringify(v) + "\n", { mode: 0o600 });
  return v;
}

export function visualPage(id: string): Buffer | undefined {
  if (!isVisualId(id)) return;
  try {
    return readFileSync(join(visualsDir(), `${id}.html`));
  } catch {}
}

export const isKept = (id: string) => isVisualId(id) && existsSync(join(visualsDir(), `${id}.html`));

// Copies written over 30 days ago go: when blimpd starts, and once a day (server.ts).
export function cleanVisuals(now = Date.now()) {
  let names: string[];
  try {
    names = readdirSync(visualsDir());
  } catch {
    return;
  }
  for (const n of names) {
    const p = join(visualsDir(), n);
    try {
      if (now - statSync(p).mtimeMs > KEEP_MS) rmSync(p, { force: true });
    } catch {}
  }
}

// HMAC-SHA256 of a token (the Mac's or the phone's) with the text "blimp visuals", hex. No token: none.
export const visualKey = (token: string) => (token ? createHmac("sha256", token).update("blimp visuals").digest("hex") : "");
