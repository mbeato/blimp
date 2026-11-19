import { expect, test } from "bun:test";
import { COMMANDS, type Action } from "./commands";
import { accelerator, fit, menuSpec, type MenuItem, type MenuState } from "./menu";

const run = () => {};
// Every command on, the panels as given, except where a test says otherwise.
const state = (more: Partial<MenuState> = {}, actions: Record<string, Action | undefined> = {}): MenuState => ({
  action: (id) => (id in actions ? actions[id] : { run }),
  servers: [
    { name: "claude1", status: "connected" },
    { name: "Lab", status: "offline" },
    { name: "gpu", status: "connecting" },
  ],
  front: 1,
  recent: ["~/proj", "/srv/data"],
  ...more,
});

type Sub = Extract<MenuItem, { kind: "submenu" }>;
type Cmd = Extract<MenuItem, { kind: "command" }>;
const menuOf = (spec: MenuItem[], title: string) => spec.find((m): m is Sub => m.kind === "submenu" && m.title === title)!;
const all = (items: MenuItem[]): MenuItem[] => items.flatMap((i) => (i.kind === "submenu" ? [i, ...all(i.items)] : [i]));
const commands = (items: MenuItem[]) => all(items).filter((i): i is Cmd => i.kind === "command");
const byId = (spec: MenuItem[], id: string) => commands(spec).find((c) => c.id === id)!;
// A menu's entries in short: a command's title, a native item's name, "—" for a separator.
const outline = (m: Sub) => m.items.map((i) => (i.kind === "command" ? i.title : i.kind === "native" ? i.name : i.kind === "separator" ? "—" : `${i.title} ▸`));

test("the menu bar has the seven menus in order, Window and Help registered with macOS", () => {
  const spec = menuSpec(state());
  expect(spec.map((m) => (m.kind === "submenu" ? m.title : "?"))).toEqual(["blimp", "File", "Edit", "View", "Server", "Window", "Help"]);
  expect(menuOf(spec, "Window").role).toBe("window");
  expect(menuOf(spec, "Help").role).toBe("help");
  expect(spec.filter((m) => m.kind === "submenu" && m.role).length).toBe(2);
});

test("each menu holds what the plan lists", () => {
  const spec = menuSpec(state());
  expect(outline(menuOf(spec, "blimp"))).toEqual(["about", "Check for Updates…", "—", "Settings…", "—", "hide", "hide-others", "show-all", "—", "quit"]);
  expect(outline(menuOf(spec, "File"))).toEqual([
    "New Claude Session",
    "New Shell",
    "New Browser Tab",
    "New Window",
    "—",
    "Open Folder…",
    "Open Recent ▸",
    "Quick Open…",
    "—",
    "Save",
    "—",
    "Close Tab",
    "Close Project",
    "Close Window",
  ]);
  expect(outline(menuOf(spec, "Edit"))).toEqual(["undo", "redo", "—", "cut", "copy", "paste", "select-all"]);
  expect(outline(menuOf(spec, "View"))).toEqual(["Files", "Terminal", "Sessions", "Browser Tabs", "—", "Jump to Session…", "—", "Bigger Text", "Smaller Text", "Default Text Size", "—", "fullscreen"]);
  expect(outline(menuOf(spec, "Server"))).toEqual(["claude1", "Lab", "gpu", "—", "Add Server…", "Manage Servers…", "—", "Reconnect", "Update Server…", "—", "Usage…"]);
  expect(outline(menuOf(spec, "Window"))).toEqual(["minimize", "zoom", "—", "Show Previous Tab", "Show Next Tab", "Go to Home", "—", "bring-all-to-front"]);
  expect(outline(menuOf(spec, "Help"))).toEqual(["Keyboard Shortcuts", "blimp Help", "Report a Problem…"]);
});

test("every command in the table is in the menu once, with its key as muda writes it", () => {
  const spec = menuSpec(state());
  const ids = commands(spec).map((c) => c.id);
  for (const c of COMMANDS) expect(ids.filter((id) => id === c.id).length).toBe(1);
  expect(byId(spec, "settings").key).toBe("Cmd+Comma");
  expect(byId(spec, "new-claude").key).toBe("Cmd+N");
  expect(byId(spec, "new-window").key).toBe("Cmd+Shift+N");
  expect(byId(spec, "close-window").key).toBe("Cmd+Shift+W");
  expect(byId(spec, "toggle-sessions").key).toBe("Cmd+Alt+KeyB");
  expect(byId(spec, "prev-tab").key).toBe("Cmd+Shift+BracketLeft");
  expect(byId(spec, "next-tab").key).toBe("Cmd+Shift+BracketRight");
  expect(byId(spec, "text-bigger").key).toBe("Cmd+Equal");
  expect(byId(spec, "text-smaller").key).toBe("Cmd+Minus");
  expect(byId(spec, "text-reset").key).toBe("Cmd+Digit0");
  expect(byId(spec, "new-shell").key).toBeUndefined();
});

test("Jump to Session has no menu key: ⌘K stays the page's, for Monaco's chords", () => {
  const palette = byId(menuSpec(state()), "palette");
  expect(palette.title).toBe("Jump to Session…");
  expect(palette.key).toBeUndefined();
  expect(palette.enabled).toBe(true);
});

