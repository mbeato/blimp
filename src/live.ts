// What the phone's live panel shows (docs/superpowers/specs/2026-10-26-phone-live-activity-design.md, "What it
// shows"): on top the followed turn (followed.ts), with its steps (steps.ts) when Claude keeps a task list; then the
// widgets' rows (widget.ts: needs you, new, working, the hidden projects' left out; the followed session's own row left
// out, it's on top), 3 under a followed turn, 4 without, and the counts. It goes to Apple as the Live Activity's
// content-state, which iOS decodes into BlimpKit's LiveState (ios/BlimpKit/Sources/BlimpKit/Live.swift): the same
// names, times in ms as numbers. Apple takes at most 4 KB a push, so titles are cut to fit.

import { followed } from "./followed";
import { readHidden } from "./hidden";
import type { Session } from "./sessions";
import { type Steps, transcriptSteps } from "./steps";
import { type WidgetRow, type WidgetState, type WidgetSummary, widgetSummary } from "./widget";

// state: needs while it waits on you, else working. since: when the prompt went in (ms).
export type LiveTurn = { session: string; dir: string; title: string; state: WidgetState; since: number; steps?: Steps };
export type LiveState = { turn?: LiveTurn; rows: WidgetRow[]; counts: WidgetSummary["counts"] };
export type LiveEvent = "start" | "update" | "end";

export const ROWS_UNDER_TURN = 3;
export const ROWS_ALONE = 4;
// The content-state's JSON at most, in bytes: the rest of a push (its aps, the start's alert) fits in Apple's 4096.
export const MAX_STATE = 3500;
// The Swift type's name, for a push-to-start (ios/Live/BlimpActivityAttributes.swift).
export const ATTRIBUTES_TYPE = "BlimpActivityAttributes";
const TITLE = 80;

const cut = (s: string, n: number) => Array.from(s).slice(0, n).join("");
const bytes = (l: LiveState) => Buffer.byteLength(JSON.stringify(l));

export function liveState(sessions: Session[], hidden: Set<string>, turn: { session: Session; at: number; steps?: Steps } | undefined, now = Date.now()): LiveState {
  const w = widgetSummary(sessions, hidden, now);
  const rows = w.rows.filter((r) => r.session !== turn?.session.name).slice(0, turn ? ROWS_UNDER_TURN : ROWS_ALONE);
  const t = turn && {
    session: turn.session.name,
    dir: turn.session.dir,
    title: turn.session.title,
    state: (turn.session.state === "waiting" ? "needs" : "working") as WidgetState,
    since: turn.at,
    ...(turn.steps && { steps: turn.steps }),
  };
  // Titles at most 80 characters, then 10 fewer at a time until it fits.
  const fit = (n: number): LiveState => ({
    ...(t && { turn: { ...t, title: cut(t.title, n) } }),
    rows: rows.map((r) => ({ ...r, title: cut(r.title, n) })),
    counts: w.counts,
  });
  let n = TITLE;
  let l = fit(n);
  while (bytes(l) > MAX_STATE && n > 10) l = fit((n -= 10));
  return l;
}

// What the panel shows, for the runner to tell a change: the counts, the rows with their states and titles, the turn
// with its state, title and steps. The timers ticking isn't a change: the panel counts them up by itself.
export const liveShape = (l: LiveState) =>
  JSON.stringify([l.counts, l.rows.map((r) => [r.session, r.state, r.title]), l.turn ? [l.turn.session, l.turn.state, l.turn.title, l.turn.steps ?? null] : null]);

// The panel runs while something needs you or works, or a followed turn runs.
export const isBusy = (l: LiveState) => l.counts.needs > 0 || l.counts.working > 0 || !!l.turn;

// A push-to-start's alert (Apple wants one): "2 need you, 3 working", no sound.
export function liveAlert(l: LiveState): { title: string; body: string } {
  const parts: string[] = [];
  if (l.counts.needs) parts.push(`${l.counts.needs} ${l.counts.needs === 1 ? "needs" : "need"} you`);
  if (l.counts.working) parts.push(`${l.counts.working} working`);
  return { title: "blimp", body: parts.length ? parts.join(", ") : (l.turn?.title ?? "") };
}

const secs = (ms: number) => Math.floor(ms / 1000);

// A Live Activity push: start (a push-to-start, with its type, its empty attributes, the alert, and a request for the
// new panel's own push token), update, or end (dismissed at once).
export function livePayload(event: LiveEvent, l: LiveState, now: number): { aps: Record<string, unknown> } {
  const aps: Record<string, unknown> = { timestamp: secs(now), event, "content-state": l };
  if (event === "start") Object.assign(aps, { "attributes-type": ATTRIBUTES_TYPE, attributes: {}, alert: liveAlert(l), "input-push-token": 1 });
  if (event === "end") aps["dismissal-date"] = secs(now);
  return { aps };
}

// What the panel shows now: the session list, the hidden projects, the followed turn, and its steps if its task list
// changed since its prompt went in (an older list is an earlier turn's).
export function liveNow(list: Session[], now = Date.now()): LiveState {
  const f = followed(list, now);
  const read = f?.session.transcript ? transcriptSteps(f.session.transcript) : undefined;
  const steps = f && read?.steps && read.at >= f.at ? read.steps : undefined;
  return liveState(list, new Set(readHidden()), f && { ...f, steps }, now);
}
