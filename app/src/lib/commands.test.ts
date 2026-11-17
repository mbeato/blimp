import { expect, test } from "bun:test";
import { CHORD_MS, COMMANDS, commandForKey, inChord, keyLabel, runner, SAME_PRESS_MS, type Action, type Key } from "./commands";
import { mapKey } from "./keys";

// A keydown with ⌘ held, as a Mac sends it for this key.
const press = (k: Key, more: Partial<KeyboardEvent> = {}) => ({
  key: k.key,
  code: k.code ?? `Key${k.key.toUpperCase()}`,
  metaKey: true,
  ctrlKey: false,
  altKey: !!k.alt,
  shiftKey: !!k.shift,
  ...more,
});
const ev = (key: string, mods: { shift?: boolean; alt?: boolean; ctrl?: boolean; meta?: boolean; code?: string } = {}) => ({
  key,
  code: mods.code ?? "",
  metaKey: mods.meta ?? true,
  ctrlKey: !!mods.ctrl,
  altKey: !!mods.alt,
  shiftKey: !!mods.shift,
});

test("every command has a unique id, a title and a menu", () => {
  const ids = COMMANDS.map((c) => c.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const c of COMMANDS) {
    expect(c.id).toMatch(/^[a-z0-9-]{1,64}$/);
    expect(c.title.length).toBeGreaterThan(0);
    expect(["blimp", "File", "View", "Server", "Window", "Help"]).toContain(c.menu);
  }
});

test("no two commands share a key, and each key finds its own command", () => {
  const keyed = COMMANDS.filter((c) => c.key);
  const labels = keyed.map((c) => keyLabel(c.key!));
  expect(new Set(labels).size).toBe(labels.length);
  for (const c of keyed) expect(commandForKey(press(c.key!))).toBe(c.id);
});

test("no command takes a key the terminal or the system menu items use", () => {
  // The terminal's own: lib/keys.ts sends these to the shell or copies (⌘⌫ ⌘← ⌘→ ⌥⌫ ⌥← ⌥→ ⌘C).
  for (const c of COMMANDS.filter((c) => c.key)) {
    const k = c.key!;
    const e = { type: "keydown", key: k.key, metaKey: true, altKey: !!k.alt, ctrlKey: false, shiftKey: !!k.shift };
    expect(mapKey(e, true, true)).toEqual({ kind: "skip" });
  }
  // Paste, and the native Edit, Window and app menu items' keys.
  const taken = ["⌘V", "⌘C", "⌘X", "⌘A", "⌘Z", "⇧⌘Z", "⌘M", "⌘H", "⌥⌘H", "⌘Q"];
  for (const c of COMMANDS.filter((c) => c.key)) expect(taken).not.toContain(keyLabel(c.key!));
});

test("the existing shortcuts keep their keys", () => {
  const want: Record<string, string> = {
    settings: "⌘,",
    palette: "⌘K",
    "new-claude": "⌘N",
    "new-window": "⇧⌘N",
    "open-folder": "⌘O",
    "new-browser-tab": "⌘T",
    "quick-open": "⌘P",
    save: "⌘S",
    "close-tab": "⌘W",
    "toggle-files": "⌘B",
    "toggle-terminal": "⌘J",
    "toggle-sessions": "⌥⌘B",
  };
  for (const [id, label] of Object.entries(want)) expect(keyLabel(COMMANDS.find((c) => c.id === id)!.key!)).toBe(label);
});

test("keys are matched as the old handlers did: e.key for letters, e.code where ⌥ or ⇧ changes the character", () => {
  expect(commandForKey(ev("k"))).toBe("palette");
  expect(commandForKey(ev("K", { shift: true }))).toBeUndefined();
  expect(commandForKey(ev("N", { shift: true }))).toBe("new-window");
  expect(commandForKey(ev("n"))).toBe("new-claude");
  // ⌥B types "∫" on a Mac.
  expect(commandForKey(ev("∫", { alt: true, code: "KeyB" }))).toBe("toggle-sessions");
  expect(commandForKey(ev("∫", { alt: true, shift: true, code: "KeyB" }))).toBeUndefined();
  expect(commandForKey(ev("ç", { alt: true, code: "KeyC" }))).toBeUndefined();
  // ⇧[ types "{".
  expect(commandForKey(ev("{", { shift: true, code: "BracketLeft" }))).toBe("prev-tab");
  expect(commandForKey(ev("}", { shift: true, code: "BracketRight" }))).toBe("next-tab");
  expect(commandForKey(ev("=", { code: "Equal" }))).toBe("text-bigger");
  expect(commandForKey(ev("-", { code: "Minus" }))).toBe("text-smaller");
  expect(commandForKey(ev("0", { code: "Digit0" }))).toBe("text-reset");
  // ⇧⌘W is Close Window; ⌘W stays Close Tab.
  expect(commandForKey(ev("W", { shift: true }))).toBe("close-window");
  expect(commandForKey(ev("w"))).toBe("close-tab");
  expect(commandForKey(ev("s", { shift: true }))).toBeUndefined();
});

