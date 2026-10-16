// Files under the home folder: list, read, write, and the file list for quick open.
// Every path is checked after following symlinks, so a link can't lead outside home.

import {
  chmodSync,
  type Dirent,
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const realHome = () => realpathSync(homedir());

const inside = (p: string, home: string) => p === home || p.startsWith(home === "/" ? "/" : home + "/");

// The real path for `path`, or 403. A path that doesn't exist yet is allowed when its parent is inside.
export function guard(path: string | null, home = realHome()): string {
  if (!path || !isAbsolute(path)) throw new HttpError(400, "path must be absolute");
  const abs = resolve(path);
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    // Doesn't exist, or a broken symlink. The name must not exist at all: a dangling link
    // would otherwise be written through to wherever it points.
    if (lstatExists(abs)) throw new HttpError(403, "outside your home folder");
    try {
      real = join(realpathSync(dirname(abs)), basename(abs));
    } catch {
      throw new HttpError(403, "outside your home folder");
    }
  }
  if (!inside(real, home)) throw new HttpError(403, "outside your home folder");
  return real;
}

function lstatExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

const ms = (t: number) => Math.floor(t);

export type Entry = { name: string; kind: "file" | "dir"; size: number; mtime: number };

export function listDir(path: string): { path: string; entries: Entry[] } {
  const entries: Entry[] = [];
  for (const name of readdirSync(path)) {
    let st;
    try {
      st = statSync(join(path, name)); // follows symlinks; broken ones throw and are skipped
    } catch {
      continue;
    }
    entries.push({ name, kind: st.isDirectory() ? "dir" : "file", size: st.size, mtime: ms(st.mtimeMs) });
  }
  entries.sort((a, b) => (a.kind === b.kind ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.kind === "dir" ? -1 : 1));
  return { path, entries };
}

const MAX_READ = 50 * 1024 * 1024;

const types: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  bmp: "image/bmp",
  pdf: "application/pdf",
  md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  json: "application/json",
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
};

export const contentType = (path: string) => types[extname(path).slice(1).toLowerCase()] ?? "application/octet-stream";

export function readFile(path: string): Response {
  const st = statSync(path);
  if (st.isDirectory()) throw new HttpError(400, "that's a folder");
  if (st.size > MAX_READ) throw new HttpError(413, "file is over 50 MB");
  return new Response(Bun.file(path), {
    headers: {
      "Content-Type": contentType(path),
      "X-Blimp-Mtime": String(ms(st.mtimeMs)),
      "Access-Control-Expose-Headers": "X-Blimp-Mtime",
    },
  });
}

// Writes through a temp file and a rename, so Claude or a watcher never sees half a file.
// With baseMtime, refuses if the file changed since the app read it.
export function writeFile(path: string, body: Uint8Array, baseMtime?: number): { mtime: number } {
  let mode = 0o644;
  if (existsSync(path)) {
    const st = statSync(path);
    if (st.isDirectory()) throw new HttpError(400, "that's a folder");
    if (baseMtime !== undefined && ms(st.mtimeMs) !== baseMtime)
      throw new HttpError(409, "changed on the server", { mtime: ms(st.mtimeMs) });
    mode = st.mode & 0o7777;
  }
  const tmp = join(dirname(path), `.${basename(path)}.blimp-${process.pid}-${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, body, { mode, flag: "wx" });
    chmodSync(tmp, mode); // the umask may have taken bits off
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return { mtime: ms(statSync(path).mtimeMs) };
}

const MAX_FILES = 20_000;

// For ⌘P. In a git repo, git's own list (respects .gitignore). Otherwise a walk that skips the usual noise.
export function listFiles(root: string): { files: string[]; truncated: boolean } {
  const files = gitFiles(root) ?? walk(root);
  return files.length > MAX_FILES ? { files: files.slice(0, MAX_FILES), truncated: true } : { files, truncated: false };
}

function gitFiles(root: string): string[] | undefined {
  try {
    // core.fsmonitor=false: a repo's config can't make this run a program.
    const r = Bun.spawnSync(
      ["git", "-c", "core.fsmonitor=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "ignore" },
    );
    if (r.exitCode !== 0) return;
    return [...new Set(r.stdout.toString().split("\0").filter(Boolean))];
  } catch {
    return; // no git installed
  }
}

function walk(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length && out.length <= MAX_FILES) {
    const dir = stack.pop()!;
    let ents: Dirent[];
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      const p = join(dir, e.name);
      // Symlinked folders aren't followed: they can loop or lead outside home.
      if (e.isDirectory()) {
        if (e.name !== "node_modules" && !e.name.startsWith(".")) stack.push(p);
      } else out.push(relative(root, p));
    }
  }
  return out.sort();
}
