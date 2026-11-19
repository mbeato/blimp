// `blimpd usage [--days N]` (docs/superpowers/specs/2026-11-19-usage-design.md, "API"): asks the running
// blimpd for GET /usage and /usage/now and prints the limits, then the totals, then by account, by model
// and by project. Plain lines for a terminal 100 wide. Cost is at API prices, and says so.

import { getJson } from "../client";
import type { NowView, Sum, UsageView, Window } from "./summary";

const USAGE = "usage: blimpd usage [--days N]";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const TOP = 10;

const pad = (n: number) => String(n).padStart(2, "0");
const clock = (t: number) => `${pad(new Date(t).getHours())}:${pad(new Date(t).getMinutes())}`;
const date = (t: number) => `${MONTHS[new Date(t).getMonth()]} ${new Date(t).getDate()}`;

// The same words the app uses.
const tokens = (n: number) => {
  if (n < 1000) return String(n);
  const [v, unit] = n < 1e6 ? [n / 1e3, "K"] : n < 1e9 ? [n / 1e6, "M"] : [n / 1e9, "B"];
  return `${v < 100 ? v.toFixed(1) : v.toFixed(0)}${unit}`;
};
const money = (n: number) => (n === 0 ? "$0" : n < 0.01 ? "<$0.01" : n < 1000 ? `$${n.toFixed(2)}` : `$${Math.round(n).toLocaleString("en-US")}`);
const accountName = (a: { id: string; email?: string }) =>
  a.email || (a.id === "codex" ? "Codex" : a.id === "other" ? "Other models" : a.id === "" ? "Before account tracking" : a.id);

function ago(t: number, at: number): string {
  const m = Math.floor((at - t) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  if (m < 24 * 60) return `${Math.floor(m / 60)} h ago`;
  return `${Math.floor(m / (24 * 60))} d ago`;
}

// A window past its reset is shown as reset, not as its old number. Within a day: the clock, else the date.
const windowText = (name: string, w: Window, at: number) =>
  w.reset ? `${name} reset` : `${name} ${Math.round(w.used)}% resets ${w.resetsAt - at < 24 * 3_600_000 ? clock(w.resetsAt) : date(w.resetsAt)}`;
const windowName = (minutes: number) => (minutes === 10080 ? "week" : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes} min`);

const limitLine = (name: string, windows: string[], t: number | undefined, at: number) =>
  `${name}: ${windows.length ? [...windows, ...(t !== undefined ? [`as of ${ago(t, at)}`] : [])].join(", ") : "no numbers yet"}`;

// A name too long for its column keeps its end: for a folder, the end says which.
const cell = (name: string) => (name.length > 42 ? `…${name.slice(-41)}` : name).padEnd(44);
const row = (name: string, cols: string[]) => cell(name) + cols.map((c, i) => c.padStart(i === 3 ? 12 : 9)).join("");

function table(title: string, list: (Sum & { priced?: boolean })[], name: (x: any) => string): string[] {
  if (!list.length) return [];
  return [
    "",
    row(title, ["in", "out", "cached", "cost"]),
    ...list.slice(0, TOP).map((x) => row(name(x), [tokens(x.input), tokens(x.output), tokens(x.cacheRead + x.cacheWrite), x.priced === false ? "no price" : money(x.cost)])),
  ];
}

export function usageText(view: UsageView, now: NowView, at: number): string {
  if (view.scanning) return "blimpd is counting your history. Try again in a few minutes.";
  const lines: string[] = [];
  for (const a of now.accounts) {
    const windows = [...(a.fiveHour ? [windowText("5h", a.fiveHour, at)] : []), ...(a.sevenDay ? [windowText("week", a.sevenDay, at)] : [])];
    lines.push(limitLine(`${accountName(a)}${a.inUse ? " (in use)" : ""}`, windows, a.at, at));
  }
  if (now.codex)
    lines.push(limitLine(`Codex${now.codex.plan ? ` (${now.codex.plan})` : ""}`, now.codex.windows.map((w) => windowText(windowName(w.minutes), w, at)), now.codex.at, at));
  if (!now.statusline) lines.push("Claude limits are not being read. Run: blimpd install-statusline");
  if (lines.length) lines.push("");

  const t = view.totals;
  const n = view.days.length;
  lines.push(`Last ${n} day${n === 1 ? "" : "s"} at API prices: ${money(t.cost)}`);
  lines.push(`Tokens: ${tokens(t.input + t.output + t.cacheRead + t.cacheWrite)} (in ${tokens(t.input)}, out ${tokens(t.output)}, cached ${tokens(t.cacheRead + t.cacheWrite)}). Replies: ${t.replies.toLocaleString("en-US")}.`);
  if (view.note) lines.push(view.note);
  lines.push(...table("By account", view.accounts, accountName));
  lines.push(...table("By model", view.models, (m) => m.model));
  lines.push(...table("By project", view.projects, (p) => p.project || "Everything else"));
  return lines.join("\n");
}

export async function runUsage(args: string[]): Promise<number> {
  let days = 30;
  if (args.length) {
    const n = Number(args[1]);
    if (args[0] !== "--days" || args.length !== 2 || !Number.isInteger(n) || n < 1 || n > 3660) {
      console.error(USAGE);
      return 1;
    }
    days = n;
  }
  const tz = -new Date().getTimezoneOffset();
  try {
    const [view, now] = await Promise.all([getJson<UsageView>(`/usage?days=${days}&tz=${tz}`), getJson<NowView>(`/usage/now?tz=${tz}`)]);
    console.log(usageText(view, now, Date.now()));
    return 0;
  } catch (e) {
    console.error(`blimpd usage: ${(e as Error).message}`);
    return 1;
  }
}
