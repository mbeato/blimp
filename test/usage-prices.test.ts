// Prices (src/usage/prices.ts): the model key, cost per tier, and prices.json. Temp folders only.

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { costOf, entryFor, modelKey, pricesFile, readPrices } from "../src/usage/prices";

const root = mkdtempSync(join(tmpdir(), "blimp-prices-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const file = (text: string) => {
  const f = join(root, `p${++n}.json`);
  writeFileSync(f, text);
  return f;
};

const million = { replies: 1, input: 1e6, output: 1e6, cacheRead: 1e6, write5m: 1e6, write1h: 1e6 };

test("modelKey drops a date ending and [1m]", () => {
  expect(modelKey("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
  expect(modelKey("claude-opus-4-8[1m]")).toBe("claude-opus-4-8");
  expect(modelKey("claude-opus-5-5")).toBe("claude-opus-5-5");
  expect(modelKey("GLM-5.3")).toBe("GLM-5.3");
});

test("costOf: the plain price, fast doubles it, Haiku 5.5's long prompt uses the higher row", () => {
  expect(costOf(million, "claude-opus-5-5", "")).toBeCloseTo(37.2, 9);
  expect(costOf(million, "claude-opus-5-5", "fast")).toBeCloseTo(74.4, 9);
  expect(costOf(million, "claude-haiku-5-5", "")).toBeCloseTo(0.935, 9);
  expect(costOf(million, "claude-haiku-5-5", "long")).toBeCloseTo(4.675, 9);
  // A tier the model has no price for is its plain price.
  expect(costOf(million, "claude-sonnet-5-5", "fast")).toBeCloseTo(18.6, 9);
  expect(costOf(million, "claude-haiku-4-5-20251001", "")).toBeCloseTo(9.35, 9);
  // Codex: both write prices are the input price.
  expect(costOf({ ...million, write5m: 0, write1h: 0 }, "gpt-6-astra", "")).toBeCloseTo(61, 9);
});

test("a model with no price gives undefined", () => {
  expect(costOf(million, "GLM-5.3", "")).toBeUndefined();
  expect(entryFor("morph-kimik31")).toBeUndefined();
});

test("prices.json adds a model and replaces one; missing write prices are the input price", () => {
  expect(readPrices(join(root, "missing.json"))).toEqual({ extra: {} });
  const p = readPrices(file(JSON.stringify({ "GLM-5.3": { input: 1.4, output: 4.4, cacheRead: 0.26 }, "claude-opus-5-5": { input: 1, output: 2 } })));
  expect(p.note).toBeUndefined();
  expect(p.extra["GLM-5.3"]).toEqual({ input: 1.4, output: 4.4, cacheRead: 0.26, write5m: 1.4, write1h: 1.4 });
  expect(costOf(million, "GLM-5.3", "", p.extra)).toBeCloseTo(1.4 + 4.4 + 0.26 + 1.4 + 1.4, 9);
  expect(costOf(million, "claude-opus-5-5", "", p.extra)).toBeCloseTo(1 + 2 + 1 + 1 + 1, 9);
});

test("a wrong prices.json is ignored as a whole, with a note", () => {
  for (const text of ['{"GLM-5.3": {"input": "x", "output": 1}}', "not json", "[]", '{"a": {"input": 1}}', '{"a": {"input": 1, "output": 1, "write1h": -1}}', '{"a": 3}']) {
    const p = readPrices(file(text));
    expect(p.extra).toEqual({});
    expect(p.note).toStartWith("~/.blimp/prices.json is ignored: ");
  }
});

test("pricesFile is in the socket dir", () => {
  expect(pricesFile("/x/y")).toBe("/x/y/prices.json");
});
