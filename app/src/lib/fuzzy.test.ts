import { expect, test } from "bun:test";
import { fuzzyFilter, fuzzyScore } from "./fuzzy";

test("matches characters in order, case-insensitive", () => {
  expect(fuzzyScore("bmp", "Blimp")).not.toBeNull();
  expect(fuzzyScore("pmb", "Blimp")).toBeNull();
  expect(fuzzyScore("BLI", "blimp")).not.toBeNull();
});

test("empty query matches everything", () => {
  expect(fuzzyScore("", "anything")).toBe(0);
  expect(fuzzyFilter(["a", "b"], "", (x) => x)).toEqual(["a", "b"]);
});

test("ignores spaces in the query", () => {
  expect(fuzzyScore("fix bug", "fixbug")).not.toBeNull();
});

test("consecutive and word-start matches rank higher", () => {
  expect(fuzzyFilter(["a_p_i", "xaxpxi", "api.ts"], "api", (x) => x)).toEqual(["api.ts", "a_p_i", "xaxpxi"]);
  expect(fuzzyFilter(["src/lib/connection.ts", "src/components/Sidebar.tsx"], "side", (x) => x)[0]).toBe(
    "src/components/Sidebar.tsx",
  );
});

test("drops non-matches and respects the limit", () => {
  const items = ["alpha", "beta", "gamma", "alps"];
  expect(fuzzyFilter(items, "al", (x) => x).sort()).toEqual(["alpha", "alps"]);
  expect(fuzzyFilter(items, "a", (x) => x, 2)).toHaveLength(2);
});
