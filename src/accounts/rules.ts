// The rules account switching runs on (docs/superpowers/specs/2026-11-16-account-switching-design.md,
// "Saving" and "Switching"): which errors mean an account is out, how long it is skipped, which saved
// account comes next, and whose login a changed live file is. Pure: no files, no clock of its own.

import type { Rec, Saved, State } from "./store";

export const OUT_ERRORS = ["rate_limit", "billing_error"]; // StopFailure errors that mean the account is out
export const OUT_MS = 5 * 3600_000; // how long an account that ran out is skipped
export const QUIET_MS = 30_000; // a limit stop this soon after a switch left before it: no second switch
export const SETTLE_MS = 10_000; // a change to the live file is filed, and a switch waits, until it is this old: a /login's notice and account record land a moment after its login file
export const LOGIN_RECORD_MS = 60_000; // a /login whose account record isn't rewritten within this long of the change is left unfiled

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
// keeps the old accountUuid). No active account yet: the record's, as a login. Nothing: undefined.
export function filing(s: State, rec: Rec | undefined, loginSeenAt: number | undefined): { id: string; login: boolean } | "wait" | undefined {
  const settled = s.filed?.at ?? 0;
  if (loginSeenAt !== undefined && loginSeenAt > settled) return rec && (rec.fetchedAt ?? 0) > settled ? { id: rec.id, login: true } : "wait";
  if (s.active) return { id: s.active, login: false };
  if (rec) return { id: rec.id, login: true };
}
