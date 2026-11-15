// Files an app hands to a session (docs/superpowers/specs/2026-11-15-phone-attach-design.md): a photo or a video
// from the phone's chat, saved in ~/.blimp/uploads, where the Mac's drop on a terminal puts its files too
// (TerminalPane.tsx). The file's path then goes to the session with the message (chatsocket.ts), and Claude Code
// attaches a picture it is given the path of. Kept 30 days.

import { lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { guardFile, HttpError, realHome, upload } from "./files";

export const KEEP_MS = 30 * 24 * 3600 * 1000;
export const MAX_FILES = 10;

export const uploadsDir = (home = realHome()) => join(home, ".blimp", "uploads");

// A name that is one plain word in a terminal, as the Mac's drop makes it (transfers.ts): no spaces, quotes or
// shell characters, and no folder.
export const plainName = (name: string) => name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+/, "").slice(-120) || "file";

// name, then name-2, name-3 before its ending, for the nth try.
const numbered = (name: string, n: number) => {
  if (n < 2) return name;
  const [, stem, ext = ""] = name.match(/^(.+?)(\.[^.]+)?$/)!;
  return `${stem}-${n}${ext}`;
};

// Saves the body in the uploads folder under a plain name no file there has, and says where. The cap is
// files.ts's (2 GB, 413).
export async function saveUpload(name: string | null, body: ReadableStream<Uint8Array> | null, length: number): Promise<{ path: string; size: number }> {
  if (!name) throw new HttpError(400, "name is required");
  if (!body) throw new HttpError(400, "the file is the request's body");
  const dir = uploadsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const plain = plainName(name);
  for (let n = 1; ; n++) {
    const path = guardFile(join(dir, numbered(plain, n)));
    try {
      lstatSync(path);
      continue; // taken
    } catch {}
    try {
      const { size } = await upload(path, body, "new", length);
      return { path, size };
    } catch (e) {
      // Taken since the look, by another upload: the body is spent, so the app sends it again.
      if (e instanceof HttpError && e.status === 409) throw new HttpError(409, "that name was taken as the file arrived: send it again");
      throw e;
    }
  }
}

// A file in the uploads folder itself: what a message's `files` may name, and what the chat shows as a picture.
export function isUpload(path: unknown): path is string {
  if (typeof path !== "string" || dirname(path) !== uploadsDir()) return false;
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

// Files there over 30 days go: when blimpd starts, and once a day (server.ts).
export function cleanUploads(now = Date.now(), dir = uploadsDir()) {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    const p = join(dir, n);
    try {
      const st = lstatSync(p);
      if (st.isFile() && now - st.mtimeMs > KEEP_MS) rmSync(p, { force: true });
    } catch {}
  }
}
