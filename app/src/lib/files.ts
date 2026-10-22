// Pure logic behind the files pane: which viewer shows a file, when a server-side change
// reloads silently or asks first, and which paths to watch.

export const joinPath = (dir: string, name: string) => (dir.endsWith("/") ? dir + name : `${dir}/${name}`);
export const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
export const parentDir = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";

const extOf = (name: string) => {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
};

// A NUL byte in the first 8 KB is what git and most editors use to call a file binary.
export function isBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

// Text files must be valid UTF-8. Anything else would decode with U+FFFD in place of the bytes it
// can't read, and saving would write those over the file, so it isn't shown as text (null).
// A BOM stays in the text: Monaco keeps it aside and the save writes it back.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
export function decodeText(bytes: Uint8Array): string | null {
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
}

const IMAGES = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp"]);
const MARKDOWN = new Set(["md", "markdown"]);
const HTML = new Set(["html", "htm"]);

export const isImage = (name: string) => IMAGES.has(extOf(name));

export type Viewer = "image" | "pdf" | "markdown" | "html" | "text" | "binary";

// Images and PDFs go by extension (an SVG is text but shows as a picture). Everything else is
// text unless its bytes say binary.
export function viewerFor(name: string, bytes: Uint8Array): Viewer {
  const ext = extOf(name);
  if (IMAGES.has(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (isBinary(bytes)) return "binary";
  if (HTML.has(ext)) return "html";
  return MARKDOWN.has(ext) ? "markdown" : "text";
}

// Markdown and HTML are text that shows rendered, with Edit to change it in the editor.
export const hasPreview = (v: Viewer) => v === "markdown" || v === "html";

const IMAGE_TYPES: Record<string, string> = { jpg: "image/jpeg", svg: "image/svg+xml", ico: "image/x-icon" };

// The blob needs a type for <img> to draw it, SVG above all.
export const imageType = (name: string) => {
  const ext = extOf(name);
  return IMAGE_TYPES[ext] ?? `image/${ext}`;
};

// A relative link in a Markdown file, resolved against the file's folder.
export function resolvePath(dir: string, rel: string): string {
  const parts = dir.split("/").filter(Boolean);
  for (const p of rel.split("/")) {
    if (p === "..") parts.pop();
    else if (p && p !== ".") parts.push(p);
  }
  return "/" + parts.join("/");
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} bytes`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) (v /= 1024), u++;
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}

// An open text file against its copy on the server.
// mtime: the server mtime the editor's saved text matches. dirty: unsaved edits.
// conflict: the server changed while there were unsaved edits (the "Reload / Keep mine" bar).
export type Sync = { mtime: number; dirty: boolean; saving: boolean; conflict: boolean };

export type SyncEvent =
  | { type: "edit"; dirty: boolean } // the editor's text now differs (or not) from the saved text
  | { type: "save" } // ⌘S or Keep mine sent
  | { type: "saved"; mtime: number }
  | { type: "rejected" } // 409: the server's copy changed since mtime
  | { type: "failed" } // save failed for another reason
  | { type: "remote"; mtime: number } // an fs event, after reading the file's mtime
  | { type: "reloaded"; mtime: number }; // the editor now holds the server's text

// "reload": fetch the server's text into the editor without asking.
export type SyncEffect = "reload" | null;

export const initialSync = (mtime: number): Sync => ({ mtime, dirty: false, saving: false, conflict: false });

export function nextSync(s: Sync, e: SyncEvent): { state: Sync; effect: SyncEffect } {
  const done = (state: Sync, effect: SyncEffect = null) => ({ state, effect });
  switch (e.type) {
    case "edit":
      return done({ ...s, dirty: e.dirty });
    case "save":
      return done({ ...s, saving: true });
    case "saved":
      return done({ ...s, mtime: e.mtime, saving: false, dirty: false, conflict: false });
    case "rejected":
      return done({ ...s, saving: false, conflict: true });
    case "failed":
      return done({ ...s, saving: false });
    case "remote":
      // Our own save also fires an fs event; it carries the mtime we already have. While a save is
      // in flight its result decides (a 409 if someone else wrote first). Reads can come back out
      // of order, so one older than what we hold is stale. (A file whose mtime really went back
      // still can't be lost: saving over it gets a 409 and the bar.)
      if (s.saving || e.mtime <= s.mtime || s.conflict) return done(s);
      if (s.dirty) return done({ ...s, conflict: true });
      return done(s, "reload");
    case "reloaded":
      return done({ ...s, mtime: e.mtime, dirty: false, conflict: false });
  }
}

// Collapsing a folder forgets the folders open inside it, so only folders on screen are watched.
export function collapse(expanded: Set<string>, dir: string): Set<string> {
  const prefix = dir.endsWith("/") ? dir : dir + "/";
  return new Set([...expanded].filter((p) => p !== dir && !p.startsWith(prefix)));
}

// One workspace's watch set: its expanded folders (the root among them) plus its open files.
export const watchPaths = (expanded: Iterable<string>, openFiles: Iterable<string>) =>
  [...new Set([...expanded, ...openFiles])].sort();

// blimpd keeps one watch set per socket, so the sets of every workspace on a server are merged.
export const mergeWatch = (sets: Iterable<string[]>) => [...new Set([...sets].flat())].sort();

// ---- the tree's right-click, rename, delete and move ----

// The path itself or something inside it.
export const isInside = (path: string, dir: string) => path === dir || path.startsWith(dir.endsWith("/") ? dir : dir + "/");

// For Copy Relative Path: from the project folder, as VS Code does ("." for the folder itself).
// A path outside it stays as it is.
export function relPath(root: string, path: string): string {
  if (path === root) return ".";
  return isInside(path, root) ? path.slice(root.endsWith("/") ? root.length : root.length + 1) : path;
}

// A path typed into a terminal: as it is when a shell reads it as one word, else in single quotes
// (a ' in it as '\''), so a name with spaces is still one path for a shell and for Claude.
export const shellQuote = (path: string) => (/^[A-Za-z0-9_\/.,:@%+=-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`);

// Where `path` is once `from` has been renamed or moved to `to` (its own new path, or the new path
// of something inside it); null when it isn't touched.
export function movedPath(path: string, from: string, to: string): string | null {
  if (path === from) return to;
  return isInside(path, from) ? to + path.slice(from.length) : null;
}

// A drag in the tree: `from` can go into `dir` unless it's already there, or is a folder going
// into itself or one inside it.
export const canMoveInto = (from: string, dir: string) => parentDir(from) !== dir && !isInside(dir, from);

// The folders to open to show `path` in a tree rooted at `root`: root, then down to path's folder.
// None when it isn't inside root.
export function ancestors(root: string, path: string): string[] {
  if (path === root || !isInside(path, root)) return [];
  const out = [root];
  for (let d = parentDir(path); d !== root; d = parentDir(d)) out.splice(1, 0, d);
  return out;
}

// What a rename selects first, as VS Code: a file's name without its extension, a folder's whole name.
export function renameSelection(name: string, kind: "file" | "dir"): [number, number] {
  const dot = name.lastIndexOf(".");
  return kind === "file" && dot > 0 ? [0, dot] : [0, name.length];
}

// Why a new name can't be used (null: it can). One name, not a path.
export function nameError(name: string): string | null {
  if (!name) return "A name is needed";
  if (name.includes("/") || name === "." || name === "..") return "A name can't contain / or be . or ..";
  return null;
}

// The right-click menu of a tree row (a file, a folder, or the project folder itself: the empty space
// below the rows) or of a file tab. "-": a line between groups.
export type MenuItem = "new-file" | "new-folder" | "upload" | "download" | "gallery" | "copy-path" | "copy-rel" | "send-path" | "reveal" | "rename" | "delete" | "-";
export function menuItems(on: "tree" | "tab", kind: "file" | "dir", root = false): MenuItem[] {
  const paths: MenuItem[] = ["copy-path", "copy-rel", "send-path"];
  if (on === "tab") return ["download", "-", ...paths, "-", "reveal"];
  const edit: MenuItem[] = root ? [] : ["-", "rename", "delete"];
  if (kind === "file") return ["download", "-", ...paths, ...edit];
  return ["new-file", "new-folder", "-", "upload", "download", "gallery", "-", ...paths, ...edit];
}