test("text size keys follow the character typed, as the Mac menu does, not the key's place", () => {
  // ⌘+ (⇧= on a US Mac) and ⌘=; on a German Mac "+" is where US has "]".
  expect(commandForKey(ev("+", { shift: true, code: "Equal" }))).toBe("text-bigger");
  expect(commandForKey(ev("+", { code: "BracketRight" }))).toBe("text-bigger");
  expect(commandForKey(ev("=", { code: "Slash" }))).toBe("text-bigger");
  // AZERTY: "-" on the key US has "="; Dvorak: "]" and "[" on US "=" and "-".
  expect(commandForKey(ev("-", { code: "Equal" }))).toBe("text-smaller");
  expect(commandForKey(ev("]", { code: "Equal" }))).toBeUndefined();
  expect(commandForKey(ev("[", { code: "Minus" }))).toBeUndefined();
  expect(commandForKey(ev("´", { code: "Equal" }))).toBeUndefined();
  // ⇧- is "_", not Smaller Text; ⌥ is never part of them.
  expect(commandForKey(ev("_", { shift: true, code: "Minus" }))).toBeUndefined();
  expect(commandForKey(ev("-", { shift: true, code: "Minus" }))).toBeUndefined();
  expect(commandForKey(ev("=", { alt: true, code: "Equal" }))).toBeUndefined();
  expect(commandForKey(ev("0", { alt: true, code: "Digit0" }))).toBeUndefined();
  // "0", or the 0 key where a digit needs ⇧ (AZERTY's "à").
  expect(commandForKey(ev("0", { code: "Numpad0" }))).toBe("text-reset");
  expect(commandForKey(ev("à", { code: "Digit0" }))).toBe("text-reset");
  expect(commandForKey(ev("0", { shift: true, code: "Digit0" }))).toBe("text-reset");
  expect(commandForKey(ev("0", { shift: true, code: "Numpad0" }))).toBeUndefined();
});

test("keys with Control held, or without ⌘, are not commands", () => {
  expect(commandForKey(ev("k", { ctrl: true }))).toBeUndefined();
  expect(commandForKey(ev("b", { meta: false }))).toBeUndefined();
  expect(commandForKey(ev("p", { meta: false, ctrl: true }))).toBeUndefined();
});

// A clock the test moves by hand.
function setup(actions: Record<string, Action>) {
  let t = 1000;
  const run = runner((id) => actions[id], () => t);
  return { run, tick: (ms: number) => (t += ms) };
}

test("the same command from the key and from the menu within 250 ms runs once", () => {
  let n = 0;
  const { run, tick } = setup({ "toggle-files": { run: () => n++ } });
  expect(run("toggle-files", "key")).toBe(true);
  tick(SAME_PRESS_MS - 1);
  expect(run("toggle-files", "menu")).toBe(true);
  expect(n).toBe(1);
  // Menu first, then the key.
  tick(1000);
  run("toggle-files", "menu");
  tick(10);
  run("toggle-files", "key");
  expect(n).toBe(2);
});

test("a second run from the same source, or after 250 ms, or of another command, runs", () => {
  let files = 0;
  let term = 0;
  const { run, tick } = setup({ "toggle-files": { run: () => files++ }, "toggle-terminal": { run: () => term++ } });
  run("toggle-files", "key");
  tick(10);
  run("toggle-files", "key");
  expect(files).toBe(2);
  tick(10);
  run("toggle-files", "menu");
  expect(files).toBe(2);
  tick(SAME_PRESS_MS);
  run("toggle-files", "key");
  tick(SAME_PRESS_MS);
  run("toggle-files", "menu");
  expect(files).toBe(4);
  tick(10);
  run("toggle-terminal", "menu");
  expect(term).toBe(1);
});

test("one pair is dropped once: key, menu, key in quick succession runs twice", () => {
  let n = 0;
  const { run, tick } = setup({ save: { run: () => n++ } });
  run("save", "key");
  tick(50);
  run("save", "menu");
  tick(50);
  run("save", "key");
  expect(n).toBe(2);
});

test("a disabled command does nothing but may say why; one with no action isn't handled", () => {
  let ran = 0;
  let said = 0;
  const { run } = setup({
    save: { run: () => ran++, enabled: false },
    "open-folder": { run: () => ran++, enabled: false, off: () => said++ },
  });
  expect(run("save", "key")).toBe(true);
  expect(run("open-folder", "key")).toBe(true);
  expect(ran).toBe(0);
  expect(said).toBe(1);
  expect(run("close-window", "key")).toBe(false);
});

test("the action learns where the command came from", () => {
  const from: string[] = [];
  const { run, tick } = setup({ settings: { run: (f) => from.push(f) } });
  run("settings", "key");
  tick(SAME_PRESS_MS);
  run("settings", "menu");
  expect(from).toEqual(["key", "menu"]);
});

test("a key after ⌘K in the editor is the chord's only within 5 s, as Monaco keeps it", () => {
  expect(CHORD_MS).toBe(5000);
  expect(inChord(1000, null)).toBe(false);
  expect(inChord(1000, 1000)).toBe(true);
  expect(inChord(1000 + CHORD_MS - 1, 1000)).toBe(true);
  expect(inChord(1000 + CHORD_MS, 1000)).toBe(false);
  expect(inChord(1000 + 6000, 1000)).toBe(false);
});

test("key labels are written as the Mac writes them", () => {
  expect(keyLabel({ key: "b", alt: true, code: "KeyB" })).toBe("⌥⌘B");
  expect(keyLabel({ key: "[", shift: true, code: "BracketLeft" })).toBe("⇧⌘[");
  expect(keyLabel({ key: "+", code: "Equal" })).toBe("⌘+");
});
