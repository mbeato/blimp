// Recent projects, per server, kept on this Mac (the store plugin; localStorage in a browser).
// Also which server Home opened last, and the last window's tabs, which the next launch reopens.

import { inTauri } from "./connection";
import { decodeLayout, encodeLayout, type Layout } from "./tabs";

export type Recent = { dir: string; at: number };
type Saved = { projects: Record<string, Recent[]>; lastServer?: string; layout?: string };

const MAX = 20;
const LS_KEY = "blimp.recent";

export function addRecent(list: Recent[], dir: string, at: number): Recent[] {
  return [{ dir, at }, ...list.filter((r) => r.dir !== dir)].slice(0, MAX);
}

export const dropRecent = (list: Recent[], dir: string) => list.filter((r) => r.dir !== dir);

async function load(): Promise<Saved> {
  try {
    if (inTauri()) {
      const { load } = await import("@tauri-apps/plugin-store");
      const store = await load("recent.json");
      return {
        projects: (await store.get<Saved["projects"]>("projects")) ?? {},
        lastServer: await store.get<string>("lastServer"),
        layout: await store.get<string>("layout"),
      };
    }
    const saved = JSON.parse(localStorage.getItem(LS_KEY) ?? "null");
    if (saved && typeof saved === "object" && saved.projects) return saved;
  } catch {}
  return { projects: {} };
}

async function save(s: Saved) {
  try {
    if (inTauri()) {
      const { load } = await import("@tauri-apps/plugin-store");
      const store = await load("recent.json");
      await store.set("projects", s.projects);
      if (s.lastServer) await store.set("lastServer", s.lastServer);
      if (s.layout) await store.set("layout", s.layout);
      await store.save();
      return;
    }
    localStorage.setItem(LS_KEY, JSON.stringify(s));
  } catch {}
}

export async function recentProjects(server: string): Promise<Recent[]> {
  return (await load()).projects[server] ?? [];
}

export const lastServer = async () => (await load()).lastServer;

// Read fresh each time: another window may have changed the list. Changes from this window go
// one at a time, so two quick ones don't each save over the other.
let queue: Promise<unknown> = Promise.resolve();
const change = (f: (s: Saved) => void) =>
  (queue = queue.then(async () => {
    const s = await load();
    f(s);
    await save(s);
  }));

export const rememberProject = (server: string, dir: string | null) =>
  change((s) => {
    if (dir) s.projects[server] = addRecent(s.projects[server] ?? [], dir, Date.now());
    s.lastServer = server;
  });

export const forgetProject = (server: string, dir: string) =>
  change((s) => void (s.projects[server] = dropRecent(s.projects[server] ?? [], dir)));

// Every change to a window's tabs. With several windows, the one changed last is what reopens.
export const rememberLayout = (l: Layout) => change((s) => void (s.layout = encodeLayout(l)));

export async function lastLayout(): Promise<Layout | null> {
  const saved = (await load()).layout;
  return saved ? decodeLayout(saved) : null;
}
