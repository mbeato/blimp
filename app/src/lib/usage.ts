// Usage: tokens, cost at API prices and limits (docs/superpowers/specs/2026-11-19-usage-design.md, "The apps").
// The types are copies of blimpd's src/usage/summary.ts (the app never imports the server's code); the rest is
// the wording the bottom bar and the Usage window share, and what the bottom bar says about the tab in front.

import type { Session } from "./api";
import { sessionTitle, tildify } from "./sessions";

export type Sum = { replies: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; helperCost: number };
export type UsageView = {
  scanning: boolean;
  firstDay?: string; // "2026-10-16", the first local day with a reply
  totals: Sum;
  // byAccount and byModel: cost by id; tokensByAccount and tokensByModel: all tokens by id (older blimpd: absent).
  days: { day: string; byAccount: Record<string, number>; byModel: Record<string, number>; tokensByAccount?: Record<string, number>; tokensByModel?: Record<string, number> }[]; // every day of the range, oldest first
  accounts: (Sum & { id: string; email?: string })[]; // most cost first
  models: (Sum & { model: string; priced: boolean })[];
  projects: (Sum & { project: string })[]; // 20, then { project: "" } for everything else when there is more
  unpriced: string[];
  note?: string; // why prices.json was ignored
  previous?: Sum; // the same number of days just before the range; absent when the range starts at firstDay (older blimpd: absent)
  hours?: { hour: number; byAccount: Record<string, number>; byModel: Record<string, number>; tokensByAccount?: Record<string, number>; tokensByModel?: Record<string, number> }[]; // Today only: its 24 local hours, by id as days (older blimpd: absent)
};
export type Window = { used: number; resetsAt: number; reset: boolean }; // used 0 to 100; resetsAt ms
export type NowView = {
  accounts: { id: string; email?: string; inUse: boolean; at?: number; fiveHour?: Window; sevenDay?: Window }[];
  codex?: { at: number; plan?: string; windows: (Window & { minutes: number })[] };
  today: { cost: number; tokens: number };
  statusline: boolean;
};

const UNITS = [
  ["K", 1e3],
  ["M", 1e6],
  ["B", 1e9],
] as const;

// One decimal while it fits in three digits, so a column of them stays narrow: 1.2K, 31.5B, 123M.
export function tokens(n: number): string {
  if (Math.round(n) < 1000) return String(Math.round(n));
  let i = 0;
  // 999,960 is "1M", not "1000K".
  while (i < UNITS.length - 1 && Math.round(n / UNITS[i][1]) >= 1000) i++;
  const v = n / UNITS[i][1];
  return (v < 99.95 ? v.toFixed(1).replace(/\.0$/, "") : String(Math.round(v))) + UNITS[i][0];
}

export function money(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return "<$0.01";
  if (n < 999.995) return "$" + n.toFixed(2);
  return "$" + Math.round(n).toLocaleString("en-US");
}

// Rounded up: with seconds left it says a minute, not none.
export function resetsIn(resetsAt: number, now: number): string {
  if (resetsAt <= now) return "reset";
  const m = Math.ceil((resetsAt - now) / 60_000);
  if (m < 60) return `resets in ${m} min`;
  if (m < 24 * 60) return `resets in ${Math.floor(m / 60)} h` + (m % 60 ? ` ${m % 60} min` : "");
  const h = Math.floor((m % (24 * 60)) / 60);
  return `resets in ${Math.floor(m / (24 * 60))} d` + (h ? ` ${h} h` : "");
}

// A meter goes red over 80%, as a session row's context bar.
export const high = (used: number) => used > 80;

// Account ids in the data: a saved Claude account's id, "" (a reply from before blimp logged accounts),
// "other" (a model that isn't Claude's) and "codex".
export function accountName(a: { id: string; email?: string }, short?: boolean): string {
  if (a.email) return short ? a.email.split("@")[0] : a.email;
  if (a.id === "codex") return "Codex";
  if (a.id === "other") return "Other models";
  if (a.id === "") return "Before account tracking";
  return a.id.slice(0, 8);
}

