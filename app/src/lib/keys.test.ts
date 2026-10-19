import { expect, test } from "bun:test";
import { mapKey, type KeyLike } from "./keys";

const key = (key: string, mods: Partial<KeyLike> = {}, type = "keydown"): KeyLike => ({
  type,
  key,
  metaKey: false,
  altKey: false,
  ctrlKey: false,
  shiftKey: false,
  ...mods,
});

test("VS Code macOS line and word keys", () => {
  const cases: [KeyLike, string][] = [
    [key("Backspace", { metaKey: true }), "\x15"],
    [key("Backspace", { altKey: true }), "\x17"],
    [key("ArrowLeft", { metaKey: true }), "\x01"],
    [key("ArrowRight", { metaKey: true }), "\x05"],
    [key("ArrowLeft", { altKey: true }), "\x1bb"],
    [key("ArrowRight", { altKey: true }), "\x1bf"],
  ];
  for (const [e, data] of cases) expect(mapKey(e, false)).toEqual({ kind: "send", data });
});

test("mapped keys send once, on keydown only", () => {
  expect(mapKey(key("Backspace", { metaKey: true }, "keyup"), false)).toEqual({ kind: "skip" });
  expect(mapKey(key("ArrowLeft", { altKey: true }, "keypress"), false)).toEqual({ kind: "skip" });
});

test("⌘C copies only with a selection", () => {
  expect(mapKey(key("c", { metaKey: true }), true)).toEqual({ kind: "copy" });
  expect(mapKey(key("c", { metaKey: true }), false)).toEqual({ kind: "skip" });
});

test("⌘V, ⌘K and other ⌘ shortcuts are not sent to the terminal", () => {
  for (const k of ["v", "k", "n", "w", "1", "b", "p"]) expect(mapKey(key(k, { metaKey: true }), false)).toEqual({ kind: "skip" });
  expect(mapKey(key("N", { metaKey: true, shiftKey: true }), false)).toEqual({ kind: "skip" });
});

test("everything else goes to xterm", () => {
  expect(mapKey(key("a"), false)).toEqual({ kind: "xterm" });
  expect(mapKey(key("Backspace"), false)).toEqual({ kind: "xterm" });
  expect(mapKey(key("ArrowLeft"), false)).toEqual({ kind: "xterm" });
  expect(mapKey(key("c", { ctrlKey: true }), true)).toEqual({ kind: "xterm" });
  expect(mapKey(key("ArrowLeft", { altKey: true, shiftKey: true }), false)).toEqual({ kind: "xterm" });
});

test("Shift+Enter is a new line in Claude (ESC CR, as VS Code's /terminal-setup sends); a plain Enter in a shell", () => {
  expect(mapKey(key("Enter", { shiftKey: true }), false, true)).toEqual({ kind: "send", data: "\x1b\r" });
  expect(mapKey(key("Enter", { shiftKey: true }, "keypress"), false, true)).toEqual({ kind: "skip" });
  expect(mapKey(key("Enter", { shiftKey: true }), false, false)).toEqual({ kind: "xterm" });
  expect(mapKey(key("Enter"), false, true)).toEqual({ kind: "xterm" });
});
