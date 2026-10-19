// What a window shows (a server, a folder, a session) and the window plumbing around it.
// The Mac app can have several windows; Rust keeps track of them (src-tauri/src/windows.rs).
// A plain browser (development, e2e tests) has one window and does everything in it.

import { invoke } from "@tauri-apps/api/core";
import { inTauri } from "./connection";

// dir missing: the server's home folder (Home). session: selected in the terminal pane.
export type Place = { server?: string; dir?: string; session?: string };

export function placeFromQuery(query: string): Place {
  const q = new URLSearchParams(query);
  const p: Place = {};
  for (const k of ["server", "dir", "session"] as const) {
    const v = q.get(k);
    if (v) p[k] = v;
  }
  return p;
}

// Only these keys, so the browser build's ?blimpd=&token= stay as they are.
export function placeQuery(p: Place, base = ""): string {
  const q = new URLSearchParams(base);
  for (const k of ["server", "dir", "session"] as const) {
    if (p[k]) q.set(k, p[k]!);
    else q.delete(k);
  }
  return q.toString();
}

// The URL wins (it's kept current, so a reload stays put); a new window starts from what
// Rust handed it (window.__blimpInit).
export function readPlace(): Place {
  const fromUrl = placeFromQuery(location.search);
  if (fromUrl.server) return fromUrl;
  return placeFromQuery((window as any).__blimpInit ?? "");
}

export function writePlace(p: Place) {
  const q = placeQuery(p, location.search);
  history.replaceState(null, "", q ? `?${q}` : location.pathname);
}

// The key Rust matches windows by: one window per (server, folder).
export const projectKey = (server: string, dir: string) => `${server}\n${dir}`;

// ⌘⇧N, or ⌘K to a session in another folder: focus the window showing that folder, or open one.
// The browser build switches the current window instead (returns false so the caller does).
export async function openWindow(p: Place): Promise<boolean> {
  if (!inTauri()) return false;
  await invoke("open_window", { project: p.server && p.dir ? projectKey(p.server, p.dir) : null, init: placeQuery(p) });
  return true;
}

export function setWindowProject(key: string | null) {
  if (inTauri()) invoke("set_window_project", { project: key }).catch(() => {});
}

// The session this window shows while it has focus: no notification for it from any window.
export function setViewing(session: string | null) {
  if (inTauri()) invoke("set_viewing", { session }).catch(() => {});
}

// One notification per wait across every window. The browser build has one window.
export async function claimNotice(session: string, key: string): Promise<boolean> {
  if (!inTauri()) return true;
  return invoke<boolean>("claim_notice", { session, key }).catch(() => true);
}

// ⌘K in another window picked a session in this window's folder.
export async function onSelectSession(fn: (p: Place) => void): Promise<() => void> {
  if (!inTauri()) return () => {};
  const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  return getCurrentWebviewWindow().listen<string>("select-session", (e) => fn(placeFromQuery(e.payload)));
}

export async function setWindowTitle(title: string) {
  document.title = title;
  if (!inTauri()) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow()
    .setTitle(title)
    .catch(() => {});
}
