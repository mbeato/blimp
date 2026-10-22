// When the return card ("where was I?") shows by itself: a Claude session comes on screen in a focused
// window, and this Mac hadn't shown it for an hour or more. Sessions are "<server key>/<session name>".
// When each was last on screen is kept on this computer (localStorage), only for this.

import { ApiError } from "./api";

export const AWAY = 60 * 60_000;
const KEEP = 30 * 24 * 60 * 60_000;
const KEY = "blimp.lastShown";

// The sessions on screen now that weren't at the last look (before), and were last on screen an hour
// ago or more, or never on this Mac. prev: when that last look was. The app looks every 30 s, so a look
// an hour or more ago means the Mac was asleep: then the ones on screen all along count too.
export const cameBack = (viewing: string[], before: string[], last: Record<string, number>, now: number, prev = now) =>
  viewing.filter((k) => (now - prev >= AWAY || !before.includes(k)) && !(now - (last[k] ?? -Infinity) < AWAY));

// These sessions were on screen until now. Ones not on screen for a month are forgotten.
export function markShown(last: Record<string, number>, shown: string[], now: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, at] of Object.entries(last)) if (now - at < KEEP) out[k] = at;
  for (const k of shown) out[k] = now;
  return out;
}

export function readLastShown(): Record<string, number> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export function writeLastShown(last: Record<string, number>) {
  try {
    localStorage.setItem(KEY, JSON.stringify(last));
  } catch {}
}

// The notice when a Recap asked for from the menu can't come from a blimpd from before recaps: it answers
// the route with the generic "not found" (one that can't recap a session says why, and the card just
// doesn't show). Undefined for every other failure.
export function recapError(e: unknown): string | undefined {
  if (e instanceof ApiError && e.status === 404 && e.message === "not found") return "This server's blimpd is too old for recaps. Update it first.";
}
