import { expect, test } from "bun:test";
import type { Job, Session } from "./api";
import { accountName, axis, barInfo, busiest, cacheShare, change, chart, dayLabel, high, modelName, money, projectName, projectParts, resetsIn, share, tokens, windowLabel, type Sum, type UsageView } from "./usage";

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

test("modelName: Claude and GPT ids as people say them; anything else as written", () => {
  expect(modelName("claude-opus-5-5")).toBe("Opus 5.5");
  expect(modelName("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
  expect(modelName("claude-opus-4-8[1m]")).toBe("Opus 4.8");
  expect(modelName("claude-fable-5-2")).toBe("Fable 5.2");
  expect(modelName("claude-opus-5")).toBe("Opus 5");
  expect(modelName("claude-sonnet-4-6")).toBe("Sonnet 4.6");
  expect(modelName("gpt-6-astra")).toBe("GPT-6 Astra");
  expect(modelName("gpt-5.6-terra")).toBe("GPT-5.6 Terra");
  expect(modelName("gpt-6")).toBe("GPT-6");
  expect(modelName("GLM-5.3")).toBe("GLM-5.3");
  expect(modelName("GLM-5.3-Flash")).toBe("GLM-5.3-Flash");
  expect(modelName("morph-kimik31")).toBe("morph-kimik31");
  expect(modelName("")).toBe("");
});

test("projectParts: the folder's name, and where it is with ~ for home", () => {
  expect(projectParts("/Users/m/characterquilt/app", "/Users/m")).toEqual({ name: "app", where: "~/characterquilt" });
  expect(projectParts("/Users/m/characterquilt/app/", "/Users/m")).toEqual({ name: "app", where: "~/characterquilt" });
  expect(projectParts("/Users/m/blimp", "/Users/m")).toEqual({ name: "blimp", where: "~" });
  expect(projectParts("/Users/m", "/Users/m")).toEqual({ name: "~", where: "" });
  expect(projectParts("/Users/m/", "/Users/m")).toEqual({ name: "~", where: "" });
  expect(projectParts("/srv/a/b")).toEqual({ name: "b", where: "/srv/a" });
  expect(projectParts("/srv")).toEqual({ name: "srv", where: "/" });
  expect(projectParts("/")).toEqual({ name: "/", where: "" });
  // A folder whose name starts like home's is not in home.
  expect(projectParts("/Users/mx/a", "/Users/m")).toEqual({ name: "a", where: "/Users/mx" });
  expect(projectParts("")).toEqual({ name: "Everything else", where: "" });
});

test("change: more or less in percent; the same within half a percent; nothing to compare with, nothing", () => {
  expect(change(112, 100)).toBe("12% more");
  expect(change(80, 100)).toBe("20% less");
  expect(change(100.4, 100)).toBe("the same");
  expect(change(99.6, 100)).toBe("the same");
  expect(change(300, 100)).toBe("200% more");
  expect(change(0, 100)).toBe("100% less");
  expect(change(5, undefined)).toBeUndefined();
  expect(change(5, 0)).toBeUndefined();
});

test("axis: 0 up to the first nice step at or over max, in about 3 steps", () => {
  expect(axis(2529)).toEqual([0, 1000, 2000, 3000]);
  expect(axis(657)).toEqual([0, 250, 500, 750]);
  expect(axis(0.8)).toEqual([0, 0.5, 1]);
  expect(axis(0)).toEqual([0]);
  expect(axis(3000)).toEqual([0, 1000, 2000, 3000]);
  expect(axis(16_000)).toEqual([0, 10_000, 20_000]);
  expect(axis(212)).toEqual([0, 100, 200, 300]);
  expect(axis(0.3)).toEqual([0, 0.1, 0.2, 0.3]);
  expect(axis(45)).toEqual([0, 20, 40, 60]);
  // Each step is 1, 2, 2.5 or 5 times a power of ten, and 3 steps reach max.
  for (const max of [0.01, 0.07, 1, 7, 13, 99, 101, 999, 1001, 2500, 12_345]) {
    const a = axis(max);
    const step = a[1];
    expect(a.at(-1)!).toBeGreaterThanOrEqual(max);
    expect(a.at(-2)!).toBeLessThan(max);
    expect(a.length).toBeLessThanOrEqual(4);
    const m = step / 10 ** Math.floor(Math.log10(step) + 1e-9);
    expect([1, 2, 2.5, 5].some((x) => Math.abs(m - x) < 1e-9)).toBe(true);
  }
});

test("busiest: the day with the most cost; none when nothing cost anything", () => {
  const days: { day: string; byModel: Record<string, number> }[] = [
    { day: "2026-11-15", byModel: { a: 1, b: 2 } },
    { day: "2026-11-16", byModel: { a: 2000, b: 529 } },
    { day: "2026-11-17", byModel: {} },
  ];
  expect(busiest(days)).toEqual({ day: "2026-11-16", cost: 2529 });
  expect(busiest([{ day: "2026-11-17", byModel: {} }])).toBeUndefined();
  expect(busiest([])).toBeUndefined();
});

const sess = (o: Partial<Session> & { name: string }): Session => ({ kind: "claude", pid: 1, clients: 0, created: 0, dir: "/r/app", cmd: "", title: o.name, status: "", state: "done", ...o });
const job = (label: string, status: Job["status"]): Job => ({ id: label, kind: "bash", label, startedAt: 0, status });

test("barInfo: working and waiting over every session; the focused session's label, context, branch and open pull request; this folder's running jobs", () => {
  const pr = (number: number, state: string) => ({ number, title: `PR ${number}`, state, url: `https://x/${number}` });
  const sessions = [
    sess({ name: "a", title: "Fix the bar", state: "waiting", label: "Opus", context: { used: 90_000, limit: 200_000 }, work: { branch: "usage", prs: [pr(7, "MERGED"), pr(8, "open")] }, jobs: [job("bun test", "running"), job("old", "done")] }),
    sess({ name: "b", state: "working", dir: "/elsewhere", jobs: [job("far", "running")] }),
    sess({ name: "c", state: "waiting", kind: "codex", title: "ignored", dir: "/elsewhere" }),
    sess({ name: "sh", kind: "shell", state: "unknown", git: { cwd: "/r/app", branch: "main" }, jobs: [job("watch", "running")] }),
  ];
  expect(barInfo(sessions, "/r/app", "a")).toEqual({
    branch: "usage",
    pr: { number: 8, url: "https://x/8", title: "PR 8" },
    working: 1,
    waiting: ["Fix the bar", "c"],
    focused: { label: "Opus", used: 90_000, limit: 200_000 },
    jobs: ["bun test", "watch"],
  });
  // A focused plain shell: no label, so no focused item; its branch from git.
  const shell = barInfo(sessions, "/r/app", "sh");
  expect(shell.branch).toBe("main");
  expect(shell.focused).toBeUndefined();
  expect(shell.pr).toBeUndefined();
  // No focused session: the first session in this folder that has a branch.
  expect(barInfo(sessions, "/r/app", undefined)).toMatchObject({ branch: "usage", pr: { number: 8 } });
  expect(barInfo(sessions, "/r/app", "gone")).toMatchObject({ branch: "usage" });
  // A label with no context: no numbers.
  expect(barInfo([sess({ name: "g", label: "GLM" })], "/r/app", "g").focused).toEqual({ label: "GLM" });
  // Nothing at all.
  expect(barInfo([], null, undefined)).toEqual({ working: 0, waiting: [], jobs: [] });
  // Only closed pull requests: the branch alone.
  const closed = barInfo([sess({ name: "d", work: { branch: "x", prs: [pr(1, "CLOSED")] } })], "/r/app", "d");
  expect(closed.branch).toBe("x");
  expect(closed.pr).toBeUndefined();
});
