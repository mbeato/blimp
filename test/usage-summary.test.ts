// What GET /usage and GET /usage/now answer (src/usage/summary.ts), from a usage database filled by
// direct inserts in temp folders.

import type { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openUsage } from "../src/usage/db";
import { nowView, summarize } from "../src/usage/summary";

const root = mkdtempSync(join(tmpdir(), "blimp-summary-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const H = 3_600_000;
const NOW = Date.UTC(2026, 10, 19, 12); // 2026-11-19 12:00 UTC
const hourOf = (ms: number) => Math.floor(ms / H);
const M = 1_000_000;

type R = { at?: number; account?: string; model?: string; project?: string; helper?: number; tier?: string; replies?: number; input?: number; output?: number; cacheRead?: number; write5m?: number; write1h?: number };
function filled(rows: R[], scanned = true): Database {
  const db = openUsage(join(root, `t${++n}`))!;
  for (const r of rows)
    db.run("insert into rows values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
      hourOf(r.at ?? NOW),
      r.account ?? "A",
      r.model ?? "claude-opus-5-5",
      r.project ?? "/p",
      r.helper ?? 0,
      r.tier ?? "",
      r.replies ?? 1,
      r.input ?? 0,
      r.output ?? 0,
      r.cacheRead ?? 0,
      r.write5m ?? 0,
      r.write1h ?? 0,
    ]);
  if (scanned) db.run("insert into meta values ('scanEnded', ?)", [String(NOW)]);
  return db;
}
const opts = (o: Partial<Parameters<typeof summarize>[1]> = {}) => ({ days: 30, tz: 0, now: NOW, prices: { extra: {} }, emails: new Map<string, string>(), ...o });
const zero = { replies: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, helperCost: 0 };

test("before the first scan has ended: scanning, and nothing else", () => {
  const empty = { scanning: true, totals: zero, days: [], accounts: [], models: [], projects: [], unpriced: [] };
  expect(summarize(undefined, opts())).toEqual(empty);
  expect(summarize(filled([{ input: 5 }], false), opts())).toEqual(empty);
});

test("totals and cost for two models, by account, model and project, most cost first", () => {
  const db = filled([
    { model: "claude-opus-5-5", input: M, output: M, cacheRead: M, write5m: M, write1h: M, replies: 3 },
    { model: "claude-sonnet-4-6", account: "B", project: "/q", input: M, output: M, cacheRead: M, write5m: M, write1h: M, replies: 2 },
  ]);
  const v = summarize(db, opts({ emails: new Map([["A", "a@x.com"]]) }));
  expect(v.scanning).toBe(false);
  expect(v.firstDay).toBe("2026-11-19");
  expect(v.totals).toMatchObject({ replies: 5, input: 2 * M, output: 2 * M, cacheRead: 2 * M, cacheWrite: 4 * M, helperCost: 0 });
  expect(v.totals.cost).toBeCloseTo(37.2 + 28.05, 9);
  expect(v.models.map((m) => [m.model, m.priced, Math.round(m.cost * 100)])).toEqual([
    ["claude-opus-5-5", true, 3720],
    ["claude-sonnet-4-6", true, 2805],
  ]);
  expect(v.accounts.map((a) => [a.id, a.email])).toEqual([
    ["A", "a@x.com"],
    ["B", undefined],
  ]);
  expect(v.projects.map((p) => p.project)).toEqual(["/p", "/q"]);
  expect(v.unpriced).toEqual([]);
  expect(v.days.at(-1)!.byModel["claude-opus-5-5"]).toBeCloseTo(37.2, 9);
  expect(v.days.at(-1)!.byAccount.B).toBeCloseTo(28.05, 9);
});

test("a model with no price counts its tokens, adds no cost, and is named in unpriced", () => {
  const db = filled([
    { model: "GLM-5.3", account: "other", input: 500, output: 10 },
    { model: "claude-opus-5-5", input: 1 },
  ]);
  const v = summarize(db, opts({ prices: { extra: {}, note: "~/.blimp/prices.json is ignored: not a JSON object" } }));
  expect(v.unpriced).toEqual(["GLM-5.3"]);
  expect(v.note).toBe("~/.blimp/prices.json is ignored: not a JSON object");
  const glm = v.models.find((m) => m.model === "GLM-5.3")!;
  expect(glm).toMatchObject({ priced: false, cost: 0, input: 500, output: 10 });
  // No cost either way: the one with more tokens comes first.
  expect(v.models[0].model).toBe("claude-opus-5-5");
  expect(v.totals.input).toBe(501);
  // A price from prices.json prices it.
  const priced = summarize(db, opts({ prices: { extra: { "GLM-5.3": { input: 1, output: 1, cacheRead: 1, write5m: 1, write1h: 1 } } } }));
  expect(priced.unpriced).toEqual([]);
  expect(priced.models[0]).toMatchObject({ model: "GLM-5.3", priced: true });
});

test("tz moves a 23:30 UTC hour into the next local day", () => {
  const late = Date.UTC(2026, 10, 18, 23, 30);
  const db = filled([{ at: late, input: M }]);
  const utc = summarize(db, opts({ days: 2 }));
  expect(utc.days.map((d) => [d.day, Math.round((d.byAccount.A ?? 0) * 100)])).toEqual([
    ["2026-11-18", 400],
    ["2026-11-19", 0],
  ]);
  const east = summarize(db, opts({ days: 2, tz: 60 }));
  expect(east.firstDay).toBe("2026-11-19");
  expect(east.days.map((d) => [d.day, Math.round((d.byAccount.A ?? 0) * 100)])).toEqual([["2026-11-19", 400]]);
});

test("days has every day of the range, the empty ones too, and never starts before the first day; an older row is out of range", () => {
  const db = filled([
    { at: NOW - 40 * 86_400_000, input: M, replies: 7 },
    { at: NOW - 3 * 86_400_000, input: M },
    { at: NOW, input: M },
  ]);
  const v = summarize(db, opts({ days: 7 }));
  expect(v.days.map((d) => d.day)).toEqual(["2026-11-13", "2026-11-14", "2026-11-15", "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19"]);
  expect(v.days[2]).toEqual({ day: "2026-11-15", byAccount: {}, byModel: {} });
  expect(v.totals.replies).toBe(2);
  expect(v.firstDay).toBe("2026-10-10");
  const recent = summarize(filled([{ at: NOW - 3 * 86_400_000, input: M }]), opts({ days: 30 }));
  expect(recent.days.map((d) => d.day)).toEqual(["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19"]);
  const today = summarize(db, opts({ days: 1 }));
  expect(today.days.map((d) => d.day)).toEqual(["2026-11-19"]);
  expect(today.totals.replies).toBe(1);
});

test("25 projects give the 20 with the most cost, then one for the rest", () => {
  const db = filled(Array.from({ length: 25 }, (_, i) => ({ project: `/p${i}`, input: (i + 1) * 1000 })));
  const v = summarize(db, opts());
  expect(v.projects.length).toBe(21);
  expect(v.projects[0].project).toBe("/p24");
  expect(v.projects[19].project).toBe("/p5");
  expect(v.projects[20]).toMatchObject({ project: "", replies: 5, input: (1 + 2 + 3 + 4 + 5) * 1000 });
  const few = summarize(filled([{ project: "/a" }, { project: "/b", input: 1 }]), opts());
  expect(few.projects.map((p) => p.project)).toEqual(["/b", "/a"]);
});

test("helperCost is the cost of helper rows", () => {
  const db = filled([
    { helper: 1, output: M },
    { helper: 0, output: M, project: "/q" },
  ]);
  const v = summarize(db, opts());
  expect(v.totals.cost).toBeCloseTo(40, 9);
  expect(v.totals.helperCost).toBeCloseTo(20, 9);
  expect(v.projects.find((p) => p.project === "/p")!.helperCost).toBeCloseTo(20, 9);
  expect(v.projects.find((p) => p.project === "/q")!.helperCost).toBe(0);
});

const nowOpts = (o: Partial<Parameters<typeof nowView>[1]> = {}) => ({ tz: 0, now: NOW, prices: { extra: {} }, saved: [], limits: {}, statusline: true, ...o });

test("nowView: the saved accounts in order, the one in use marked, a window past its reset shown as reset", () => {
  const limits = {
    A: { at: NOW - 60_000, fiveHour: { used: 62, resetsAt: NOW - 1 }, sevenDay: { used: 21, resetsAt: NOW + 86_400_000 } },
    B: { at: NOW - 3 * H, sevenDay: { used: 90, resetsAt: NOW + H } },
  };
  const v = nowView(undefined, nowOpts({ saved: [{ id: "B", email: "b@x.com" }, { id: "A", email: "a@x.com" }, { id: "C", email: "" }], active: "A", limits, statusline: false }));
  expect(v.accounts).toEqual([
    { id: "B", email: "b@x.com", inUse: false, at: NOW - 3 * H, sevenDay: { used: 90, resetsAt: NOW + H, reset: false } },
    { id: "A", email: "a@x.com", inUse: true, at: NOW - 60_000, fiveHour: { used: 62, resetsAt: NOW - 1, reset: true }, sevenDay: { used: 21, resetsAt: NOW + 86_400_000, reset: false } },
    { id: "C", inUse: false },
  ]);
  expect(v.statusline).toBe(false);
  expect(v.codex).toBeUndefined();
  expect(v.today).toEqual({ cost: 0, tokens: 0 });
});

test("nowView: with nothing saved, the account .claude.json names with the numbers saved under one; with no record either, none", () => {
  const limits = { one: { at: NOW, fiveHour: { used: 5, resetsAt: NOW + H } } };
  expect(nowView(undefined, nowOpts({ record: { id: "R", email: "r@x.com" }, limits })).accounts).toEqual([
    { id: "R", email: "r@x.com", inUse: true, at: NOW, fiveHour: { used: 5, resetsAt: NOW + H, reset: false } },
  ]);
  expect(nowView(undefined, nowOpts({ limits })).accounts).toEqual([]);
});

test("nowView: Codex's limit from the database, and today's cost and tokens by the local day", () => {
  const db = filled([
    { at: NOW, input: M, output: 10, cacheRead: 20, write5m: 30, write1h: 40 },
    { at: NOW - 13 * H, input: M }, // 23:00 UTC yesterday: today only at tz 60
    { at: NOW - 2 * 86_400_000, input: M },
  ]);
  db.run("insert into meta values ('codexLimit', ?)", [
    JSON.stringify({ at: NOW - 5000, plan: "pro", primary: { used_percent: 12, window_minutes: 300, resets_at: NOW / 1000 + 600 }, secondary: { used_percent: 40, window_minutes: 10080, resets_at: NOW / 1000 - 1 } }),
  ]);
  const v = nowView(db, nowOpts());
  expect(v.codex).toEqual({
    at: NOW - 5000,
    plan: "pro",
    windows: [
      { minutes: 300, used: 12, resetsAt: NOW + 600_000, reset: false },
      { minutes: 10080, used: 40, resetsAt: NOW - 1000, reset: true },
    ],
  });
  expect(v.today.tokens).toBe(M + 100);
  expect(v.today.cost).toBeCloseTo(4 + (10 * 20 + 20 * 0.2 + 30 * 5 + 40 * 8) / M, 9);
  expect(nowView(db, nowOpts({ tz: 60 })).today.tokens).toBe(2 * M + 100);
  db.run("update meta set value = ? where key = 'codexLimit'", [JSON.stringify({ at: 1, primary: { used_percent: 1, window_minutes: 300, resets_at: 2 }, secondary: null })]);
  expect(nowView(db, nowOpts()).codex).toEqual({ at: 1, windows: [{ minutes: 300, used: 1, resetsAt: 2000, reset: true }] });
});

test("previous: the totals of the same number of days just before the range; left out when the range starts at the first day", () => {
  const D = 86_400_000;
  const db = filled([
    { at: NOW - 20 * D, input: M }, // the first day, before both ranges
    { at: NOW - 10 * D, input: M, replies: 2 }, // in the 7 days before the last 7
    { at: NOW - 7 * D, output: M, helper: 1 }, // the first day of the 7 before (2026-11-12)
    { at: NOW - 6 * D, input: M, replies: 5 }, // the first day of the range: not previous
  ]);
  const v = summarize(db, opts({ days: 7 }));
  expect(v.previous).toMatchObject({ replies: 3, input: M, output: M });
  expect(v.previous!.cost).toBeCloseTo(4 + 20, 9);
  expect(v.previous!.helperCost).toBeCloseTo(20, 9);
  // 30 days: the range starts at the first day (2026-10-30), nothing before it.
  expect(summarize(db, opts({ days: 30 })).previous).toBeUndefined();
  // 14 days reach back to 2026-11-06; the 14 before it are cut at the first day (2026-10-30).
  expect(summarize(db, opts({ days: 14 })).previous).toMatchObject({ replies: 1, input: M });
  expect(summarize(filled([]), opts({ days: 7 })).previous).toBeUndefined();
});

test("hours: only for today, 24 local hours with cost by account and model; a 23:30 UTC row is hour 0 at tz 60", () => {
  const db = filled([
    { at: Date.UTC(2026, 10, 18, 23, 30), input: M }, // 00:30 on the 19th at tz 60
    { at: Date.UTC(2026, 10, 19, 9, 10), input: M, account: "B", model: "claude-sonnet-4-6" },
    { at: Date.UTC(2026, 10, 19, 9, 50), input: M },
  ]);
  const utc = summarize(db, opts({ days: 1 }));
  expect(utc.hours!.map((h) => h.hour)).toEqual(Array.from({ length: 24 }, (_, i) => i));
  expect(utc.hours![0]).toEqual({ hour: 0, byAccount: {}, byModel: {} });
  expect(utc.hours![9].byAccount.A).toBeCloseTo(4, 9);
  expect(utc.hours![9].byAccount.B).toBeCloseTo(3, 9);
  expect(utc.hours![9].byModel["claude-sonnet-4-6"]).toBeCloseTo(3, 9);
  const east = summarize(db, opts({ days: 1, tz: 60 }));
  expect(east.hours![0].byAccount.A).toBeCloseTo(4, 9);
  expect(east.hours![10].byAccount.B).toBeCloseTo(3, 9);
  // A half-hour zone west of UTC: 09:10 UTC is 03:40 at tz -330, hour 3.
  const west = summarize(db, opts({ days: 1, tz: -330 }));
  expect(west.hours![3].byAccount.B).toBeCloseTo(3, 9);
  expect(summarize(db, opts({ days: 7 })).hours).toBeUndefined();
});
