import { expect, test } from "bun:test";
import { keyMessage, modifiers, mouseMessage, wheelMessage } from "./serverview";

const key = (k: string, extra: Partial<KeyboardEvent> = {}) =>
  ({ key: k, code: extra.code ?? `Key${k.toUpperCase()}`, keyCode: extra.keyCode ?? k.toUpperCase().charCodeAt(0), metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, ...extra }) as KeyboardEvent;

test("modifiers as CDP counts them", () => {
  expect(modifiers({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true } as KeyboardEvent)).toBe(15);
  expect(modifiers({ shiftKey: true } as KeyboardEvent)).toBe(8);
});

test("a typed character goes as a key with its text; special keys without, Enter with \\r", () => {
  expect(keyMessage(key("a"), "down")).toEqual({ type: "key", event: "keyDown", key: "a", code: "KeyA", keyCode: 65, text: "a", modifiers: 0 });
  expect(keyMessage(key("A", { shiftKey: true }), "down")).toMatchObject({ text: "A", modifiers: 8 });
  // ⌥e on a Mac gives é: typed text, not a shortcut.
  expect(keyMessage(key("é", { altKey: true, code: "KeyE", keyCode: 69 }), "down")).toMatchObject({ event: "keyDown", text: "é", modifiers: 0 });
  expect(keyMessage(key("Enter", { code: "Enter", keyCode: 13 }), "down")).toMatchObject({ event: "keyDown", text: "\r" });
  expect(keyMessage(key("Backspace", { code: "Backspace", keyCode: 8 }), "down")).toEqual({ type: "key", event: "rawKeyDown", key: "Backspace", code: "Backspace", keyCode: 8, modifiers: 0 });
  expect(keyMessage(key("ArrowLeft", { code: "ArrowLeft", keyCode: 37, shiftKey: true }), "down")).toMatchObject({ event: "rawKeyDown", modifiers: 8 });
  expect(keyMessage(key("a"), "up")).toEqual({ type: "key", event: "keyUp", key: "a", code: "KeyA", keyCode: 65, modifiers: 0 });
});

test("⌘ editing keys become Ctrl for the server's Chrome; ⌘C, ⌘X and ⌘V go through the clipboard; other ⌘ keys stay the app's", () => {
  expect(keyMessage(key("a", { metaKey: true }), "down")).toEqual({ type: "key", event: "rawKeyDown", key: "a", code: "KeyA", keyCode: 65, modifiers: 2 });
  expect(keyMessage(key("z", { metaKey: true, shiftKey: true }), "down")).toMatchObject({ key: "z", modifiers: 10 });
  for (const k of ["c", "x", "v", "w", "t", "k", "l", "1"]) expect(keyMessage(key(k, { metaKey: true }), "down")).toBeNull();
  // ⌘← and ⌘→: line start and end, as Home and End.
  expect(keyMessage(key("ArrowLeft", { metaKey: true, code: "ArrowLeft", keyCode: 37 }), "down")).toMatchObject({ key: "Home", code: "Home", keyCode: 36, modifiers: 0 });
  // Ctrl stays Ctrl.
  expect(keyMessage(key("c", { ctrlKey: true }), "down")).toMatchObject({ event: "rawKeyDown", modifiers: 2 });
});

test("while composing (an input method), keys are the text field's", () => {
  expect(keyMessage(key("Process", { isComposing: true }), "down")).toBeNull();
  expect(keyMessage(key("Dead", { code: "KeyE", keyCode: 69 }), "down")).toBeNull();
});

test("mouse and wheel, in the page's coordinates", () => {
  const rect = { left: 100, top: 50 } as DOMRect;
  const m = { clientX: 130, clientY: 70, button: 0, buttons: 1, detail: 2, altKey: false, ctrlKey: false, metaKey: false, shiftKey: true } as MouseEvent;
  expect(mouseMessage(m, "mousePressed", rect)).toEqual({ type: "mouse", event: "mousePressed", x: 30, y: 20, button: "left", buttons: 1, clickCount: 2, modifiers: 8 });
  expect(mouseMessage({ ...m, button: 2, buttons: 2 } as MouseEvent, "mousePressed", rect)).toMatchObject({ button: "right", buttons: 2 });
  // A move with the left button held is a drag.
  expect(mouseMessage({ ...m, button: 0, buttons: 1, detail: 0 } as MouseEvent, "mouseMoved", rect)).toMatchObject({ button: "left", clickCount: 0 });
  expect(mouseMessage({ ...m, buttons: 0, detail: 0 } as MouseEvent, "mouseMoved", rect)).toMatchObject({ button: "none" });
  const w = { clientX: 110, clientY: 60, deltaX: 0, deltaY: 3, deltaMode: 1, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false } as WheelEvent;
  expect(wheelMessage(w, rect)).toEqual({ type: "mouse", event: "mouseWheel", x: 10, y: 10, button: "none", buttons: 0, clickCount: 0, modifiers: 0, deltaX: 0, deltaY: 48 });
});
