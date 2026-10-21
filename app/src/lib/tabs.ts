// A window's project tabs: Home (the server's home folder) first, then one tab per open folder,
// each with the terminal splits it shows; and which panes are shown. Pure, so it's unit tested.
// The window keeps it in its URL (a reload stays put) and on the Mac (the next launch reopens it).

import type { Panes } from "./panes";
import { forget, show as showSession } from "./panes";
import { moved } from "./reorder";

export type Tab = Panes & {
  server: string;
  dir: string | null; // null: Home
  pageOrder?: string[]; // the browser tabs' order, once dragged (their ids)
};
// The buttons at the top right (and ⌘B, ⌘J, ⌘⌥B); browsers: the globe's, which hides the browser tabs.
export type Show = { files: boolean; term: boolean; sessions: boolean; browsers: boolean };
export type Layout = { tabs: Tab[]; active: number; show: Show };

const SHOW_ALL: Show = { files: true, term: true, sessions: true, browsers: true };

export const homeTab = (server: string): Tab => ({ server, dir: null, panes: [], focus: 0, groups: [] });
export const newLayout = (server: string): Layout => ({ tabs: [homeTab(server)], active: 0, show: SHOW_ALL });

// Stable across reorders, so React keeps each tab's workbench (open files, terminals) mounted.
export const tabKey = (t: Tab) => `${t.server}\n${t.dir ?? ""}`;

// Opens a folder in a new tab, or brings its tab to the front, and shows `session` there if given.
// dir null is Home, which is always the first tab: another server's Home replaces it.
export function openTab(l: Layout, server: string, dir: string | null, session?: string): Layout {
  const tabs = [...l.tabs];
  let i: number;
  if (dir === null) {
    i = 0;
    if (tabs[0].server !== server) tabs[0] = homeTab(server);
  } else {
    i = tabs.findIndex((t) => t.server === server && t.dir === dir);
    if (i < 0) i = tabs.push({ server, dir, panes: [], focus: 0, groups: [] }) - 1;
  }
  if (session) tabs[i] = { ...tabs[i], ...showSession(tabs[i], session) };
  return { ...l, tabs, active: i };
}

// Closes tab i (not Home). The tab to its right comes forward, else the one to its left.
export function closeTab(l: Layout, i: number): Layout {
  if (i <= 0 || i >= l.tabs.length) return l;
  const tabs = l.tabs.filter((_, j) => j !== i);
  const active = l.active > i ? l.active - 1 : l.active === i ? Math.min(i, tabs.length - 1) : l.active;
  return { ...l, tabs, active };
}

export const setPanes = (l: Layout, i: number, p: Panes): Layout => ({
  ...l,
  tabs: l.tabs.map((t, j) => (j === i ? { ...t, panes: p.panes, focus: p.focus, groups: p.groups, ...(p.order && { order: p.order }) } : t)),
});

// Project tab from dragged to the place `to` (Home stays first); the tab in front stays in front.
export function moveTab(l: Layout, from: number, to: number): Layout {
  to = Math.max(1, Math.min(to, l.tabs.length - 1));
  if (from <= 0 || from >= l.tabs.length || from === to) return l;
  const tabs = moved(l.tabs, from, to);
  return { ...l, tabs, active: tabs.indexOf(l.tabs[l.active]) };
}

export const setPageOrder = (l: Layout, i: number, pageOrder: string[]): Layout => ({ ...l, tabs: l.tabs.map((t, j) => (j === i ? { ...t, pageOrder } : t)) });

// Another window keeps "<server key>/<session>": it leaves every tab's splits and kept groups here.
// On the layout, not the terminal pane, so it works before a tab's pane is there (Home, at launch,
// before the server says where home is).
export function releaseSession(l: Layout, key: string): Layout {
  let out = l;
  l.tabs.forEach((t, i) => {
    if (!key.startsWith(t.server + "/")) return;
    const p = forget(t, [key.slice(t.server.length + 1)]);
    if (p !== t) out = setPanes(out, i, p);
  });
  return out;
}

