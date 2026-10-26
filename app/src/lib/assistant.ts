// The assistant (docs/superpowers/specs/2026-10-26-assistant-design.md, section 4): its jobs, the sessions it started
// or messaged (Session.job), as the session list's pinned Assistant group shows them. The phone's jobs bar has the same
// rules and tests (ios/BlimpKit AssistantJobs.swift). A job is in one bucket: needs you (it waits, or its turn ended
// with a question), working (it works, or its turn ended saying it's still at it), or done (its turn ended with a reply
// you haven't seen); else it isn't shown.

import type { Session } from "./api";
import { baseName } from "./files";
import { askedWords } from "./inbox";
import { lastActivity } from "./sessions";

export type JobBucket = "needs" | "working" | "done";
// words: for a wait, what it asks (else its note); none while it works (its note is the turn before's); else its note.
export type JobRow = { session: Session; project: string; reason: string; bucket: JobBucket; words?: string };

function bucket(s: Session): JobBucket | undefined {
  if (s.state === "waiting" || (s.state === "done" && s.note?.status === "question")) return "needs";
  if (s.state === "working" || (s.state === "done" && s.note?.status === "progress")) return "working";
  if (s.state === "done" && s.unread) return "done";
}

const since = (s: Session) => s.stateSince ?? lastActivity(s);

// Needs you, the oldest wait first; working, the longest first; done, the newest first. Sorts are stable: ties keep
// the list's order.
export function jobRows(sessions: Session[]): JobRow[] {
  const rows: JobRow[] = [];
  for (const s of sessions) {
    const b = bucket(s);
    if (!s.job || !b) continue;
    const words = s.state === "waiting" ? (askedWords(s.prompt) ?? s.note?.text) : s.state === "working" ? undefined : s.note?.text;
    rows.push({ session: s, project: baseName(s.dir), reason: s.job.reason, bucket: b, words });
  }
  const of = (b: JobBucket) => rows.filter((r) => r.bucket === b);
  return [
    ...of("needs").sort((a, b) => since(a.session) - since(b.session)),
    ...of("working").sort((a, b) => since(a.session) - since(b.session)),
    ...of("done").sort((a, b) => lastActivity(b.session) - lastActivity(a.session)),
  ];
}

// "1 needs you · 2 working · 1 done", leaving out the empty ones; "" with no job to show.
export function jobCounts(rows: JobRow[]): string {
  const n = (b: JobBucket) => rows.filter((r) => r.bucket === b).length;
  return [n("needs") && `${n("needs")} needs you`, n("working") && `${n("working")} working`, n("done") && `${n("done")} done`].filter(Boolean).join(" · ");
}
