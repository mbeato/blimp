// What GET /usage and GET /usage/now answer (docs/superpowers/specs/2026-11-19-usage-design.md, "API"),
// worked out from the usage database when asked: cost is never stored, so a corrected price corrects
// history. Days are local days by tz, minutes east of UTC; the rows are by UTC hour.

import type { Database } from "bun:sqlite";
import { costOf, type Entry, type Tier } from "./prices";

export type Sum = { replies: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; helperCost: number };
type ByIds = { byAccount: Record<string, number>; byModel: Record<string, number>; tokensByAccount: Record<string, number>; tokensByModel: Record<string, number> };
export type UsageView = {
  scanning: boolean;
  firstDay?: string; // "2026-10-16", the first local day with a reply
  totals: Sum;
  // byAccount and byModel: cost by id; tokensByAccount and tokensByModel: all tokens by id (a model with no price too).
  days: ({ day: string } & ByIds)[]; // every day of the range, oldest first
  accounts: (Sum & { id: string; email?: string })[]; // most cost first
  models: (Sum & { model: string; priced: boolean })[];
  projects: (Sum & { project: string })[]; // 20, then { project: "" } for everything else when there is more
  unpriced: string[];
  note?: string; // why prices.json was ignored
  previous?: Sum; // the same number of local days just before the range, cut at firstDay; absent when the range starts at firstDay
  hours?: ({ hour: number } & ByIds)[]; // days 1 only: today's 24 local hours, by id as days
};
export type Window = { used: number; resetsAt: number; reset: boolean }; // used 0 to 100; resetsAt ms
export type NowView = {
  accounts: { id: string; email?: string; inUse: boolean; at?: number; fiveHour?: Window; sevenDay?: Window }[];
  codex?: { at: number; plan?: string; windows: (Window & { minutes: number })[] };
  today: { cost: number; tokens: number };
  statusline: boolean;
};
export type Limits = { at: number; fiveHour?: { used: number; resetsAt: number }; sevenDay?: { used: number; resetsAt: number } };

type Row = { hour: number; account: string; model: string; project: string; helper: number; tier: Tier; replies: number; input: number; output: number; cache_read: number; write_5m: number; write_1h: number };

const H = 3_600_000;
const DAY = 86_400_000;
const PROJECTS = 20;

const dayOf = (hour: number, tz: number) => Math.floor((hour * H + tz * 60_000) / DAY);
// The local hour of the day, 0 to 23, by the same floor as dayOf, on minutes (a half-hour zone floors).
const hourOf = (hour: number, tz: number) => (((Math.floor((hour * 60 + tz) / 60) % 24) + 24) % 24);
const dayText = (day: number) => new Date(day * DAY).toISOString().slice(0, 10);
const zero = (): Sum => ({ replies: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, helperCost: 0 });
const tokens = (s: Sum) => s.input + s.output + s.cacheRead + s.cacheWrite;

function add(s: Sum, r: Row, cost: number) {
  s.replies += r.replies;
  s.input += r.input;
  s.output += r.output;
  s.cacheRead += r.cache_read;
  s.cacheWrite += r.write_5m + r.write_1h;
  s.cost += cost;
  if (r.helper) s.helperCost += cost;
}

const byIds = (): ByIds => ({ byAccount: {}, byModel: {}, tokensByAccount: {}, tokensByModel: {} });

// A row's cost and tokens into a day's (or an hour's) maps by account and by model.
function addTo(m: ByIds, r: Row, cost: number) {
  const t = r.input + r.output + r.cache_read + r.write_5m + r.write_1h;
  m.byAccount[r.account] = (m.byAccount[r.account] ?? 0) + cost;
  m.byModel[r.model] = (m.byModel[r.model] ?? 0) + cost;
  m.tokensByAccount[r.account] = (m.tokensByAccount[r.account] ?? 0) + t;
  m.tokensByModel[r.model] = (m.tokensByModel[r.model] ?? 0) + t;
}

const rowCost = (r: Row, extra: Record<string, Entry>) =>
  costOf({ replies: r.replies, input: r.input, output: r.output, cacheRead: r.cache_read, write5m: r.write_5m, write1h: r.write_1h }, r.model, r.tier, extra);

// The rows from local day `from` on. The hour a day starts in is asked for whole, then cut by its own day.
const rowsFrom = (db: Database, from: number, tz: number) =>
  (db.query("select * from rows where hour >= ?").all(Math.floor((from * DAY - tz * 60_000) / H)) as Row[]).filter((r) => dayOf(r.hour, tz) >= from);

const byCost = <T extends Sum>(list: T[]) => list.sort((a, b) => b.cost - a.cost || tokens(b) - tokens(a));

