import { expect, test } from "bun:test";
import { accountName, cacheShare, chart, dayLabel, high, money, projectName, resetsIn, share, tokens, windowLabel, type Sum, type UsageView } from "./usage";

const sum = (s: Partial<Sum> = {}): Sum => ({ replies: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, helperCost: 0, ...s });

test("tokens: in full under a thousand, then K, M and B with one decimal", () => {
  expect(tokens(0)).toBe("0");
  expect(tokens(950)).toBe("950");
  expect(tokens(1_000)).toBe("1K");
  expect(tokens(1_234)).toBe("1.2K");
  expect(tokens(3_400_000)).toBe("3.4M");
  expect(tokens(2_100_000_000)).toBe("2.1B");
  // A 30-day total can pass 30 billion.
  expect(tokens(31_456_000_000)).toBe("31.5B");
  expect(tokens(123_456_789)).toBe("123M");
  // Rounding never gives "1000K".
  expect(tokens(999_999)).toBe("1M");
  expect(tokens(99_960)).toBe("100K");
});

test("money: cents under a thousand dollars, whole dollars with commas above", () => {
  expect(money(0)).toBe("$0");
  expect(money(0.004)).toBe("<$0.01");
  expect(money(0.42)).toBe("$0.42");
  expect(money(12.345)).toBe("$12.35");
  expect(money(999.99)).toBe("$999.99");
  expect(money(1234.5)).toBe("$1,235");
  expect(money(12_345.6)).toBe("$12,346");
  expect(money(1_234_567)).toBe("$1,234,567");
});

test("resetsIn: minutes, hours and minutes, days and hours; reset once past", () => {
  const now = 1_700_000_000_000;
  const min = 60_000;
  expect(resetsIn(now + 40 * min, now)).toBe("resets in 40 min");
  expect(resetsIn(now + 100 * min, now)).toBe("resets in 1 h 40 min");
  expect(resetsIn(now + 120 * min, now)).toBe("resets in 2 h");
  expect(resetsIn(now + (3 * 24 * 60 + 2 * 60) * min, now)).toBe("resets in 3 d 2 h");
  expect(resetsIn(now + 3 * 24 * 60 * min, now)).toBe("resets in 3 d");
  // Seconds left still say a minute, not "0 min".
  expect(resetsIn(now + 20_000, now)).toBe("resets in 1 min");
  expect(resetsIn(now, now)).toBe("reset");
  expect(resetsIn(now - 5 * min, now)).toBe("reset");
});

test("high: over 80, not at 80", () => {
  expect(high(0)).toBe(false);
  expect(high(80)).toBe(false);
  expect(high(80.5)).toBe(true);
  expect(high(100)).toBe(true);
});

test("accountName: the email, or what the id stands for", () => {
  expect(accountName({ id: "3f2a9c1e-0000-4000-8000-000000000000", email: "max@example.com" })).toBe("max@example.com");
  expect(accountName({ id: "3f2a9c1e-0000-4000-8000-000000000000", email: "max@example.com" }, true)).toBe("max");
  expect(accountName({ id: "codex" })).toBe("Codex");
  expect(accountName({ id: "other" })).toBe("Other models");
  expect(accountName({ id: "" })).toBe("Before account tracking");
  // A saved account with no email.
  expect(accountName({ id: "3f2a9c1e-0000-4000-8000-000000000000" })).toBe("3f2a9c1e");
  expect(accountName({ id: "3f2a9c1e-0000-4000-8000-000000000000" }, true)).toBe("3f2a9c1e");
});

test("cacheShare: cache reads over all input", () => {
  expect(cacheShare(sum())).toBe(0);
  expect(cacheShare(sum({ input: 10, cacheRead: 80, cacheWrite: 10, output: 500 }))).toBe(0.8);
  expect(cacheShare(sum({ input: 10 }))).toBe(0);
});

test("projectName: the last two parts of the path; empty is everything else", () => {
  expect(projectName("")).toBe("Everything else");
  expect(projectName("/home/max/code/blimp")).toBe("code/blimp");
  expect(projectName("/home/max/code/blimp/")).toBe("code/blimp");
  expect(projectName("/srv")).toBe("srv");
  expect(projectName("/")).toBe("/");
  expect(projectName("/home/max", "/home/max")).toBe("~");
  expect(projectName("/home/max/blimp", "/home/max")).toBe("max/blimp");
});

test("share: a part of the total cost as a percent", () => {
  expect(share(25, 100)).toBe("25%");
  expect(share(0.2, 100)).toBe("<1%");
  expect(share(0, 100)).toBe("0%");
  expect(share(0, 0)).toBe("—");
});

test("windowLabel: a limit window's length in short", () => {
  expect(windowLabel(300)).toBe("5h");
  expect(windowLabel(10_080)).toBe("week");
  expect(windowLabel(1_440)).toBe("1 d");
  expect(windowLabel(45)).toBe("45 min");
});

test("dayLabel: a day as the bars' dates say it", () => {
  expect(dayLabel("2026-11-19")).toBe("Nov 19");
  expect(dayLabel("2026-01-02")).toBe("Jan 2");
});

const day = (d: string, byAccount: Record<string, number> = {}, byModel: Record<string, number> = {}): UsageView["days"][number] => ({ day: d, byAccount, byModel });

test("chart: one bar per day by the 5 costliest series, the rest together", () => {
  const ids = ["a", "b", "c", "d", "e", "f", "g"];
  const days = [day("2026-11-18", { a: 7, b: 6, c: 5, d: 4, e: 3, f: 2, g: 1 }), day("2026-11-19", { a: 1, "": 2 })];
  const c = chart(days, "account", [...ids, ""]);
  expect(c.series).toEqual(["a", "b", "c", "d", "e"]);
  expect(c.rest).toBe(true);
  expect(c.bars).toHaveLength(2);
  expect(c.bars[0]).toEqual({ from: "2026-11-18", to: "2026-11-18", costs: [7, 6, 5, 4, 3], rest: 3, total: 28 });
  // "" (before account tracking) is an id like any other; outside the top 5 it is in the rest.
  expect(c.bars[1]).toEqual({ from: "2026-11-19", to: "2026-11-19", costs: [1, 0, 0, 0, 0], rest: 2, total: 3 });
  expect(c.max).toBe(28);
});

test("chart: by model, and no rest with 5 or fewer", () => {
  const c = chart([day("2026-11-19", {}, { "claude-opus-5-5": 3, "gpt-6-astra": 1 })], "model", ["claude-opus-5-5", "gpt-6-astra"]);
  expect(c.series).toEqual(["claude-opus-5-5", "gpt-6-astra"]);
  expect(c.rest).toBe(false);
  expect(c.bars[0].costs).toEqual([3, 1]);
  expect(c.bars[0].rest).toBe(0);
});

test("chart: over 90 days, a bar per 7 days from the oldest", () => {
  const days = Array.from({ length: 100 }, (_, i) => day(new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10), { a: 1 }));
  const c = chart(days, "account", ["a"]);
  expect(c.bars).toHaveLength(15);
  expect(c.bars[0]).toMatchObject({ from: "2026-01-01", to: "2026-01-07", total: 7 });
  // The last group has what is left: 100 = 14 × 7 + 2.
  expect(c.bars[14]).toMatchObject({ from: "2026-04-09", to: "2026-04-10", total: 2 });
  expect(c.max).toBe(7);
});

test("chart: an empty range", () => {
  expect(chart([], "account", [])).toEqual({ series: [], rest: false, bars: [], max: 0 });
});
