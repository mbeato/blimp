// The rules account switching runs on (docs/superpowers/specs/2026-11-16-account-switching-design.md,
// "Saving" and "Switching"): which errors mean an account is out, how long it is skipped, which saved
// account comes next, and whose login a changed live file is. Pure: no files, no clock of its own.

import type { Rec, Saved, State } from "./store";

export const OUT_ERRORS = ["rate_limit", "billing_error"]; // StopFailure errors that mean the account is out
export const OUT_MS = 5 * 3600_000; // how long an account that ran out is skipped
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
