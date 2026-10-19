import { expect, test } from "bun:test";
import { DEFAULTS, readSettings } from "./settings";

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
