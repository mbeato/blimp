import { expect, test } from "bun:test";
import {
  ancestors,
  baseName,
  canMoveInto,
  collapse,
  decodeText,
  formatSize,
  hasPreview,
  imageType,
  initialSync,
  isBinary,
  isInside,
  joinPath,
  menuItems,
  mergeWatch,
  movedPath,
  nameError,
  nextSync,
  parentDir,
  relPath,
  renameSelection,
  resolvePath,
  shellQuote,
  viewerFor,
  watchPaths,
  type Sync,
  type SyncEvent,
} from "./files";

const text = (s: string) => new TextEncoder().encode(s);

test("binary means a NUL byte in the first 8 KB", () => {
  expect(isBinary(text("hello\nworld"))).toBe(false);
  expect(isBinary(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))).toBe(true);
  expect(isBinary(new Uint8Array(0))).toBe(false);
  const late = new Uint8Array(9000).fill(65);
  late[8191] = 0;
  expect(isBinary(late)).toBe(true);
  late[8191] = 65;
  late[8192] = 0;
  expect(isBinary(late)).toBe(false);
});

test("viewer by extension, then by content", () => {
  const bin = new Uint8Array([1, 0, 2]);
  expect(viewerFor("logo.PNG", bin)).toBe("image");
  expect(viewerFor("icon.svg", text("<svg/>"))).toBe("image");
  for (const ext of ["jpg", "jpeg", "gif", "webp", "ico", "bmp"]) expect(viewerFor(`a.${ext}`, bin)).toBe("image");
  expect(viewerFor("paper.pdf", bin)).toBe("pdf");
  expect(viewerFor("README.md", text("# hi"))).toBe("markdown");
  expect(viewerFor("notes.markdown", text("# hi"))).toBe("markdown");
  expect(viewerFor("main.ts", text("let a = 1"))).toBe("text");
  expect(viewerFor("Makefile", text("all:"))).toBe("text");
  expect(viewerFor(".env", text("A=1"))).toBe("text");
  expect(viewerFor("app.bin", bin)).toBe("binary");
  expect(viewerFor("weird.md", bin)).toBe("binary");
  expect(viewerFor("render.html", text("<p>hi</p>"))).toBe("html");
  expect(viewerFor("old.HTM", text("<p>hi</p>"))).toBe("html");
  expect(viewerFor("weird.html", bin)).toBe("binary");
});

test("Markdown and HTML show rendered, with Edit for their text; other text is only in the editor", () => {
  expect(hasPreview("markdown")).toBe(true);
  expect(hasPreview("html")).toBe(true);
  for (const v of ["text", "image", "pdf", "binary"] as const) expect(hasPreview(v)).toBe(false);
});

test("sizes read like Finder", () => {
  expect(formatSize(0)).toBe("0 bytes");
  expect(formatSize(1023)).toBe("1023 bytes");
  expect(formatSize(1536)).toBe("1.5 KB");
  expect(formatSize(300 * 1024)).toBe("300 KB");
  expect(formatSize(5 * 1024 * 1024)).toBe("5.0 MB");
});

test("path helpers", () => {
  expect(joinPath("/home/u", "a")).toBe("/home/u/a");
  expect(joinPath("/", "a")).toBe("/a");
  expect(baseName("/home/u/a.ts")).toBe("a.ts");
  expect(parentDir("/home/u/a.ts")).toBe("/home/u");
  expect(parentDir("/a")).toBe("/");
  expect(resolvePath("/r/docs", "../src/a.ts")).toBe("/r/src/a.ts");
  expect(resolvePath("/r", "./b/./c.md")).toBe("/r/b/c.md");
  expect(resolvePath("/r", "../../..")).toBe("/");
});

test("image blobs get a type <img> can draw", () => {
  expect(imageType("a.svg")).toBe("image/svg+xml");
  expect(imageType("a.JPG")).toBe("image/jpeg");
  expect(imageType("a.jpeg")).toBe("image/jpeg");
  expect(imageType("a.png")).toBe("image/png");
  expect(imageType("favicon.ico")).toBe("image/x-icon");
});

test("text must be UTF-8; a BOM is kept so saving writes it back", () => {
  expect(decodeText(text("café"))).toBe("café");
  expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toBe("\ufeffa");
  // Windows-1252 "café": decoding would turn é into U+FFFD and saving would write that back.
  expect(decodeText(new Uint8Array([0x63, 0x61, 0x66, 0xe9]))).toBeNull();
});

