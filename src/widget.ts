// What the phone's widgets show (docs/superpowers/specs/2026-10-25-phone-widgets-design.md): every running session
// outside the hidden projects, by the rules the inbox gives each session (ios/BlimpKit/Sources/BlimpKit/Inbox.swift,
// app/src/lib/inbox.ts): needs you (waiting, or done with a question in its note), the oldest wait first; new (done
// and unread, its note not "in progress"), the newest first; working, the longest-running first. At most 9 rows, for
// the large widget. Past conversations stay in their project's inbox, as the drawer's project marks leave them out.
// The widget key, which reads only GET /widget (server.ts), comes from the phone's token.

import { createHmac } from "node:crypto";
import type { Session } from "./sessions";

export type WidgetState = "needs" | "new" | "working";
export type WidgetRow = { session: string; dir: string; title: string; state: WidgetState; since: number };
export type WidgetSummary = { at: number; counts: { needs: number; new: number; working: number }; rows: WidgetRow[]; lastFinished?: number };

export const MAX_ROWS = 9;

// ms: its newest activity, as the phone's Session.activity has it.
const activity = (s: Session) => Math.max(s.updatedAt ?? 0, s.stateSince ?? 0, s.created * 1000);
// ms: when it started waiting or working, else its activity (InboxLine.since).
const since = (s: Session) => s.stateSince ?? activity(s);

function widgetState(s: Session): WidgetState | undefined {
  if (s.state === "waiting" || (s.state === "done" && s.note?.status === "question")) return "needs";
  if (s.state === "done" && s.unread && s.note?.status !== "progress") return "new";
  if (s.state === "working") return "working";
}

// Ties keep the list's order: sort is stable.
export function widgetSummary(sessions: Session[], hidden: Set<string>, now = Date.now()): WidgetSummary {
  const shown = sessions.filter((s) => !hidden.has(s.dir));
  const of = (state: WidgetState) => shown.filter((s) => widgetState(s) === state);
  const needs = of("needs").sort((a, b) => since(a) - since(b));
  const fresh = of("new").sort((a, b) => activity(b) - activity(a));
  const working = of("working").sort((a, b) => since(a) - since(b));
  const row = (state: WidgetState) => (s: Session): WidgetRow => ({ session: s.name, dir: s.dir, title: s.title, state, since: since(s) });
  const rows = [...needs.map(row("needs")), ...fresh.map(row("new")), ...working.map(row("working"))].slice(0, MAX_ROWS);
  const finished = shown.filter((s) => s.state === "done").map(since);
  return {
    at: now,
    counts: { needs: needs.length, new: fresh.length, working: working.length },
    rows,
    ...(finished.length ? { lastFinished: Math.max(...finished) } : {}),
  };
}

// What the widgets show, for the pinger to tell a change: the counts, and the rows and their states in order. A
// working row's time isn't a change (the widget counts it up by itself).
export const widgetShape = (w: WidgetSummary) => JSON.stringify([w.counts, w.rows.map((r) => [r.session, r.state])]);

// HMAC-SHA256 of the phone's token with the text "blimp widget", hex. No phone paired: none.
export const widgetKey = (phoneToken: string) => (phoneToken ? createHmac("sha256", phoneToken).update("blimp widget").digest("hex") : "");
