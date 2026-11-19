// The app's commands in one table: the title a person sees, the menu it belongs to and its key.
// Plain data, so it's unit tested and the menu bar can be built from it. What a command does,
// and whether it's on or checked, App and the workbench in front say on each render (Action).
// Not here: the files tree's keys on a focused row (Workbench) and the terminal's (lib/keys.ts).

export type Menu = "blimp" | "File" | "View" | "Server" | "Window" | "Help";

// ⌘ is always held. code: matched on e.code instead of e.key, where ⌥ or ⇧ changes the character
// a Mac types (⌥B is "∫", ⇧[ is "{"); key is then only what's shown.
// chars: matched on the character instead (any of these), as the Mac menu matches its keys, so
// it follows the keyboard layout (AZERTY has "-" where US has "="); code is then the menu's key.
// anyShift: ⇧ may be held or not (⌘+ is ⇧⌘= on a US Mac). codeToo: code matches as well, ⇧ or
// not, for layouts where that key's character needs ⇧ (the digits on AZERTY).
export type Key = { key: string; shift?: true; alt?: true; code?: string; chars?: string[]; anyShift?: true; codeToo?: true };

// pageOnly: the key stays the page's and the menu item shows none. ⌘K inside the editor starts
// Monaco's chords, and a menu key would take it before the page sees it.
export type Command = { id: string; title: string; menu: Menu; key?: Key; pageOnly?: true };

export const COMMANDS: Command[] = [
  { id: "check-updates", title: "Check for Updates…", menu: "blimp" },
  { id: "settings", title: "Settings…", menu: "blimp", key: { key: "," } },

  { id: "new-claude", title: "New Claude Session", menu: "File", key: { key: "n" } },
  { id: "new-shell", title: "New Shell", menu: "File" },
  { id: "new-browser-tab", title: "New Browser Tab", menu: "File", key: { key: "t" } },
  { id: "new-window", title: "New Window", menu: "File", key: { key: "n", shift: true } },
  { id: "open-folder", title: "Open Folder…", menu: "File", key: { key: "o" } },
  { id: "quick-open", title: "Quick Open…", menu: "File", key: { key: "p" } },
  { id: "save", title: "Save", menu: "File", key: { key: "s" } },
  { id: "close-tab", title: "Close Tab", menu: "File", key: { key: "w" } },
  { id: "close-project", title: "Close Project", menu: "File" },
  { id: "close-window", title: "Close Window", menu: "File", key: { key: "w", shift: true } },

  { id: "toggle-files", title: "Files", menu: "View", key: { key: "b" } },
  { id: "toggle-terminal", title: "Terminal", menu: "View", key: { key: "j" } },
  { id: "toggle-sessions", title: "Sessions", menu: "View", key: { key: "b", alt: true, code: "KeyB" } },
  { id: "toggle-browsers", title: "Browser Tabs", menu: "View" },
  { id: "palette", title: "Jump to Session…", menu: "View", key: { key: "k" }, pageOnly: true },
  { id: "text-bigger", title: "Bigger Text", menu: "View", key: { key: "+", code: "Equal", chars: ["=", "+"], anyShift: true } },
  { id: "text-smaller", title: "Smaller Text", menu: "View", key: { key: "-", code: "Minus", chars: ["-"] } },
  { id: "text-reset", title: "Default Text Size", menu: "View", key: { key: "0", code: "Digit0", chars: ["0"], codeToo: true } },

  { id: "add-server", title: "Add Server…", menu: "Server" },
  { id: "manage-servers", title: "Manage Servers…", menu: "Server" },
  { id: "reconnect", title: "Reconnect", menu: "Server" },
  { id: "update-server", title: "Update Server…", menu: "Server" },
  { id: "usage", title: "Usage…", menu: "Server" },

  { id: "prev-tab", title: "Show Previous Tab", menu: "Window", key: { key: "[", shift: true, code: "BracketLeft" } },
  { id: "next-tab", title: "Show Next Tab", menu: "Window", key: { key: "]", shift: true, code: "BracketRight" } },
  { id: "home", title: "Go to Home", menu: "Window" },

  { id: "shortcuts", title: "Keyboard Shortcuts", menu: "Help" },
  { id: "help", title: "blimp Help", menu: "Help" },
  { id: "report", title: "Report a Problem…", menu: "Help" },
];
// Also commands, with ids made per item: "server:<n>" (the n-th saved server's Home) and
// "recent:<n>" (the n-th recent folder on the front tab's server), for the Server and Open Recent
// menus. App works them out from the id.