const run = (s: Sync, ...events: SyncEvent[]) => {
  const effects: string[] = [];
  for (const e of events) {
    const r = nextSync(s, e);
    s = r.state;
    if (r.effect) effects.push(r.effect);
  }
  return { s, effects };
};

test("a change on the server reloads a clean file silently", () => {
  const { s, effects } = run(initialSync(100), { type: "remote", mtime: 200 });
  expect(effects).toEqual(["reload"]);
  expect(s.conflict).toBe(false);
  expect(run(s, { type: "reloaded", mtime: 200 }).s).toEqual(initialSync(200));
});

test("a change on the server asks first when there are unsaved edits", () => {
  const { s, effects } = run(initialSync(100), { type: "edit", dirty: true }, { type: "remote", mtime: 200 });
  expect(effects).toEqual([]);
  expect(s.conflict).toBe(true);
  // Reload takes the server's copy.
  expect(run(s, { type: "reloaded", mtime: 200 }).s).toEqual(initialSync(200));
  // Keep mine saves over it.
  expect(run(s, { type: "save" }, { type: "saved", mtime: 300 }).s).toEqual(initialSync(300));
});

test("our own save's fs event changes nothing", () => {
  const { s, effects } = run(
    initialSync(100),
    { type: "edit", dirty: true },
    { type: "save" },
    { type: "remote", mtime: 200 }, // arrives before the PUT's answer
    { type: "saved", mtime: 200 },
    { type: "remote", mtime: 200 },
  );
  expect(effects).toEqual([]);
  expect(s).toEqual(initialSync(200));
  // Typing again right after the save, then our event arrives late: still no bar.
  const late = run(s, { type: "edit", dirty: true }, { type: "remote", mtime: 200 });
  expect(late.s.conflict).toBe(false);
});

test("a read that comes back after a newer save is ignored", () => {
  // Save 1's fs event starts a read; save 2 answers first; then that read returns save 1's copy.
  const saved = run(
    initialSync(100),
    { type: "edit", dirty: true },
    { type: "save" },
    { type: "saved", mtime: 200 },
    { type: "edit", dirty: true },
    { type: "save" },
    { type: "saved", mtime: 300 },
  ).s;
  const late = run(saved, { type: "remote", mtime: 200 });
  expect(late.effects).toEqual([]);
  expect(late.s).toEqual(initialSync(300));
  // Typing meanwhile doesn't bring up the bar either.
  expect(run(saved, { type: "edit", dirty: true }, { type: "remote", mtime: 200 }).s.conflict).toBe(false);
});

test("a 409 on save shows the bar and keeps the edits", () => {
  const { s } = run(initialSync(100), { type: "edit", dirty: true }, { type: "save" }, { type: "rejected" });
  expect(s).toEqual({ mtime: 100, dirty: true, saving: false, conflict: true });
  // More server changes while the bar is up don't reload over the edits.
  expect(run(s, { type: "remote", mtime: 300 }).effects).toEqual([]);
});

test("a failed save keeps the edits and no bar", () => {
  const { s } = run(initialSync(100), { type: "edit", dirty: true }, { type: "save" }, { type: "failed" });
  expect(s).toEqual({ mtime: 100, dirty: true, saving: false, conflict: false });
});

test("undoing back to the saved text makes the file clean again", () => {
  const { s, effects } = run(
    initialSync(100),
    { type: "edit", dirty: true },
    { type: "edit", dirty: false },
    { type: "remote", mtime: 200 },
  );
  expect(s.dirty).toBe(false);
  expect(effects).toEqual(["reload"]);
});

test("collapsing a folder forgets the folders open inside it", () => {
  const ex = new Set(["/r", "/r/a", "/r/a/b", "/r/ab", "/r/c"]);
  expect([...collapse(ex, "/r/a")].sort()).toEqual(["/r", "/r/ab", "/r/c"]);
  expect(ex.size).toBe(5); // not mutated
});

test("watch set: expanded folders plus open files, no duplicates", () => {
  expect(watchPaths(new Set(["/r", "/r/src"]), ["/r/src/a.ts", "/r/README.md", "/r/src/a.ts"])).toEqual([
    "/r",
    "/r/README.md",
    "/r/src",
    "/r/src/a.ts",
  ]);
  expect(watchPaths([], [])).toEqual([]);
});

