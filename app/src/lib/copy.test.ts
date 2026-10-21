import { expect, test } from "bun:test";
import { joinRows, webLinks, type Row } from "./copy";

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

// Rows Claude Code 2.1.300 drew at 60 columns: a reply with a link too long for a row, a command
// it wrapped at a space, and a link after "see" that went on to rows of its own.
const URL = "https://example.com/some/really/long/path/that/keeps/going/and/going/and/going/forever?query=abcdefghijklmnop&x=1";
const claude60 = [
  "● https://example.com/some/really/long/path/that/keeps/going",
  "  /and/going/and/going/forever?query=abcdefghijklmnop&x=1",
  "",
  "  cd /Users/mbeato/blimp && bun test",
  "  app/src/lib/copy.test.ts && echo all-the-tests-passed-ok",
  "",
  "  see",
  "  https://example.com/some/really/long/path/that/keeps/going",
  "  /and/going/and/going/forever?query=abcdefghijklmnop&x=1",
  "  for details.",
];

test("a link or path Claude Code broke at the edge copies with nothing added; its wraps at spaces get them back", () => {
  expect(joinRows(rows(claude60), 60)).toBe(
    `● ${URL}\n\n  cd /Users/mbeato/blimp && bun test app/src/lib/copy.test.ts && echo all-the-tests-passed-ok\n\n  see ${URL} for details.`,
  );
  // The prompt, as Claude Code shows it after it's sent: a column short of the edge
  expect(joinRows(rows(["  https://example.com/some/really/long/path/that/keeps/goin", "  g/and/going/and/going/forever?query=abcdefghijklmnop&x=1", "  for details."]), 60)).toBe(`  ${URL} for details.`);
});

test("web links are found over the rows they were broken across, with where they start and end", () => {
  expect(webLinks(rows(claude60), 60)).toEqual([
    { url: URL, start: [0, 2], end: [1, 56] },
    { url: URL, start: [7, 2], end: [8, 56] },
  ]);
  // A link xterm wrapped, and one on a row of its own
  expect(webLinks(rows(["see https://a.example/bcd", "efg and", "https://b.example/x."], [1]), 25)).toEqual([
    { url: "https://a.example/bcdefg", start: [0, 4], end: [1, 2] },
    { url: "https://b.example/x", start: [2, 0], end: [2, 18] },
  ]);
});
