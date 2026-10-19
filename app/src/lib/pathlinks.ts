// File paths in terminal output, for ⌘-click to open them in a file tab (as VS Code's terminal
// does). Finding candidates is loose on purpose: a link only shows once the file is found to
// exist on the server (see ExistsCache), so "e.g." or "0.2.0" never become links.

import type { Api } from "./api";
import { baseName, parentDir, resolvePath } from "./files";

export type PathMatch = { start: number; end: number; text: string; line?: number; col?: number };

// Runs of path characters, with an optional :line or :line:col after them.
const CANDIDATE = /[\w.@+~/-]+(?::(\d+)(?::(\d+))?)?/g;
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;

// Where paths might be in one line of text. start/end are string indexes (end exclusive) and
// cover the :line:col too, so the whole thing underlines.
export function findPaths(text: string): PathMatch[] {
  const urls = [...text.matchAll(URL_RE)].map((m) => [m.index!, m.index! + m[0].length]);
  const out: PathMatch[] = [];
  for (const m of text.matchAll(CANDIDATE)) {
    let path = m[0].replace(/:\d+(?::\d+)?$/, "");
    const start = m.index!;
    // Trailing dots and dashes are sentence punctuation, not part of the name.
    const trimmed = path.replace(/[.-]+$/, "");
    const cut = path.length - trimmed.length;
    path = trimmed;
    const end = start + m[0].length - (m[1] ? 0 : cut);
    if (path.length < 2 || out.length >= 30) continue;
    // A name with a slash or an extension: src/app.ts, ./run, ~/notes, README.md
    if (!path.includes("/") && !/\.[A-Za-z0-9]+$/.test(path.replace(/^\.+/, ""))) continue;
    if (/^\/+$|^~$/.test(path)) continue;
    if (urls.some(([a, b]) => start < b && end > a)) continue;
    out.push({
      start,
      end: m[1] ? end : start + path.length,
      text: path,
      ...(m[1] && { line: Number(m[1]) }),
      ...(m[2] && { col: Number(m[2]) }),
    });
  }
  return out;
}

// An absolute path for what the terminal printed: ~/x from home, x from the session's folder.
export function resolveAgainst(text: string, cwd: string, home: string): string {
  if (text === "~" || text.startsWith("~/")) return resolvePath(home, text.slice(2));
  if (text.startsWith("/")) return resolvePath("/", text);
  return resolvePath(cwd, text);
}

// Whether files exist, from their folders' listings. A listing is reused for a few seconds, so
// hovering over a screen of paths costs one request per folder.
export class ExistsCache {
  private dirs = new Map<string, { at: number; files: Promise<Set<string>> }>();

  constructor(
    private api: () => Api | null,
    private ttl = 5000,
  ) {}

  async isFile(path: string): Promise<boolean> {
    const dir = parentDir(path);
    const now = Date.now();
    let hit = this.dirs.get(dir);
    if (!hit || now - hit.at > this.ttl) {
      const api = this.api();
      if (!api) return false;
      const files = api.fsList(dir).then(
        (l) => new Set(l.entries.filter((e) => e.kind === "file").map((e) => e.name)),
        () => new Set<string>(),
      );
      hit = { at: now, files };
      this.dirs.set(dir, hit);
      if (this.dirs.size > 200) this.dirs.delete(this.dirs.keys().next().value!);
    }
    return (await hit.files).has(baseName(path));
  }
}
