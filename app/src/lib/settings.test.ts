import { expect, mock, test } from "bun:test";
import { changeSettings, DEFAULTS, getSettings, readSettings, startSettings, textSize } from "./settings";

test("saved settings are checked field by field; anything odd is the default", () => {
  expect(readSettings(null)).toEqual(DEFAULTS);
  const s = readSettings({ theme: "dark", terminalFontSize: 99, editorFontSize: "big", cursorStyle: "bar", autosave: false, scrollback: 50, extra: 1 });
  expect(s.theme).toBe("dark");
  expect(s.terminalFontSize).toBe(28);
  expect(s.editorFontSize).toBe(13);
  expect(s.cursorStyle).toBe("bar");
  expect(s.autosave).toBe(false);
  expect(s.scrollback).toBe(1000);
  expect("extra" in s).toBe(false);
  expect(readSettings({ theme: "purple" }).theme).toBe("system");
});

test("Bigger and Smaller Text move both text sizes by one, inside what Settings allows; Default Text Size resets both", () => {
  const s = { ...DEFAULTS, terminalFontSize: 14, editorFontSize: 20 };
  expect(textSize(s, 1)).toEqual({ terminalFontSize: 15, editorFontSize: 21 });
  expect(textSize(s, -1)).toEqual({ terminalFontSize: 13, editorFontSize: 19 });
  expect(textSize({ ...s, terminalFontSize: 28 }, 1)).toEqual({ terminalFontSize: 28, editorFontSize: 21 });
  expect(textSize({ ...s, editorFontSize: 9 }, -1)).toEqual({ terminalFontSize: 13, editorFontSize: 9 });
  expect(textSize(s, 0)).toEqual({ terminalFontSize: DEFAULTS.terminalFontSize, editorFontSize: DEFAULTS.editorFontSize });
});

test("this window's own settings-changed event, back after a newer change here, is ignored; another window's applies", async () => {
  // The Mac app: Tauri hands each emit to every window, the sender too, when it gets to it.
  let deliver = (_: unknown) => {};
  const sent: unknown[] = [];
  mock.module("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: async () => {} }));
  mock.module("@tauri-apps/api/event", () => ({
    listen: async (_: string, f: (e: { payload: unknown }) => void) => ((deliver = (p) => f({ payload: p })), () => {}),
    emit: async (_: string, p: unknown) => void sent.push(p),
  }));
  mock.module("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setTheme: async () => {} }) }));
  mock.module("@tauri-apps/plugin-store", () => ({ load: async () => ({ get: async () => undefined, set: async () => {}, save: async () => {} }) }));
  const had = "document" in globalThis;
  if (!had) (globalThis as any).document = { documentElement: { dataset: {} } };
  try {
    await startSettings();
    expect(getSettings().terminalFontSize).toBe(13);
    // ⌘= twice, quickly: the first one's copy arrives after the second.
    const first = changeSettings(textSize(getSettings(), 1));
    const second = changeSettings(textSize(getSettings(), 1));
    await Promise.all([first, second]);
    expect(sent.length).toBe(2);
    deliver(sent[0]);
    expect(getSettings().terminalFontSize).toBe(15);
    deliver(sent[1]);
    expect(getSettings().terminalFontSize).toBe(15);
    // Another window's change.
    deliver({ ...DEFAULTS, terminalFontSize: 20, from: "another window" });
    expect(getSettings().terminalFontSize).toBe(20);
  } finally {
    if (!had) delete (globalThis as any).document;
  }
});