test("watch sets of workspaces on one server merge", () => {
  expect(mergeWatch([["/r", "/r/a.ts"], ["/r", "/s"], []])).toEqual(["/r", "/r/a.ts", "/s"]);
  expect(mergeWatch([])).toEqual([]);
});

test("relative paths are from the project folder; the folder itself is ., a path outside it stays whole", () => {
  expect(relPath("/home/me/proj", "/home/me/proj/src/a.ts")).toBe("src/a.ts");
  expect(relPath("/home/me/proj", "/home/me/proj")).toBe(".");
  expect(relPath("/home/me/proj", "/home/me/projects/a.ts")).toBe("/home/me/projects/a.ts");
  expect(relPath("/", "/etc/hosts")).toBe("etc/hosts");
  expect(isInside("/a/b", "/a")).toBe(true);
  expect(isInside("/ab", "/a")).toBe(false);
});

test("a path typed into a terminal is quoted only when a shell would split or expand it", () => {
  expect(shellQuote("/home/me/proj/src/a.ts")).toBe("/home/me/proj/src/a.ts");
  expect(shellQuote("/home/me/My Pics/shot 1.png")).toBe("'/home/me/My Pics/shot 1.png'");
  expect(shellQuote("/home/me/it's.txt")).toBe(`'/home/me/it'\\''s.txt'`);
  for (const p of ["/a/$HOME", "/a/*.ts", "/a/b;rm", "/a/(x)", "/a/~b", "/a/`x`", "/a/é"]) expect(shellQuote(p).startsWith("'")).toBe(true);
});

test("a rename or move carries the paths inside it along", () => {
  expect(movedPath("/p/a.txt", "/p/a.txt", "/p/b.txt")).toBe("/p/b.txt");
  expect(movedPath("/p/docs/x/y.md", "/p/docs", "/p/notes")).toBe("/p/notes/x/y.md");
  expect(movedPath("/p/docs2/y.md", "/p/docs", "/p/notes")).toBeNull();
  expect(movedPath("/p/other", "/p/docs", "/p/notes")).toBeNull();
});

test("a drag in the tree goes into another folder, never its own folder nor into itself", () => {
  expect(canMoveInto("/p/a.txt", "/p/docs")).toBe(true);
  expect(canMoveInto("/p/a.txt", "/p")).toBe(false);
  expect(canMoveInto("/p/docs", "/p/docs")).toBe(false);
  expect(canMoveInto("/p/docs", "/p/docs/deep")).toBe(false);
  expect(canMoveInto("/p/docs", "/p/docs2")).toBe(true);
  expect(canMoveInto("/p/docs/deep", "/p")).toBe(true);
});

test("revealing a file opens the folders from the project folder down to it", () => {
  expect(ancestors("/p", "/p/a/b/c.txt")).toEqual(["/p", "/p/a", "/p/a/b"]);
  expect(ancestors("/p", "/p/c.txt")).toEqual(["/p"]);
  expect(ancestors("/p", "/p")).toEqual([]);
  expect(ancestors("/p", "/q/c.txt")).toEqual([]);
});

test("a rename selects a file's name without its extension, a folder's whole name; names are one name", () => {
  expect(renameSelection("notes.md", "file")).toEqual([0, 5]);
  expect(renameSelection("archive.tar.gz", "file")).toEqual([0, 11]);
  expect(renameSelection(".env", "file")).toEqual([0, 4]);
  expect(renameSelection("Makefile", "file")).toEqual([0, 8]);
  expect(renameSelection("v1.2", "dir")).toEqual([0, 4]);
  expect(nameError("ok.txt")).toBeNull();
  for (const bad of ["", "a/b", ".", ".."]) expect(nameError(bad)).not.toBeNull();
});

test("right-click menus: files, folders, the project folder (no rename or delete) and file tabs", () => {
  expect(menuItems("tree", "file")).toEqual(["download", "-", "copy-path", "copy-rel", "send-path", "-", "rename", "delete"]);
  expect(menuItems("tree", "dir")).toEqual(["new-file", "new-folder", "-", "upload", "download", "gallery", "-", "copy-path", "copy-rel", "send-path", "-", "rename", "delete"]);
  expect(menuItems("tree", "dir", true)).not.toContain("rename");
  expect(menuItems("tree", "dir", true)).not.toContain("delete");
  expect(menuItems("tab", "file")).toEqual(["download", "-", "copy-path", "copy-rel", "send-path", "-", "reveal"]);
});
