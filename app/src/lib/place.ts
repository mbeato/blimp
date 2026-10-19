// What a window shows (its project tabs) and the window plumbing around it.
// The Mac app can have several windows; Rust keeps track of them (src-tauri/src/windows.rs).
// A plain browser (development, e2e tests) has one window and does everything in it.

import { invoke } from "@tauri-apps/api/core";
import { inTauri } from "./connection";
import { decodeLayout, encodeLayout, newLayout, openTab, type Layout } from "./tabs";

// A place to open: a folder on a server (dir missing: Home), with a session to show there.
// A new window starts from one, and ⌘K in another window hands one over.
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

// A place as a window's tabs: Home, plus the folder's tab in front when it isn't Home.
export const layoutFor = (p: Place & { server: string }): Layout => openTab(newLayout(p.server), p.server, p.dir ?? null, p.session);

// The URL wins (it's kept current, so a reload stays put); a new window starts from the layout
// or place Rust handed it (window.__blimpInit). null: neither, so this is the app starting up.
export function readLayout(): Layout | null {
  for (const query of [location.search, (window as any).__blimpInit ?? ""]) {
    const saved = new URLSearchParams(query).get("layout");
    const l = saved ? decodeLayout(saved) : null;
    if (l) return l;
    const p = placeFromQuery(query);
    if (p.server) return layoutFor({ ...p, server: p.server });
  }
  return null;
}

// A layout as a query, keeping base's other keys (the browser build's ?blimpd=&token=).
export function layoutQuery(l: Layout, base = ""): string {
  const q = new URLSearchParams(placeQuery({}, base));
  q.set("layout", encodeLayout(l));
  return q.toString();
}

export function writeLayout(l: Layout) {
  history.replaceState(null, "", `?${layoutQuery(l, location.search)}`);
}

// The key Rust matches windows by: (server, folder). A window has one per tab.
export const projectKey = (server: string, dir: string) => `${server}\n${dir}`;

// A new window starting from a place (⌘⇧N: Home) or a layout (Open in New Window). The browser
// build opens a new browser window on the same blimpd.
export async function openWindow(start: Place | Layout) {
  const init = (base: string) => ("tabs" in start ? layoutQuery(start, base) : placeQuery(start, base));
  if (inTauri()) await invoke("open_window", { init: init("") });
  else window.open(`${location.pathname}?${init(location.search)}`, "_blank");
}

// A session dragged out of this window, let go at (x, y) on screen. "moved": another window was
// there and took it. "new": a new window opened there with it.
export async function dropSession(p: Place, x: number, y: number): Promise<"moved" | "new"> {
  if (!inTauri()) {
    await openWindow(p);
    return "new";
  }
  return (await invoke<boolean>("drop_session", { init: placeQuery(p), x, y })) ? "moved" : "new";
}

// A session from another window was let go here, at (x, y) in this page.
export async function onDropSession(fn: (p: Place, x: number, y: number) => void): Promise<() => void> {
  if (!inTauri()) return () => {};
  const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  return getCurrentWebviewWindow().listen<{ init: string; x: number; y: number }>("drop-session", (e) => fn(placeFromQuery(e.payload.init), e.payload.x, e.payload.y));
}

// ⌘K to a folder that another window has in a tab: focus that window, which then shows the
// session (it gets "select-session"). false: no other window has it.
export async function focusProject(p: Place & { server: string; dir: string }): Promise<boolean> {
  if (!inTauri()) return false;
  return invoke<boolean>("focus_project", { project: projectKey(p.server, p.dir), init: placeQuery(p) }).catch(() => false);
}

export function setWindowProjects(keys: string[]) {
  if (inTauri()) invoke("set_window_projects", { projects: keys }).catch(() => {});
}

// The sessions on screen in this window ("<server key>/<name>") while it has focus: no
// notification for them from any window.
export function setViewing(sessions: string[]) {
  if (inTauri()) invoke("set_viewing", { sessions }).catch(() => {});
}

// One notification per wait across every window. The browser build has one window.
export async function claimNotice(session: string, key: string): Promise<boolean> {
  if (!inTauri()) return true;
  return invoke<boolean>("claim_notice", { session, key }).catch(() => true);
}

// ⌘K in another window picked a session in a folder this window has a tab for.
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

// Every session this window has in a split, in any tab ("<server key>/<name>"). Resolves to what
// every window shows, by window label, as does each "shown" event after it.
export type Shown = Record<string, string[]>;
export async function setShown(sessions: string[]): Promise<Shown> {
  if (!inTauri()) return {};
  return invoke<Shown>("set_shown", { sessions }).catch(() => ({}));
}

export async function onShown(fn: (s: Shown, me: string) => void): Promise<() => void> {
  if (!inTauri()) return () => {};
  const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const w = getCurrentWebviewWindow();
  return w.listen<Shown>("shown", (e) => fn(e.payload, w.label));
}

export async function windowLabel(): Promise<string> {
  if (!inTauri()) return "";
  const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  return getCurrentWebviewWindow().label;
}

// Another window closed and this one was used most recently of the ones left: save this
// window's tabs for the next launch.
export async function onRememberLayout(fn: () => void): Promise<() => void> {
  if (!inTauri()) return () => {};
  const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  return getCurrentWebviewWindow().listen("remember-layout", () => fn());
}

// A click on a session another window shows: that window comes forward and shows it.
export async function focusSession(p: Place & { server: string; session: string }): Promise<boolean> {
  if (!inTauri()) return false;
  return invoke<boolean>("focus_session", { session: `${p.server}/${p.session}`, init: placeQuery(p) }).catch(() => false);
}

// This window took a session into a split: other windows showing it let it go.
export function takeSession(key: string) {
  if (inTauri()) invoke("take_session", { session: key }).catch(() => {});
}

export async function onReleaseSession(fn: (key: string) => void): Promise<() => void> {
  if (!inTauri()) return () => {};
  const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  return getCurrentWebviewWindow().listen<string>("release-session", (e) => fn(e.payload));
}