export function cacheShare(s: Sum): number {
  const all = s.input + s.cacheRead + s.cacheWrite;
  return all ? s.cacheRead / all : 0;
}

// A project as the table shows it: the folder's name, and where it is (home as ~). The full path goes in the row's tooltip.
export function projectParts(path: string, home?: string): { name: string; where: string } {
  if (path === "") return { name: "Everything else", where: "" };
  const p = path.replace(/\/+$/, "") || "/";
  const h = home?.replace(/\/+$/, "");
  if (h && p === h) return { name: "~", where: "" };
  const cut = p.lastIndexOf("/");
  if (p === "/" || cut === -1) return { name: p, where: "" };
  const parent = p.slice(0, cut) || "/";
  return { name: p.slice(cut + 1), where: h ? tildify(parent, h) : parent };
}

const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

// A model id as people say it: "claude-opus-5-5" is Opus 5.5 (a date ending and [1m] dropped), "gpt-6-astra"
// is GPT-6 Astra. Anything else (GLM, Morph) as written.
export function modelName(id: string): string {
  const c = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[1m\])?$/i.exec(id);
  if (c) return `${cap(c[1])} ${c[2]}${c[3] ? "." + c[3] : ""}`;
  const g = /^gpt-(\d+(?:\.\d+)*)((?:-[a-z0-9]+)*)$/i.exec(id);
  if (g) return `GPT-${g[1]}` + g[2].split("-").filter(Boolean).map((w) => " " + cap(w)).join("");
  return id;
}

// This range's cost against the one before it, in words. Never good or bad: spending more isn't a fault.
export function change(now: number, before: number | undefined): string | undefined {
  if (!before) return;
  const d = (now - before) / before;
  if (Math.abs(d) < 0.005) return "the same";
  return `${Math.round(Math.abs(d) * 100)}% ${d > 0 ? "more" : "less"}`;
}

// The chart's grid: 0 up to the first step at or over max, the step the smallest of 1, 2, 2.5 or 5 times
// a power of ten that reaches max in 3. 2529 → 0, 1000, 2000, 3000.
export function axis(max: number): number[] {
  if (!(max > 0)) return [0];
  const p = 10 ** Math.floor(Math.log10(max / 3));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s * 3 >= max)!;
  const out = [0];
  while (out[out.length - 1] < max) out.push(Number((out.length * step).toPrecision(12)));
  return out;
}

// What the Usage window's chart, busiest day and table go by. Tokens are all of them: input, output, cache read and write.
export type Measure = "cost" | "tokens";
type ByIds = { byAccount: Record<string, number>; byModel: Record<string, number> };

export const sumTokens = (s: Sum) => s.input + s.output + s.cacheRead + s.cacheWrite;
// A total's amount by the measure: an account's, a model's, a project's or the range's.
export const amount = (s: Sum, measure: Measure) => (measure === "cost" ? s.cost : sumTokens(s));

// The rows chart() and busiest() take, with the measure's amounts in byAccount and byModel: cost as sent, or the token
// maps (none from an older blimpd).
export function measured(rows: ({ day: string; tokensByAccount?: Record<string, number>; tokensByModel?: Record<string, number> } & ByIds)[], measure: Measure): ({ day: string } & ByIds)[] {
  return measure === "cost" ? rows : rows.map((r) => ({ day: r.day, byAccount: r.tokensByAccount ?? {}, byModel: r.tokensByModel ?? {} }));
}

// The day (or hour, given as day) with the biggest amount (cost, or tokens from measured()); none when it is 0 everywhere.
export function busiest(days: { day: string; byModel: Record<string, number> }[]): { day: string; cost: number } | undefined {
  let best: { day: string; cost: number } | undefined;
  for (const d of days) {
    const cost = Object.values(d.byModel).reduce((a, b) => a + b, 0);
    if (cost > (best?.cost ?? 0)) best = { day: d.day, cost };
  }
  return best;
}