// Where the repository lives (the updater's address in src-tauri/tauri.conf.json).
export const REPO = "https://github.com/mbeato/blimp";

// The keys that aren't commands, for the Keyboard Shortcuts dialog.
export const OTHER_KEYS: { group: string; keys: string; title: string }[] = [
  { group: "Files pane", keys: "Enter or F2", title: "Rename the selected file or folder" },
  { group: "Files pane", keys: "⌘⌫", title: "Delete the selected file or folder" },
  { group: "Files pane", keys: "⌥⌘C", title: "Copy the path" },
  { group: "Files pane", keys: "⌥⇧⌘C", title: "Copy the relative path" },
  { group: "Terminal", keys: "⌘⌫", title: "Delete to the start of the line" },
  { group: "Terminal", keys: "⌥⌫", title: "Delete the word before" },
  { group: "Terminal", keys: "⌘← ⌘→", title: "Start or end of the line" },
  { group: "Terminal", keys: "⌥← ⌥→", title: "A word left or right" },
  { group: "Terminal", keys: "⇧Enter", title: "New line in Claude" },
  { group: "Terminal", keys: "⌘-click", title: "Open a path or a link" },
  { group: "Anywhere", keys: "↑ ↓ Enter", title: "Move and pick in a list" },
  { group: "Anywhere", keys: "Esc", title: "Close a dialog or menu" },
];

// As a Mac menu writes it: ⌥ then ⇧ then ⌘.
export const keyLabel = (k: Key) => `${k.alt ? "⌥" : ""}${k.shift ? "⇧" : ""}⌘${k.key.toUpperCase()}`;

type KeyEvent = { key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean };

const matches = (k: Key, e: KeyEvent) => {
  if (!!k.alt !== e.altKey) return false;
  if (k.codeToo && e.code === k.code) return true;
  if (!k.anyShift && !!k.shift !== e.shiftKey) return false;
  return k.chars ? k.chars.includes(e.key) : k.code ? e.code === k.code : e.key.toLowerCase() === k.key;
};

// The command a keydown is, if any. Control is never part of one: the terminal gets those.
export function commandForKey(e: KeyEvent): string | undefined {
  if (!e.metaKey || e.ctrlKey) return undefined;
  return COMMANDS.find((c) => c.key && matches(c.key, e))?.id;
}

export type Source = "key" | "menu";

// enabled false: the command does nothing, as its key did before; off says why where the app
// already said so (⌘O with no server connected).
export type Action = { run: (from: Source) => void; enabled?: boolean; checked?: boolean; off?: () => void };

// On a Mac the page gets a ⌘ key first and the menu gets it only if the page didn't handle it,
// but that differs by focus and by WebKit version. So one press may arrive from either side or
// from both: the second of a pair from the other side this soon after is the same press.
export const SAME_PRESS_MS = 250;

// Monaco gives up on a chord (⌘K, then its second key) 5 s after the ⌘K, and when the window
// loses focus (abstractKeybindingService's _scheduleLeaveChordMode); App drops it on blur. true:
// a key pressed at now, after ⌘K at startedAt (null: none), is the chord's second key, Monaco's.
export const CHORD_MS = 5000;
export const inChord = (now: number, startedAt: number | null) => startedAt !== null && now - startedAt < CHORD_MS;

// The one way a command runs. true: it's a command here (a key for it is used up), whether it
// ran, was off, or was the second half of a pair; false: nothing here does it.
export function runner(action: (id: string) => Action | undefined, now: () => number = Date.now) {
  let last: { id: string; from: Source; at: number } | null = null;
  return (id: string, from: Source): boolean => {
    const a = action(id);
    if (!a) return false;
    const at = now();
    if (last && last.id === id && last.from !== from && at - last.at < SAME_PRESS_MS) {
      last = null;
      return true;
    }
    last = { id, from, at };
    if (a.enabled === false) a.off?.();
    else a.run(from);
    return true;
  };
}
