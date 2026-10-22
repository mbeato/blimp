// Downloads and uploads, and the list of them the window shows with their progress.
// The Mac app does the transfer in Rust (src-tauri/src/transfer.rs), so big files stream between
// disk and the tunnel; a browser (development, the e2e tests) does it here with fetch.

import { invoke } from "@tauri-apps/api/core";
import { errorText, inTauri, type ServerLink } from "./connection";
import { baseName, joinPath } from "./files";

// Something to upload: a path on the Mac (dropped from Finder, or picked in Upload…), or in a
// browser, a File.
export type Item = { name: string; local?: string; file?: File };

export type Transfer = {
  id: number;
  kind: "down" | "up";
  label: string;
  done: number;
  total: number;
  state: "running" | "done" | "failed" | "cancelled";
  error?: string;
  saved?: string; // a download's path on the Mac
};

// Images pasted on a terminal (⌘V after ⌃⇧⌘4 put a screenshot on the clipboard): uploaded like a drop,
// so Claude reads them from their paths. Only when the paste has no text, so pasting rich text that
// carries an image still pastes the text. A clipboard image has no name of its own: named like the Mac's.
export function pastedImages(files: File[], hasText: boolean, now = new Date()): Item[] {
  if (hasText) return [];
  const images = files.filter((f) => f.type.startsWith("image/"));
  const two = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}-at-${two(now.getHours())}.${two(now.getMinutes())}.${two(now.getSeconds())}`;
  const ext = (type: string) => ({ "image/jpeg": "jpg", "image/svg+xml": "svg" })[type] ?? type.slice(6).replace(/[^a-z0-9]/g, "");
  return images.map((file, i) => ({ name: `Screenshot-${stamp}${images.length > 1 ? `-${i + 1}` : ""}.${ext(file.type)}`, file }));
}

// "name 2.ext", "name 3.ext"… for a name in `taken` (".tar.gz" is one extension).
export function freeName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  const m = name.match(/^(.+?)(\.tar\.gz|\.[^.]+)?$/)!;
  const [stem, ext = ""] = [m[1], m[2]];
  for (let n = 2; ; n++) if (!taken.has(`${stem} ${n}${ext}`)) return `${stem} ${n}${ext}`;
}

// A name that is one plain word in a terminal: no spaces (a Mac screenshot's name has some, and
// a narrow no-break space before "PM"), no quotes or shell characters.
export const plainName = (name: string) => name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+/, "") || "file";

// Where a file dragged in from Finder is in the page, from Tauri's drag-drop event. Tauri calls
// that position physical pixels, but on macOS wry (src/wkwebview/drag_drop.rs) hands over AppKit's
// draggingLocation unscaled: points from the webview's top left, which are the page's CSS pixels.
// Divided by the Retina scale, the lit folder was at half the pointer's distance from the top
// left, and a drop landed there. Elsewhere (Windows, Linux) the position is physical pixels.
export function dropPoint(p: { x: number; y: number }, o: { mac: boolean; dpr: number }): { x: number; y: number } {
  return o.mac ? { x: p.x, y: p.y } : { x: p.x / o.dpr, y: p.y / o.dpr };
}

let next = 1;
const list: Transfer[] = [];
const subs = new Set<() => void>();
const aborts = new Map<number, AbortController>();
const changed = () => subs.forEach((f) => f());

let listening: Promise<unknown> | null = null;
function listen() {
  if (listening || !inTauri()) return;
  listening = import("@tauri-apps/api/webviewWindow").then(({ getCurrentWebviewWindow }) =>
    getCurrentWebviewWindow().listen<{ id: number; done: number; total: number }>("transfer", (e) => {
      const t = list.find((x) => x.id === e.payload.id);
      if (!t || t.state !== "running") return;
      t.done = e.payload.done;
      t.total = e.payload.total;
      changed();
    }),
  );
}

function begin(kind: Transfer["kind"], label: string): Transfer {
  listen();
  const t: Transfer = { id: next++, kind, label, done: 0, total: 0, state: "running" };
  list.push(t);
  changed();
  return t;
}

function finish(t: Transfer, e?: unknown) {
  aborts.delete(t.id);
  if (e === undefined) t.state = "done";
  else if (t.state === "cancelled" || /cancel|abort/i.test(errorText(e))) t.state = "cancelled";
  else {
    t.state = "failed";
    t.error = errorText(e);
  }
  // Finished uploads leave the list by themselves; a download stays for Show in Finder.
  if (t.state === "done" && t.kind === "up") setTimeout(() => dismiss(t.id), 3000);
  changed();
}

export const transfers = {
  list: () => list,
  subscribe(f: () => void) {
    subs.add(f);
    return () => void subs.delete(f);
  },
};

export function cancel(id: number) {
  const t = list.find((x) => x.id === id);
  if (!t || t.state !== "running") return;
  t.state = "cancelled";
  aborts.get(id)?.abort();
  if (inTauri()) invoke("cancel_transfer", { id }).catch(() => {});
  changed();
}

export function dismiss(id: number) {
  const i = list.findIndex((x) => x.id === id);
  if (i >= 0 && list[i].state !== "running") list.splice(i, 1);
  changed();
}

// A file, or a folder as .tar.gz: to ~/Downloads in the Mac app, the browser's downloads otherwise.
export async function download(link: ServerLink, path: string, isDir: boolean) {
  const t = begin("down", isDir ? `${baseName(path)}.tar.gz` : baseName(path));
  try {
    if (inTauri()) t.saved = await invoke<string>("download", { server: link.key, path, id: t.id });
    else await browserDownload(link, path, t);
    finish(t);
  } catch (e) {
    finish(t, e);
  }
}

async function browserDownload(link: ServerLink, path: string, t: Transfer) {
  if (!link.api) throw new Error("Not connected.");
  const ac = new AbortController();
  aborts.set(t.id, ac);
  const res = await link.api.fsDownload(path, ac.signal);
  t.total = Number(res.headers.get("content-length") ?? 0);
  const parts: Uint8Array<ArrayBuffer>[] = [];
  const reader = res.body!.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value as Uint8Array<ArrayBuffer>);
    t.done += value.length;
    changed();
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(parts));
  a.download = t.label;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

// One item into `dir` on the server as `as`. Resolves to its path there, or null if it failed
// or was cancelled (the list says which).
export async function upload(link: ServerLink, dir: string, item: Item, mode: "new" | "replace", as = item.name): Promise<string | null> {
  const t = begin("up", as);
  const path = joinPath(dir, as);
  try {
    if (item.local) await invoke("upload", { server: link.key, local: item.local, remoteDir: dir, name: as, mode, id: t.id });
    else {
      if (!link.api || !item.file) throw new Error("Not connected.");
      const ac = new AbortController();
      aborts.set(t.id, ac);
      t.total = item.file.size;
      await link.api.fsUpload(path, item.file, mode, ac.signal);
      t.done = t.total;
    }
    finish(t);
    return path;
  } catch (e) {
    finish(t, e);
    return null;
  }
}

// Upload…: the Mac's file picker, or a browser's.
export async function pickFiles(): Promise<Item[]> {
  if (inTauri()) {
    const paths = await invoke<string[]>("pick_upload").catch(() => []);
    return paths.map((p) => ({ name: baseName(p), local: p }));
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.onchange = () => resolve([...(input.files ?? [])].map((file) => ({ name: file.name, file })));
    input.click();
  });
}

// Show in Finder, for a finished download.
export async function reveal(path: string) {
  if (!inTauri()) return;
  const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
  await revealItemInDir(path).catch(() => {});
}
