import { expect, test } from "bun:test";
import { joinRows, type Row } from "./copy";

// Rows as a terminal of `cols` shows them, all of each selected.
const rows = (lines: string[], wrapped: number[] = []): Row[] =>
  lines.map((l, i) => ({ full: l.trimEnd(), width: [...l.trimEnd()].length, wrapped: wrapped.includes(i), text: l.trimEnd() }));

test("a row xterm wrapped joins the one before, nothing in between", () => {
  expect(joinRows(rows(["abcdefghij", "klm"], [1]), 10)).toBe("abcdefghijklm");
});

test("a full row whose mark a redraw lost joins the next when that starts at the left edge", () => {
  expect(joinRows(rows(["w1 w2 w3 w", "4 w5"]), 10)).toBe("w1 w2 w3 w4 w5");
});

test("Claude Code's own wrap (indented, the next word didn't fit) goes back to a space", () => {
  const cols = 20;
  expect(joinRows(rows(["⏺ The toggle is in", "  Settings, under", "  Appearance."]), cols)).toBe("⏺ The toggle is in Settings, under Appearance.");
  // A full row followed by an indented one is Claude's wrap too, not xterm's
  expect(joinRows(rows(["⏺ abcdefgh ijklmnopq", "  rst"]), cols)).toBe("⏺ abcdefgh ijklmnopq rst");
});

test("real newlines stay: short lines, a next word that would have fit, blank lines, unindented lines", () => {
  const cols = 20;
  expect(joinRows(rows(["AAA one two", "  three four"]), cols)).toBe("AAA one two\n  three four");
  expect(joinRows(rows(["- first item here", "  x"]), cols)).toBe("- first item here\n  x");
  expect(joinRows(rows(["one long line here", "", "next"]), cols)).toBe("one long line here\n\nnext");
  expect(joinRows(rows(["$ some command arg1", "output"]), cols)).toBe("$ some command arg1\noutput");
});

test("only the selected part of the first and last rows is copied", () => {
  const r = rows(["⏺ The toggle is in", "  Settings, under"]);
  r[0].text = "toggle is in";
  r[1].text = "  Settings";
  expect(joinRows(r, 20)).toBe("toggle is in Settings");
  expect(joinRows([], 20)).toBe("");
});
