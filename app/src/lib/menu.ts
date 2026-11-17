// The Mac menu bar, described by the page and drawn by Rust (src-tauri/src/menu.rs): the page
// knows what each command does now (lib/commands.ts and App's actions), and has no permission
// to build menus itself. The focused window sends its description; a click comes back as one
// "menu" event with the item's id. Pure apart from the two Tauri calls at the end.

import { invoke } from "@tauri-apps/api/core";
import { COMMANDS, type Action, type Key } from "./commands";
import { inTauri, type LinkStatus } from "./connection";

export type NativeName =
  | "about"
  | "hide"
  | "hide-others"
  | "show-all"
  | "quit"
  | "undo"
  | "redo"
  | "cut"
  | "copy"
  | "paste"
  | "select-all"
  | "minimize"
  | "zoom"
  | "fullscreen"
  | "bring-all-to-front";

// checked present: a check item. role: the menu macOS fills in itself (open windows, Help search).
export type MenuItem =
  | { kind: "separator" }
  | { kind: "native"; name: NativeName }
  | { kind: "command"; id: string; title: string; key?: string; enabled: boolean; checked?: boolean }
  | { kind: "submenu"; title: string; enabled: boolean; role?: "window" | "help"; items: MenuItem[] };

export type MenuState = {
  // What each command does in this window now (App's actions); none: greyed out.
  action: (id: string) => Action | undefined;
  // The saved servers, in order, with their display names. The status is not shown: a server
  // that can't be reached flips between offline and connecting every few seconds, and each
  // redraw would shut a menu that's open (the top bar and the Home tab show it).
  servers: { name: string; status: LinkStatus }[];
  // Which of them the front tab is on.
  front: number;
  // The front tab's server's recent folders, as shown ("~/proj").
  recent: string[];
};

// Rust does these itself, so the page needs no action for them. Close Window: the page may not
// close its window (no core:window:allow-close).
const RUST_DOES = new Set(["close-window"]);
const CHECKS = new Set(["toggle-files", "toggle-terminal", "toggle-sessions", "toggle-browsers"]);
// Rust refuses longer titles and control characters, and the whole menu with them.
const MAX_TITLE = 200;
const MAX_RECENT = 10;

// A key as muda reads it: "Cmd+Alt+Shift+BracketLeft". The physical key where the table has one.
export const accelerator = (k: Key) => ["Cmd", k.alt && "Alt", k.shift && "Shift", k.code ?? (k.key === "," ? "Comma" : k.key.toUpperCase())].filter(Boolean).join("+");

// A title Rust takes: a server's name or a folder can be anything.
export function fit(title: string): string {
  const t = title.replace(/\p{Cc}/gu, " ");
  const chars = [...t];
  return chars.length > MAX_TITLE ? chars.slice(0, MAX_TITLE - 1).join("") + "…" : t;
}

export function menuSpec(s: MenuState): MenuItem[] {
  const on = (id: string) => {
    const a = s.action(id);
    return RUST_DOES.has(id) || (!!a && a.enabled !== false);
  };
  const cmd = (id: string): MenuItem => {
    const c = COMMANDS.find((x) => x.id === id)!;
    const item: MenuItem = { kind: "command", id, title: c.title, enabled: on(id) };
    // pageOnly (⌘K): a menu key would take it from the editor, where it starts Monaco's chords.
    if (c.key && !c.pageOnly) item.key = accelerator(c.key);
    if (CHECKS.has(id)) item.checked = !!s.action(id)?.checked;
    return item;
  };
  const sep: MenuItem = { kind: "separator" };
  const native = (name: NativeName): MenuItem => ({ kind: "native", name });
  const menu = (title: string, items: MenuItem[], role?: "window" | "help"): MenuItem => ({ kind: "submenu", title, enabled: true, items, ...(role && { role }) });

  const recent: MenuItem[] = s.recent.slice(0, MAX_RECENT).map((dir, n) => ({ kind: "command", id: `recent:${n}`, title: fit(dir), enabled: on(`recent:${n}`) }));
  // No session counts or status: they change all the time, and each change would redraw the menu.
  const servers: MenuItem[] = s.servers.map((x, n) => ({
    kind: "command",
    id: `server:${n}`,
    title: fit(x.name),
    enabled: on(`server:${n}`),
    checked: n === s.front,
  }));

  return [
    menu("blimp", [native("about"), cmd("check-updates"), sep, cmd("settings"), sep, native("hide"), native("hide-others"), native("show-all"), sep, native("quit")]),
    menu("File", [
      cmd("new-claude"),
      cmd("new-shell"),
      cmd("new-browser-tab"),
      cmd("new-window"),
      sep,
      cmd("open-folder"),
      { kind: "submenu", title: "Open Recent", enabled: recent.length > 0, items: recent },
      cmd("quick-open"),
      sep,
      cmd("save"),
      sep,
      cmd("close-tab"),
      cmd("close-project"),
      cmd("close-window"),
    ]),
    menu("Edit", [native("undo"), native("redo"), sep, native("cut"), native("copy"), native("paste"), native("select-all")]),
    menu("View", [
      cmd("toggle-files"),
      cmd("toggle-terminal"),
      cmd("toggle-sessions"),
      cmd("toggle-browsers"),
      sep,
      cmd("palette"),
      sep,
      cmd("text-bigger"),
      cmd("text-smaller"),
      cmd("text-reset"),
      sep,
      native("fullscreen"),
    ]),
    menu("Server", [...servers, ...(servers.length ? [sep] : []), cmd("add-server"), cmd("manage-servers"), sep, cmd("reconnect"), cmd("update-server")]),
    menu("Window", [native("minimize"), native("zoom"), sep, cmd("prev-tab"), cmd("next-tab"), cmd("home"), sep, native("bring-all-to-front")], "window"),
    menu("Help", [cmd("shortcuts"), cmd("help"), cmd("report")], "help"),
  ];
}

// Rust ignores it from a window in the background (unless it's the only one).
export function setMenu(spec: MenuItem[]) {
  if (inTauri()) invoke("set_menu", { spec }).catch(() => {});
}

// A click on one of this window's menu items: the command's id.
export async function onMenu(fn: (id: string) => void): Promise<() => void> {
  if (!inTauri()) return () => {};
  const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  return getCurrentWebviewWindow().listen<string>("menu", (e) => fn(e.payload));
}