test("the panels are check items that follow the window", () => {
  const spec = menuSpec(state({}, { "toggle-files": { run, checked: true }, "toggle-terminal": { run, checked: false }, "toggle-sessions": { run, checked: true }, "toggle-browsers": { run, checked: true, enabled: false } }));
  expect(byId(spec, "toggle-files").checked).toBe(true);
  expect(byId(spec, "toggle-terminal").checked).toBe(false);
  expect(byId(spec, "toggle-sessions").checked).toBe(true);
  expect(byId(spec, "toggle-browsers")).toMatchObject({ checked: true, enabled: false });
  // Only those and the servers carry a tick at all.
  const checkable = commands(spec).filter((c) => c.checked !== undefined).map((c) => c.id);
  expect(checkable).toEqual(["toggle-files", "toggle-terminal", "toggle-sessions", "toggle-browsers", "server:0", "server:1", "server:2"]);
});

test("a command that's off, or not offered here, is greyed out; Close Window is Rust's", () => {
  const spec = menuSpec(state({}, { save: { run, enabled: false }, "update-server": undefined, "close-window": undefined, "open-folder": { run, enabled: false, off: run } }));
  expect(byId(spec, "save").enabled).toBe(false);
  expect(byId(spec, "update-server").enabled).toBe(false);
  expect(byId(spec, "open-folder").enabled).toBe(false);
  expect(byId(spec, "close-window").enabled).toBe(true);
  expect(byId(spec, "new-claude").enabled).toBe(true);
});

test("the Server menu lists every server by name, ticks the front tab's, and goes to its Home", () => {
  const spec = menuSpec(state());
  const servers = commands(spec).filter((c) => c.id.startsWith("server:"));
  expect(servers.map((c) => [c.id, c.title, c.checked])).toEqual([
    ["server:0", "claude1", false],
    ["server:1", "Lab", true],
    ["server:2", "gpu", false],
  ]);
  // One server: still listed, ticked; none: no list and no separator before Add Server….
  expect(outline(menuOf(menuSpec(state({ servers: [{ name: "lab", status: "connected" }], front: 0 })), "Server"))[0]).toBe("lab");
  expect(outline(menuOf(menuSpec(state({ servers: [], front: -1 })), "Server"))).toEqual(["Add Server…", "Manage Servers…", "—", "Reconnect", "Update Server…", "—", "Usage…"]);
});

test("a server going between offline and connecting doesn't change the description, so the menu isn't redrawn", () => {
  const as = (status: "offline" | "connecting") => JSON.stringify(menuSpec(state({ servers: [{ name: "Lab", status }], front: 0 })));
  expect(as("offline")).toBe(as("connecting"));
});

test("Open Recent lists the front server's recent folders, and is off when there are none", () => {
  const spec = menuSpec(state({}, { "recent:1": { run, enabled: false } }));
  const open = menuOf(spec, "File").items.find((i): i is Sub => i.kind === "submenu")!;
  expect(open).toMatchObject({ title: "Open Recent", enabled: true });
  expect(open.items).toEqual([
    { kind: "command", id: "recent:0", title: "~/proj", enabled: true },
    { kind: "command", id: "recent:1", title: "/srv/data", enabled: false },
  ]);
  const many = menuSpec(state({ recent: Array.from({ length: 15 }, (_, i) => `~/p${i}`) }));
  expect(commands(many).filter((c) => c.id.startsWith("recent:")).length).toBe(10);
  const none = menuOf(menuSpec(state({ recent: [] })), "File").items.find((i): i is Sub => i.kind === "submenu")!;
  expect(none).toMatchObject({ enabled: false, items: [] });
});

test("titles are cut to what Rust takes, and lose control characters", () => {
  expect(fit("Lab")).toBe("Lab");
  expect(fit("a\nb\tc")).toBe("a b c");
  const long = fit("é".repeat(300));
  expect([...long].length).toBe(200);
  expect(long.endsWith("…")).toBe(true);
  const spec = menuSpec(state({ servers: [{ name: "x".repeat(250), status: "offline" }], front: 0 }));
  expect([...byId(spec, "server:0").title].length).toBe(200);
});

test("every id and title is one Rust takes, and the menu is well under its 400 items", () => {
  const spec = menuSpec(state({ recent: Array.from({ length: 10 }, (_, i) => `~/p${i}`) }));
  for (const c of commands(spec)) {
    expect(c.id).toMatch(/^[a-z0-9:-]{1,64}$/);
    expect([...c.title].length).toBeLessThanOrEqual(200);
  }
  expect(all(spec).length).toBeLessThan(150);
});

test("accelerator writes ⌘ first, then ⌥ and ⇧, then the key", () => {
  expect(accelerator({ key: "k" })).toBe("Cmd+K");
  expect(accelerator({ key: ",", shift: true })).toBe("Cmd+Shift+Comma");
  expect(accelerator({ key: "b", alt: true, shift: true, code: "KeyB" })).toBe("Cmd+Alt+Shift+KeyB");
});
