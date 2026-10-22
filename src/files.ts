// Files under the home folder: list, read, write, download, upload, and the file list for quick open.
// Every path is checked after following symlinks, so a link can't lead outside home.

import { open, readdir } from "node:fs/promises";
import {
  chmodSync,
  type Dirent,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
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

// The socket folder, the same formula as sessions.ts's blimpDir(). Duplicated only to keep this
// module out of the import cycle (sessions → kinds → files); a test pins the two together.
export function socketDir(): string {
  return dirname(process.env.BLIMPD_SOCKET || join(homedir(), ".blimp", "blimpd.sock"));
}

// A path resolved the way guard() resolves its result: the real path, or — for a file that
// doesn't exist yet — its folder's real path with the name on.
function realPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {}
  try {
    return join(realpathSync(dirname(p)), basename(p));
  } catch {
    return resolve(p);
  }
}

// blimp's own key files: the daemon's token, the phone's token, the browser gate's key (all
// beside the socket), the model key, and the folder of secrets given to sessions (secrets.ts).
// No fs route may serve, replace, or archive them: a client holding one token — the phone's —
// must not read or plant another (the Mac's), so `blimpd pair --revoke` stays final.
export function secretPaths(home = realHome(), dir = socketDir()): string[] {
  return [
    join(dir, "token"),
    join(dir, "phone-token"),
    join(dir, "browser", "key"),
    join(home, ".config", "zai", "key"),
    join(dir, "secrets"),
  ].map(realPath);
}

// guard() for the routes that read or write one file: inside home, and never one of those key
// files, anything in the secrets folder, nor a folder that holds one (a folder download would archive it).
export function guardFile(path: string | null, home = realHome(), dir = socketDir()): string {
  const real = guard(path, home);
  const slash = real === "/" ? "" : "/";
  if (secretPaths(home, dir).some((s) => s === real || s.startsWith(real + slash) || real.startsWith(s + "/")))
    throw new HttpError(403, "that's one of blimp's own files");
  return real;
}

// guard() for the routes that list a folder (/fs/list, /fs/files): not the secrets folder nor one in
// it, so a secret's name isn't listed through them either. A folder that holds it still lists.
export function guardList(path: string | null, home = realHome(), dir = socketDir()): string {
  const real = guard(path, home);
  const secrets = realPath(join(dir, "secrets"));
  if (real === secrets || real.startsWith(secrets + "/")) throw new HttpError(403, "that's one of blimp's own files");
  return real;
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
  // A new file gets whatever the umask allows, as any editor would make it.
  let mode: number | undefined;
  if (existsSync(path)) {
    const st = statSync(path);
    if (st.isDirectory()) throw new HttpError(400, "that's a folder");
    if (baseMtime !== undefined && ms(st.mtimeMs) !== baseMtime)
      throw new HttpError(409, "changed on the server", { mtime: ms(st.mtimeMs) });
    mode = st.mode & 0o7777;
  }
  const tmp = join(dirname(path), `.${basename(path)}.blimp-${process.pid}-${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, body, { mode: mode ?? 0o666, flag: "wx" });
    if (mode !== undefined) chmodSync(tmp, mode); // keep the original's mode: the umask may have taken bits off
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return { mtime: ms(statSync(path).mtimeMs) };
}

// New, empty, for the files pane's "New folder" and "New file". Never over something that exists.
export function makeDir(path: string): { path: string } {
  try {
    mkdirSync(path);
  } catch (e: any) {
    if (e?.code === "EEXIST") throw new HttpError(409, "that name is taken");
    throw e;
  }
  return { path };
}

export function createFile(path: string): { path: string; mtime: number } {
  try {
    writeFileSync(path, "", { flag: "wx" });
  } catch (e: any) {
    if (e?.code === "EEXIST") throw new HttpError(409, "that name is taken");
    throw e;
  }
  return { path, mtime: ms(statSync(path).mtimeMs) };
}

const MAX_FILES = 20_000;

// For ⌘P. In a git repo, git's own list (respects .gitignore). Otherwise a walk that skips the usual noise.
// Never anything in the secrets folder, as guardList: a root above it would list the secrets' names.
// Async, so a big repo doesn't stall every open terminal while git or the walk runs.
export async function listFiles(root: string, dir = socketDir()): Promise<{ files: string[]; truncated: boolean }> {
  const secrets = realPath(join(dir, "secrets"));
  const files = ((await gitFiles(root)) ?? (await walk(root))).filter((f) => !inside(join(root, f), secrets));
  return files.length > MAX_FILES ? { files: files.slice(0, MAX_FILES), truncated: true } : { files, truncated: false };
}

async function gitFiles(root: string): Promise<string[] | undefined> {
  try {
    // core.fsmonitor=false: a repo's config can't make this run a program.
    const p = Bun.spawn(
      ["git", "-c", "core.fsmonitor=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "ignore" },
    );
    const out = await new Response(p.stdout).text();
    if ((await p.exited) !== 0) return;
    return [...new Set(out.split("\0").filter(Boolean))];
  } catch {
    return; // no git installed
  }
}

async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [root];
  while (stack.length && out.length <= MAX_FILES) {
    const dir = stack.pop()!;
    let ents: Dirent[];
    try {
      ents = await readdir(dir, { withFileTypes: true });
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

const attachment = (name: string) => `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;

// A file as it is, of any size (streamed), or a folder as <name>.tar.gz made on the fly. tar
// stores symlinks as links and never follows them, so nothing outside home is read.
// signal: the request's, so a cancelled download stops tar.
export function download(path: string, signal: AbortSignal): Response {
  const st = statSync(path);
  const name = basename(path);
  if (st.isDirectory()) {
    const tar = Bun.spawn(["tar", "-czf", "-", "-C", dirname(path), "--", name], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    signal.addEventListener("abort", () => tar.kill());
    // The status went out with the first bytes, so a tar that fails part way (2: a file it
    // couldn't read) breaks the stream instead, and the app shows the download as failed rather
    // than saving an archive with files missing. (1 is "a file changed while read": kept.)
    const out = tar.stdout.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        const { done, value } = await out.read();
        if (!done) return c.enqueue(value);
        const code = await tar.exited;
        if (code > 1) c.error(new Error(`tar exited with ${code}`));
        else c.close();
      },
      cancel: () => void tar.kill(),
    });
    return new Response(body, { headers: { "Content-Type": "application/gzip", "Content-Disposition": attachment(`${name}.tar.gz`) } });
  }
  if (!st.isFile()) throw new HttpError(400, "not a file or a folder");
  return new Response(Bun.file(path), {
    headers: { "Content-Type": "application/octet-stream", "Content-Length": String(st.size), "Content-Disposition": attachment(name) },
  });
}