// What the bottom bar's left side says. waiting: the titles of the sessions that wait, for the hover text.
// focused: the focused session's model label and context. jobs: the labels of running jobs in this folder.
export type BarInfo = {
  branch?: string;
  pr?: { number: number; url: string; title: string };
  working: number;
  waiting: string[];
  focused?: { label: string; used?: number; limit?: number };
  jobs: string[];
};

// Working and waiting count every session on the server: one that waits anywhere matters. The branch and its
// open pull request: the focused session's, or with none focused, the first in this folder that has a branch.
export function barInfo(sessions: Session[], folder: string | null, focused: string | undefined): BarInfo {
  const here = sessions.filter((s) => s.dir === folder);
  const branchOf = (s: Session) => s.work?.branch ?? s.git?.branch;
  const f = focused === undefined ? undefined : sessions.find((s) => s.name === focused);
  const from = f ?? here.find(branchOf);
  const branch = from && branchOf(from);
  const open = from?.work?.prs?.find((p) => p.state.toLowerCase() === "open");
  return {
    ...(branch && { branch }),
    ...(open && { pr: { number: open.number, url: open.url, title: open.title } }),
    working: sessions.filter((s) => s.state === "working").length,
    waiting: sessions.filter((s) => s.state === "waiting").map(sessionTitle),
    ...(f?.label && { focused: { label: f.label, ...(f.context && { used: f.context.used, limit: f.context.limit }) } }),
    jobs: here.flatMap((s) => (s.jobs ?? []).filter((j) => j.status === "running").map((j) => j.label)),
  };
}

// A part of the total cost, as the tables' last column says it.
export function share(part: number, total: number): string {
  if (total <= 0) return "—";
  if (part > 0 && part / total < 0.005) return "<1%";
  return `${Math.round((part / total) * 100)}%`;
}

// A limit window's length (Codex says it in minutes): 5h, week.
export function windowLabel(minutes: number): string {
  if (minutes === 7 * 24 * 60) return "week";
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)} d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes} min`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "2026-11-19" → "Nov 19". Read from the text: the day is already the server's local day for this Mac's tz.
export function dayLabel(day: string): string {
  const [, m, d] = day.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}

// The bars per day, by cost or tokens (measured()). series: the 5 biggest ids, each with its own colour; rest:
// everything else, as one. costs and total are the measure's amounts.
export type Chart = { series: string[]; rest: boolean; bars: { from: string; to: string; costs: number[]; rest: number; total: number }[]; max: number };
const SERIES = 5;
const WEEKLY_OVER = 90;

// ranked: the ids by the biggest amount first (the view's accounts or models).
export function chart(days: UsageView["days"], by: "account" | "model", ranked: string[]): Chart {
  const series = ranked.slice(0, SERIES);
  const index = new Map(series.map((id, i) => [id, i]));
  // Over 90 days a bar is 7 days, counted from the oldest, so bars stay wide enough to point at.
  const size = days.length > WEEKLY_OVER ? 7 : 1;
  const bars: Chart["bars"] = [];
  for (let i = 0; i < days.length; i += size) {
    const group = days.slice(i, i + size);
    const bar = { from: group[0].day, to: group[group.length - 1].day, costs: series.map(() => 0), rest: 0, total: 0 };
    for (const d of group)
      for (const [id, cost] of Object.entries(by === "account" ? d.byAccount : d.byModel)) {
        const at = index.get(id);
        if (at === undefined) bar.rest += cost;
        else bar.costs[at] += cost;
        bar.total += cost;
      }
    bars.push(bar);
  }
  return { series, rest: ranked.length > SERIES, bars, max: Math.max(0, ...bars.map((b) => b.total)) };
}