export const encodeLayout = (l: Layout) => JSON.stringify(l);

// From the URL or the Mac's store: anything malformed is dropped rather than trusted.
export function decodeLayout(text: string): Layout | null {
  let v: any;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || !Array.isArray(v.tabs)) return null;
  const tabs: Tab[] = [];
  const seen = new Set<string>();
  for (const t of v.tabs) {
    if (!t || typeof t.server !== "string" || !(t.dir === null || typeof t.dir === "string")) continue;
    // Each folder once: two tabs for one folder would be one workbench shown twice.
    if (seen.has(tabKey(t)) && t.dir !== null) continue;
    seen.add(tabKey(t));
    const panes = Array.isArray(t.panes) ? t.panes.filter((n: unknown): n is string => typeof n === "string") : [];
    const focus = Number.isInteger(t.focus) && t.focus >= 0 && t.focus < panes.length ? t.focus : 0;
    // Kept split groups (missing in layouts saved before they existed): two or more names each,
    // and no session in two places.
    const used = new Set<string>(panes);
    const groups: string[][] = [];
    for (const g of Array.isArray(t.groups) ? t.groups : []) {
      if (!Array.isArray(g)) continue;
      const names = g.filter((n: unknown): n is string => typeof n === "string" && !used.has(n));
      if (names.length < 2) continue;
      names.forEach((n: string) => used.add(n));
      groups.push(names);
    }
    // The session list's order, once dragged.
    const order = Array.isArray(t.order) ? t.order.filter((n: unknown): n is string => typeof n === "string") : null;
    const pageOrder = Array.isArray(t.pageOrder) ? t.pageOrder.filter((n: unknown): n is string => typeof n === "string") : null;
    tabs.push({ server: t.server, dir: t.dir, panes, focus, groups, ...(order && { order }), ...(pageOrder && { pageOrder }) });
  }
  if (!tabs.length) return null;
  const front = tabs[Number.isInteger(v.active) ? Math.max(0, Math.min(v.active, tabs.length - 1)) : 0];
  // Only the first tab is Home; one is put there if missing.
  const home = tabs[0].dir === null ? tabs[0] : homeTab(tabs[0].server);
  const out = [home, ...tabs.filter((t) => t.dir !== null)];
  const s = v.show ?? {};
  const show = { files: s.files !== false, term: s.term !== false, sessions: s.sessions !== false, browsers: s.browsers !== false };
  return { tabs: out, active: Math.max(0, out.indexOf(front)), show };
}

// A project tab for a server's home folder is Home's: it closes (Home comes forward if it was in
// front). Only an odd URL or a stored layout has one; the app's own paths open Home instead.
export function dropHomeTabs(l: Layout, homeOf: (server: string) => string | undefined): Layout {
  const i = l.tabs.findIndex((t, j) => j > 0 && t.dir === homeOf(t.server));
  if (i < 0) return l;
  const front = l.active === i ? l.tabs[0] : l.tabs[l.active];
  const tabs = l.tabs.filter((_, j) => j !== i);
  return dropHomeTabs({ ...l, tabs, active: tabs.indexOf(front) }, homeOf);
}

// Tabs only for saved servers: a removed server's tabs close, and Home moves to the first server
// if its own was removed. null: no servers.
export function keepServers(l: Layout, servers: string[]): Layout | null {
  if (!servers.length) return null;
  if (l.tabs.every((t) => servers.includes(t.server))) return l;
  const front = l.tabs[l.active];
  const home = servers.includes(l.tabs[0].server) ? l.tabs[0] : homeTab(servers[0]);
  const tabs = [home, ...l.tabs.slice(1).filter((t) => servers.includes(t.server))];
  return { ...l, tabs, active: Math.max(0, tabs.indexOf(front)) };
}
