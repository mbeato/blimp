// The rules account switching runs on (docs/superpowers/specs/2026-11-16-account-switching-design.md,
// "Saving" and "Switching"): which errors mean an account is out, how long it is skipped, which saved
// account comes next, and whose login a changed live file is. Pure: no files, no clock of its own.

import type { Rec, Saved, State } from "./store";

export const OUT_ERRORS = ["rate_limit", "billing_error"]; // StopFailure errors that mean the account is out
export const OUT_MS = 5 * 3600_000; // how long an account that ran out is skipped
export const QUIET_MS = 30_000; // a limit stop this soon after a switch left before it: no second switch
export const FILE_AFTER_MS = 120_000; // a change to the live file is filed this long after it's seen

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

// Who a changed live file belongs to. oauthAccount changed since the last filing: a /login, that
// account's. Unchanged: a session renewed the token, the active account's (after a swap by blimp the
// record still names the old account, spec finding 2). Unknown: undefined.
export function filing(s: State, rec: Rec | undefined): { id: string; login: boolean } | undefined {
  if (rec && rec.raw !== s.filed?.record) return { id: rec.id, login: true };
  if (s.active) return { id: s.active, login: false };
}
