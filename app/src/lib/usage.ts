// Usage: tokens, cost at API prices and limits (docs/superpowers/specs/2026-11-19-usage-design.md, "The apps").
// The types are copies of blimpd's src/usage/summary.ts (the app never imports the server's code); the rest is
// the wording the bottom bar and the Usage window share.

export type Sum = { replies: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; helperCost: number };
export type UsageView = {
  scanning: boolean;
  firstDay?: string; // "2026-10-16", the first local day with a reply
  totals: Sum;
  days: { day: string; byAccount: Record<string, number>; byModel: Record<string, number> }[]; // cost, every day of the range, oldest first
  accounts: (Sum & { id: string; email?: string })[]; // most cost first
  models: (Sum & { model: string; priced: boolean })[];
  projects: (Sum & { project: string })[]; // 20, then { project: "" } for everything else when there is more
  unpriced: string[];
  note?: string; // why prices.json was ignored
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

// A project is a folder on the server; the full path goes in the row's tooltip.
export function projectName(p: string, home?: string): string {
  if (p === "") return "Everything else";
  if (home && p.replace(/\/+$/, "") === home.replace(/\/+$/, "")) return "~";
  const parts = p.split("/").filter(Boolean);
  return parts.length ? parts.slice(-2).join("/") : p;
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

// The cost-per-day bars. series: the 5 costliest ids, each with its own colour; rest: everything else, as one.
export type Chart = { series: string[]; rest: boolean; bars: { from: string; to: string; costs: number[]; rest: number; total: number }[]; max: number };
const SERIES = 5;
const WEEKLY_OVER = 90;

// ranked: the ids by most cost first (the view's accounts or models).
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