export function summarize(
  db: Database | undefined,
  o: { days: number; tz: number; now: number; prices: { extra: Record<string, Entry>; note?: string }; emails: Map<string, string> },
): UsageView {
  if (!db || !db.query("select 1 from meta where key = 'scanEnded'").get())
    return { scanning: true, totals: zero(), days: [], accounts: [], models: [], projects: [], unpriced: [] };
  const today = Math.floor((o.now + o.tz * 60_000) / DAY);
  const first = (db.query("select min(hour) as hour from rows").get() as { hour: number | null }).hour;
  const firstDay = first === null ? undefined : dayOf(first, o.tz);
  const from = Math.max(today - o.days + 1, firstDay ?? today);
  // The days before the range: as many, cut at the first day. None when the range starts at the first day.
  const before = firstDay !== undefined && today - o.days + 1 > firstDay ? Math.max(from - o.days, firstDay) : undefined;
  const previous = before === undefined ? undefined : zero();
  const hours = o.days === 1 ? Array.from({ length: 24 }, (_, hour) => ({ hour, ...byIds() })) : undefined;

  const days = new Map<number, UsageView["days"][number]>();
  for (let d = from; d <= today; d++) days.set(d, { day: dayText(d), ...byIds() });
  const totals = zero();
  const accounts = new Map<string, Sum & { id: string; email?: string }>();
  const models = new Map<string, Sum & { model: string; priced: boolean }>();
  const projects = new Map<string, Sum & { project: string }>();
  const unpriced = new Set<string>();

  for (const r of rowsFrom(db, before ?? from, o.tz)) {
    const d = dayOf(r.hour, o.tz);
    if (d < from) {
      add(previous!, r, rowCost(r, o.prices.extra) ?? 0);
      continue;
    }
    const day = days.get(d);
    if (!day) continue; // a later day than today: a clock that was ahead
    const c = rowCost(r, o.prices.extra);
    if (c === undefined) unpriced.add(r.model);
    const cost = c ?? 0;
    add(totals, r, cost);
    addTo(day, r, cost);
    if (hours) addTo(hours[hourOf(r.hour, o.tz)], r, cost);
    let a = accounts.get(r.account);
    if (!a) {
      const email = o.emails.get(r.account);
      accounts.set(r.account, (a = { ...zero(), id: r.account, ...(email && { email }) }));
    }
    add(a, r, cost);
    let m = models.get(r.model);
    if (!m) models.set(r.model, (m = { ...zero(), model: r.model, priced: c !== undefined }));
    add(m, r, cost);
    let p = projects.get(r.project);
    if (!p) projects.set(r.project, (p = { ...zero(), project: r.project }));
    add(p, r, cost);
  }

  const shown = byCost([...projects.values()]);
  const top = shown.slice(0, PROJECTS);
  if (shown.length > PROJECTS) {
    const rest: Sum & { project: string } = { ...zero(), project: "" };
    for (const p of shown.slice(PROJECTS)) for (const k of Object.keys(zero()) as (keyof Sum)[]) rest[k] += p[k];
    top.push(rest);
  }
  return {
    scanning: false,
    ...(firstDay !== undefined && { firstDay: dayText(firstDay) }),
    totals,
    days: [...days.values()],
    accounts: byCost([...accounts.values()]),
    models: byCost([...models.values()]),
    projects: top,
    unpriced: [...unpriced].sort(),
    ...(o.prices.note && { note: o.prices.note }),
    ...(previous && { previous }),
    ...(hours && { hours }),
  };
}

const windowOf = (w: { used: number; resetsAt: number } | undefined, now: number): Window | undefined => w && { used: w.used, resetsAt: w.resetsAt, reset: w.resetsAt <= now };

export function nowView(
  db: Database | undefined,
  o: { tz: number; now: number; prices: { extra: Record<string, Entry> }; saved: { id: string; email: string }[]; active?: string; record?: { id: string; email: string }; limits: Record<string, Limits>; statusline: boolean },
): NowView {
  const line = (id: string, email: string, inUse: boolean, l: Limits | undefined): NowView["accounts"][number] => {
    const fiveHour = windowOf(l?.fiveHour, o.now);
    const sevenDay = windowOf(l?.sevenDay, o.now);
    return { id, ...(email && { email }), inUse, ...(l && { at: l.at }), ...(fiveHour && { fiveHour }), ...(sevenDay && { sevenDay }) };
  };
  // With no saved account, the status line saves the numbers under "one" (statusline.ts).
  const accounts = o.saved.length
    ? o.saved.map((a) => line(a.id, a.email, a.id === o.active, o.limits[a.id]))
    : o.record
      ? [line(o.record.id, o.record.email, true, o.limits.one)]
      : [];

  const today = { cost: 0, tokens: 0 };
  let codex: NowView["codex"];
  if (db) {
    const day = Math.floor((o.now + o.tz * 60_000) / DAY);
    for (const r of rowsFrom(db, day, o.tz)) {
      if (dayOf(r.hour, o.tz) !== day) continue;
      today.cost += rowCost(r, o.prices.extra) ?? 0;
      today.tokens += r.input + r.output + r.cache_read + r.write_5m + r.write_1h;
    }
    const kept = db.query("select value from meta where key = 'codexLimit'").get() as { value: string } | null;
    if (kept) {
      const c = JSON.parse(kept.value);
      const windows = [c.primary, c.secondary]
        .filter((w) => w && typeof w === "object")
        .map((w) => ({ minutes: w.window_minutes, ...windowOf({ used: w.used_percent, resetsAt: w.resets_at * 1000 }, o.now)! }));
      codex = { at: c.at, ...(typeof c.plan === "string" && { plan: c.plan }), windows };
    }
  }
  return { accounts, ...(codex && { codex }), today, statusline: o.statusline };
}
