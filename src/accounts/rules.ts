// The rules account switching runs on (docs/superpowers/specs/2026-11-16-account-switching-design.md,
// "Saving" and "Switching"): which errors mean an account is out, how long it is skipped, which saved
// account comes next, and whose login a changed live file is. Pure: no files, no clock of its own.

import type { Rec, Saved, State } from "./store";

export const OUT_ERRORS = ["rate_limit", "billing_error"]; // StopFailure errors that mean the account is out
export const OUT_MS = 5 * 3600_000; // how long an account that ran out is skipped when its stop names no reset time
export const RESET_MAX_MS = 8 * 24 * 3600_000; // a reset time further on than this is misread: the longest limit window is a week
export const QUIET_MS = 30_000; // a limit stop this soon after a switch left before it: no second switch
export const SETTLE_MS = 30_000; // a change to the live file is filed, and a switch waits, until it is this old: a /login writes its account record, then its login file, then, after network calls that can take 20 s, its notice
export const LOGIN_RECORD_MS = 60_000; // a /login whose account record isn't rewritten within this long of the change is given up: blimp can't tell whose login is in place
export const LATE_NOTICE_MS = 5 * 60_000; // a /login's notice can't come later than this after its login file
// The connector gap (docs/superpowers/specs/2026-11-17-connector-gap-design.md, connectors.ts).
export const CONNECTORS_EVERY_MS = 24 * 3600_000; // the account that stays in use gets a new reading this often
export const CONNECTORS_AFTER_SWITCH_MS = 30_000; // a reading waits this long after a switch
export const CONNECTORS_RETRY_MS = 10 * 60_000; // after a failed reading, the next try waits this long
export const CONNECTORS_ZERO_AGAIN_MS = 60_000; // a reading with no connector is believed when another this much later says the same
export const CONNECTORS_TIMEOUT_MS = 60_000; // claude mcp list is killed after this long

export const isOut = (s: State, id: string, now: number) => (s.out[id]?.until ?? 0) > now;

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

// When a limit stop's message says the limit resets, as ms: "You've hit your weekly limit · resets 2pm
// (Europe/Berlin)", or with a date, "… · resets Nov 25, 1pm (Europe/Berlin)". The zone in brackets is
// the server's, and wins over `zone`. No date: the next time that clock comes round there. A date: in
// the year it is now there, or the next if that has passed (December can name January). Undefined for
// anything it can't read, an unknown zone, or a time not ahead of now by at most RESET_MAX_MS.
export function resetAt(message: string | undefined, now: number, zone = Intl.DateTimeFormat().resolvedOptions().timeZone): number | undefined {
  const m = message?.match(/\bresets\s+(?:([a-z]+)\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]m)\b(?:\s*\(([^)]+)\))?/i);
  if (!m) return;
  const [, month, day, h, min = "0", ampm, named] = m;
  // A bracket that is empty or cut short (the hook keeps 300 characters): the zone is not known.
  if (named === undefined ? /^\s*\(/.test(message!.slice(m.index! + m[0].length)) : !named.trim()) return;
  if (+h < 1 || +h > 12 || +min > 59) return;
  const hour = (+h % 12) + (ampm.toLowerCase() === "pm" ? 12 : 0);
  const mo = month === undefined ? -1 : MONTHS.findIndex((n) => n === month.toLowerCase() || n.slice(0, 3) === month.toLowerCase());
  if (month !== undefined && (mo < 0 || +day < 1 || +day > 31)) return;
  let f: Intl.DateTimeFormat;
  try {
    f = new Intl.DateTimeFormat("en-US", { timeZone: named?.trim() ?? zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
  } catch {
    return; // an unknown zone
  }
  // The wall clock there at t, read as if it were UTC.
  const wall = (t: number) => {
    const p = Object.fromEntries(f.formatToParts(t).map((x) => [x.type, +x.value]));
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  };
  const offset = (t: number) => wall(t) - t;
  // That clock on that date there, as ms. The offset is taken a second time at the first answer, which
  // is right on any day, the day the clocks change too, except for a time the change skips or brings
  // twice. A skipped one is off by that hour. One that comes twice is its second pass east of UTC and
  // its first pass west of it; there, a stop between the two passes reads a day late, or nothing with a date.
  const at = (y: number, mo: number, d: number) => {
    const g = Date.UTC(y, mo, d, hour, +min);
    return g - offset(g - offset(g));
  };
  const today = new Date(wall(now));
  const [y, mo0, d] = [today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()];
  // A day that month doesn't have (Feb 30) would roll into the next month: nothing, not a wrong time.
  const dated = (yr: number) => (new Date(Date.UTC(yr, mo, +day)).getUTCMonth() === mo ? at(yr, mo, +day) : 0);
  let t = mo < 0 ? at(y, mo0, d) : dated(y);
  if (t <= now) t = mo < 0 ? at(y, mo0, d + 1) : dated(y + 1);
  if (t > now && t - now <= RESET_MAX_MS) return t;
}

// The saved account to switch to: after the active one in order, wrapping, not out, login not expired.
// No active one (or one not saved): from the first. None: undefined.
export function nextAccount(saved: Saved[], s: State, now: number): Saved | undefined {
  const i = saved.findIndex((a) => a.id === s.active);
  for (let k = 1; k <= saved.length; k++) {
    const a = saved[(i + k) % saved.length];
    if (a.id !== s.active && !isOut(s, a.id, now) && (a.expires ?? Infinity) > now) return a;
  }
}

// Who a changed live file belongs to (one that equals a saved login is adopted before this is asked).
// Claude Code said a /login succeeded since blimp last settled who is live (loginSeenAt, hooks.ts): a
// login, owned by the account the record names once the record was fetched after that settle; until
// then "wait". No such notice: a session renewed the token, the active account's. The record is then
// not looked at, because Claude Code rewrites it by itself (a daily refresh, and a token refresh that
// keeps the old accountUuid). While blimp can't tell whose login is in place (s.unknown), only that
// notice files: anything else is "held", saved under nobody. No active account yet: the record's, as a
// login. Nothing: undefined.
export function filing(s: State, rec: Rec | undefined, loginSeenAt: number | undefined): { id: string; login: boolean } | "wait" | "held" | undefined {
  const settled = s.filed?.at ?? 0;
  if (loginSeenAt !== undefined && loginSeenAt > settled) return rec && (rec.fetchedAt ?? 0) > settled ? { id: rec.id, login: true } : "wait";
  if (s.unknown) return "held";
  if (s.active) return { id: s.active, login: false };
  if (rec) return { id: rec.id, login: true };
}