export const MAX_UPLOAD = 2 * 1024 ** 3;

// Streams an upload to a temp file beside the target, then puts it in place: mode "new" only if
// the name is free (409 otherwise, also if it was taken meanwhile), "replace" over a file of
// that name. Never over a folder. At most MAX_UPLOAD bytes (413).
export async function upload(path: string, body: ReadableStream<Uint8Array> | null, mode: string, length: number): Promise<{ size: number; mtime: number }> {
  if (mode !== "new" && mode !== "replace") throw new HttpError(400, "mode must be new or replace");
  // A replaced file keeps its permissions (a 600 key, a runnable script).
  let keepMode: number | undefined;
  if (lstatExists(path)) {
    const st = statSync(path);
    if (st.isDirectory()) throw new HttpError(409, "a folder has that name");
    if (mode === "new") throw new HttpError(409, "already exists");
    keepMode = st.mode & 0o7777;
  }
  if (length > MAX_UPLOAD) throw new HttpError(413, "over 2 GB");
  try {
    const fs = statfsSync(dirname(path));
    if (length > fs.bavail * fs.bsize) throw new HttpError(507, "not enough free disk space on the server");
  } catch (e) {
    if (e instanceof HttpError) throw e;
  }
  const tmp = join(dirname(path), `.${basename(path)}.blimp-upload-${process.pid}-${Date.now()}`);
  let size = 0;
  try {
    const fh = await open(tmp, "wx", 0o666);
    try {
      if (body)
        for await (const chunk of body) {
          size += chunk.length;
          if (size > MAX_UPLOAD) throw new HttpError(413, "over 2 GB");
          await fh.write(chunk);
        }
      if (keepMode !== undefined) await fh.chmod(keepMode);
    } finally {
      await fh.close();
    }
    if (mode === "new") {
      // A hard link fails if the name was taken meanwhile; rename would replace it.
      try {
        linkSync(tmp, path);
      } catch (e: any) {
        if (e?.code === "EEXIST") throw new HttpError(409, "already exists");
        throw e;
      }
      rmSync(tmp, { force: true });
    } else renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return { size, mtime: ms(statSync(path).mtimeMs) };
}
