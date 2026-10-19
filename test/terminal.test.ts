// test/terminal.test.ts
import { expect, test } from "bun:test";
import { followSize, lastSize, setSize } from "../src/terminal";

test("lastSize defaults to 120x36, follows setSize, and tells followers", () => {
  expect(lastSize("blimpunit-x")).toEqual({ cols: 120, rows: 36 });
  const seen: number[][] = [];
  const off = followSize("blimpunit-x", (c, r) => seen.push([c, r]));
  setSize("blimpunit-x", 101, 33);
  expect(lastSize("blimpunit-x")).toEqual({ cols: 101, rows: 33 });
  off();
  setSize("blimpunit-x", 90, 20);
  expect(seen).toEqual([[101, 33]]);
});
