import { expect, test } from "bun:test";
import { fuzzyFilter, fuzzyScore, rank, sessionScore } from "./fuzzy";

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

test("a contiguous match beats a scattered one, even with more word starts", () => {
  expect(fuzzyFilter(["a-p-i", "rapid"], "api", (x) => x)).toEqual(["rapid", "a-p-i"]);
});

test("a match at a word start beats one mid-word", () => {
  expect(fuzzyFilter(["rapid", "the api"], "api", (x) => x)).toEqual(["the api", "rapid"]);
  expect(fuzzyFilter(["happiness", "src/api/x.ts"], "api", (x) => x)).toEqual(["src/api/x.ts", "happiness"]);
});

test("the query as typed, spaces included, counts as contiguous", () => {
  expect(fuzzyFilter(["f-i-x b-u-g", "the fix bug list"], "fix bug", (x) => x)[0]).toBe("the fix bug list");
});

test("⌘K: title beats folder and name; contiguous beats a match spread across fields", () => {
  const sessions = [
    { title: "Add Apple Pay to checkout", folder: "~/x/webshop", name: "blimpe2e-web-2" },
    { title: "Postgres slow query on /orders", folder: "~/x/api", name: "blimpe2e-api-2" },
    { title: "Rate limits for the public API", folder: "~/x/api", name: "blimpe2e-api-1" },
  ];
  const ranked = rank(sessions, (s) => sessionScore("api", s.title, s.folder, s.name));
  expect(ranked.map((s) => s.title)).toEqual([
    "Rate limits for the public API",
    "Postgres slow query on /orders",
    "Add Apple Pay to checkout",
  ]);
});

test("⌘K: a query can span title and folder", () => {
  expect(sessionScore("rate api", "Rate limits", "~/x/api", "s1")).not.toBeNull();
  expect(sessionScore("zzz", "Rate limits", "~/x/api", "s1")).toBeNull();
});
