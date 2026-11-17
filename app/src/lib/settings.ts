// Settings (⌘, or blimp > Settings…), kept on this Mac (the store plugin; localStorage in a
// browser) and shared by every window: a change in one shows in all of them at once.

import { useEffect, useReducer } from "react";
import { inTauri } from "./connection";

export type Settings = {
  theme: "system" | "light" | "dark";
  terminalFontSize: number;
  editorFontSize: number;
  cursorStyle: "block" | "bar" | "underline";
  cursorBlink: boolean;
  scrollback: number;
  optionIsMeta: boolean; // Option+letter sends Esc+letter, for shell and editor shortcuts
  autosave: boolean;
  wordWrap: boolean;
  minimap: boolean;
  notifications: boolean;
  dockBadge: boolean;
  autoUpdate: boolean;
};

export const DEFAULTS: Settings = {
  theme: "system",
  terminalFontSize: 13,
  editorFontSize: 13,
  cursorStyle: "block",
  cursorBlink: false,
  scrollback: 10000,
  optionIsMeta: false,
  autosave: true,
  wordWrap: false,
  minimap: false,
  notifications: true,
  dockBadge: true,
  autoUpdate: true,
};

// The text sizes Settings allows, in points.
const FONT_MIN = 9;
const FONT_MAX = 28;

const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.round(Math.min(hi, Math.max(lo, v))) : d);
const pick = <T extends string>(v: unknown, ok: readonly T[], d: T): T => (ok.includes(v as T) ? (v as T) : d);
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);

// What was saved, checked field by field: anything missing or odd is the default.
export function readSettings(v: any): Settings {
  const d = DEFAULTS;
  if (!v || typeof v !== "object") return { ...d };
  return {
    theme: pick(v.theme, ["system", "light", "dark"] as const, d.theme),
    terminalFontSize: num(v.terminalFontSize, FONT_MIN, FONT_MAX, d.terminalFontSize),
    editorFontSize: num(v.editorFontSize, FONT_MIN, FONT_MAX, d.editorFontSize),
    cursorStyle: pick(v.cursorStyle, ["block", "bar", "underline"] as const, d.cursorStyle),
    cursorBlink: bool(v.cursorBlink, d.cursorBlink),
    scrollback: num(v.scrollback, 1000, 100000, d.scrollback),
    optionIsMeta: bool(v.optionIsMeta, d.optionIsMeta),
    autosave: bool(v.autosave, d.autosave),
    wordWrap: bool(v.wordWrap, d.wordWrap),
    minimap: bool(v.minimap, d.minimap),
    notifications: bool(v.notifications, d.notifications),
    dockBadge: bool(v.dockBadge, d.dockBadge),
    autoUpdate: bool(v.autoUpdate, d.autoUpdate),
  };
}

// Bigger Text (by 1), Smaller Text (by -1) and Default Text Size (0): the terminal's and the
// editor's sizes together, for changeSettings.
export function textSize(s: Settings, by: 1 | -1 | 0): Pick<Settings, "terminalFontSize" | "editorFontSize"> {
  const step = (n: number) => Math.min(FONT_MAX, Math.max(FONT_MIN, n + by));
  if (!by) return { terminalFontSize: DEFAULTS.terminalFontSize, editorFontSize: DEFAULTS.editorFontSize };
  return { terminalFontSize: step(s.terminalFontSize), editorFontSize: step(s.editorFontSize) };
}

const LS_KEY = "blimp.settings";
let current: Settings = { ...DEFAULTS };
const subs = new Set<() => void>();
const media = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: light)") : null;

export const getSettings = () => current;

// Light or dark right now: the Theme setting, or the system's.
export const isLight = () => current.theme === "light" || (current.theme === "system" && !!media?.matches);

function apply(next: Settings) {
  current = next;
  const html = document.documentElement;
  if (next.theme === "system") delete html.dataset.theme;
  else html.dataset.theme = next.theme;
  if (inTauri())
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) =>
      getCurrentWindow()
        .setTheme(next.theme === "system" ? null : next.theme)
        .catch(() => {}),
    );
  subs.forEach((f) => f());
}

// Every change, and the system switching light/dark.
export function onSettings(f: () => void) {
  subs.add(f);
  return () => void subs.delete(f);
}
media?.addEventListener("change", () => subs.forEach((f) => f()));

async function load(): Promise<Settings> {
  try {
    if (inTauri()) {
      const { load } = await import("@tauri-apps/plugin-store");
      return readSettings(await (await load("settings.json")).get("settings"));
    }
    return readSettings(JSON.parse(localStorage.getItem(LS_KEY) ?? "null"));
  } catch {
    return { ...DEFAULTS };
  }
}

// This window, in the settings-changed events it sends. Tauri hands an event to every window,
// the one that sent it too, and that copy may come back after a newer change made here (⌘= ⌘=
// quickly): applied, it would undo that change.
const me = Math.random().toString(36).slice(2);

// Once, at startup; other windows' changes arrive as events.
export async function startSettings() {
  apply(await load());
  if (inTauri()) {
    const { listen } = await import("@tauri-apps/api/event");
    await listen<Settings & { from?: string }>("settings-changed", (e) => e.payload?.from !== me && apply(readSettings(e.payload)));
  } else window.addEventListener("storage", (e) => e.key === LS_KEY && apply(readSettings(JSON.parse(e.newValue ?? "null"))));
}

export async function changeSettings(patch: Partial<Settings>) {
  const next = readSettings({ ...current, ...patch });
  apply(next);
  try {
    if (inTauri()) {
      const { load } = await import("@tauri-apps/plugin-store");
      const store = await load("settings.json");
      await store.set("settings", next);
      await store.save();
      const { emit } = await import("@tauri-apps/api/event");
      await emit("settings-changed", { ...next, from: me });
    } else localStorage.setItem(LS_KEY, JSON.stringify(next));
  } catch {}
}

// The settings, re-rendering on every change.
export function useSettings(): Settings {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => onSettings(rerender), []);
  return current;
}
