// What tokens cost at API prices (docs/superpowers/specs/2026-11-19-usage-design.md, "Cost"). The
// table is the spec's; <socket dir>/prices.json adds or replaces prices. Cost is worked out when asked,
// never stored, so a corrected price corrects history.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { blimpDir } from "../sessions";

export type Counts = { replies: number; input: number; output: number; cacheRead: number; write5m: number; write1h: number };
export type Tier = "" | "fast" | "long";
export type Price = { input: number; output: number; cacheRead: number; write5m: number; write1h: number }; // USD per million tokens
export type Entry = Price & { fast?: number; long?: { over: number; price: Price } }; // fast: a multiplier; long.over: prompt tokens

// USD per million tokens, read 2026-11-19 from Anthropic's pricing page
// (https://platform.claude.com/docs/en/about-claude/pricing), its fast mode section of the same page, and
// OpenAI's (https://developers.openai.com/api/docs/pricing). Fast mode is twice every price of the model, cache
// included. Codex caches without a write price, so both writes are the input price.
export const PRICES: Record<string, Entry> = {
  "claude-fable-5-2": { input: 8, output: 40, cacheRead: 0.2, write5m: 10, write1h: 16, fast: 2 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, write5m: 12.5, write1h: 20 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, write5m: 5, write1h: 8, fast: 2 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, write5m: 6.25, write1h: 10, fast: 2 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, write5m: 6.25, write1h: 10, fast: 2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, write5m: 2.5, write1h: 4 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, write5m: 2.5, write1h: 4 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, write5m: 3.75, write1h: 6 },
  "claude-haiku-5-5": {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    write5m: 0.125,
    write1h: 0.2,
    long: { over: 100_000, price: { input: 0.5, output: 2.5, cacheRead: 0.05, write5m: 0.625, write1h: 1 } },
  },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, write5m: 1.25, write1h: 2 },
  "gpt-6-astra": { input: 10, output: 50, cacheRead: 1, write5m: 10, write1h: 10 },
  "gpt-5.6-terra": { input: 2, output: 12, cacheRead: 0.2, write5m: 2, write1h: 2 },
};

// The id a price is kept under: Claude Code writes some ids with a date (-20251001) or [1m] on the end.
export const modelKey = (model: string) => model.replace(/\[1m\]$/i, "").replace(/-\d{8}$/, "");

export const pricesFile = (dir = blimpDir()) => join(dir, "prices.json");

// The user's prices. A file that's there but wrong is ignored as a whole, with a note saying why, as kinds.json is.
export function readPrices(file = pricesFile()): { extra: Record<string, Entry>; note?: string } {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { extra: {} };
  }
  try {
    return { extra: parsePrices(JSON.parse(text)) };
  } catch (e) {
    return { extra: {}, note: `~/.blimp/prices.json is ignored: ${(e as Error).message}` };
  }
}

const isPrice = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;

function parsePrices(f: any): Record<string, Entry> {
  if (!f || typeof f !== "object" || Array.isArray(f)) throw new Error("not a JSON object");
  const extra: Record<string, Entry> = {};
  for (const [model, p] of Object.entries<any>(f)) {
    if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error(`"${model}" isn't an object of prices`);
    if (!isPrice(p.input) || !isPrice(p.output)) throw new Error(`"${model}" needs "input" and "output" as numbers of 0 or more`);
    for (const k of ["cacheRead", "write5m", "write1h"])
      if (p[k] !== undefined && !isPrice(p[k])) throw new Error(`"${model}" has a "${k}" that isn't a number of 0 or more`);
    extra[model] = { input: p.input, output: p.output, cacheRead: p.cacheRead ?? p.input, write5m: p.write5m ?? p.input, write1h: p.write1h ?? p.input };
  }
  return extra;
}

// The user's price wins, under the id as written or as kept.
export function entryFor(model: string, extra: Record<string, Entry> = {}): Entry | undefined {
  const key = modelKey(model);
  return extra[model] ?? extra[key] ?? PRICES[key];
}

// USD; undefined when the model has no price.
export function costOf(c: Counts, model: string, tier: Tier, extra?: Record<string, Entry>): number | undefined {
  const e = entryFor(model, extra);
  if (!e) return;
  const p = tier === "long" && e.long ? e.long.price : e;
  const times = tier === "fast" && e.fast ? e.fast : 1;
  return ((c.input * p.input + c.output * p.output + c.cacheRead * p.cacheRead + c.write5m * p.write5m + c.write1h * p.write1h) * times) / 1_000_000;
}
