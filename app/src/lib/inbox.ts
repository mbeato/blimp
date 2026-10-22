// A project's inbox (docs/DESIGN.md, "Inbox"): its sessions and unread Earlier conversations sorted under
// Waiting on you, Done (finished, not read yet) and Working, each with a few words from what it asks or Haiku's
// note on its last turn, and the rest as "other" (the phone folds them). Needs you: the project's waiting
// sessions, oldest first (the phone's top band; another project's are in its own inbox). The phone builds the same (ios/BlimpKit Inbox.swift), by
// the same rules. The Mac's summary shows Waiting on you and Done.

import type { Conversation, Session } from "./api";
import { lastActivity } from "./sessions";

// since: when it started waiting or working (its state's start), else its activity.
export type InboxLine = { id: string; title: string; words?: string; activity: number; since: number; session?: Session; conversation?: Conversation };
export type Inbox = { waiting: InboxLine[]; done: InboxLine[]; working: InboxLine[]; other: InboxLine[] };

// What a waiting session asks: a permission's summary, or its first question.
export const askedWords = (p: Session["prompt"]): string | undefined =>
  p?.kind === "permission" ? p.summary : p?.kind === "question" ? p.questions?.[0]?.question : undefined;

const sessionLine = (s: Session, words?: string): InboxLine => ({ id: "session-" + s.name, title: s.title, words, activity: lastActivity(s), since: s.stateSince ?? lastActivity(s), session: s });
const pastLine = (c: Conversation): InboxLine => ({ id: "past-" + c.sessionId, title: c.title, words: c.note?.text, activity: c.updatedAt, since: c.updatedAt, conversation: c });

// A running session that waits on you: what it asks, or a question in its note.
function waitingLine(s: Session): InboxLine | undefined {
  if (s.state === "waiting") return sessionLine(s, askedWords(s.prompt) ?? s.note?.text);
  if (s.state === "done" && s.note?.status === "question") return sessionLine(s, s.note.text);
}

const unreadPast = (past: Conversation[]) => past.filter((c) => c.unread && c.note?.status !== "progress");
// stable sorts: ties keep the list's order
const newestFirst = (l: InboxLine[]) => l.sort((a, b) => b.activity - a.activity);
const oldestFirst = (l: InboxLine[]) => l.sort((a, b) => a.since - b.since);

export function inbox(running: Session[], past: Conversation[]): Inbox {
  const out: Inbox = { waiting: [], done: [], working: [], other: [] };
  for (const s of running) {
    const w = waitingLine(s);
    if (w) out.waiting.push(w);
    else if (s.state === "done" && s.unread && s.note?.status !== "progress") out.done.push(sessionLine(s, s.note?.text));
    else if (s.state === "working") out.working.push(sessionLine(s));
    else out.other.push(sessionLine(s));
  }
  for (const c of unreadPast(past)) out[c.note?.status === "question" ? "waiting" : "done"].push(pastLine(c));
  newestFirst(out.waiting);
  newestFirst(out.done);
  newestFirst(out.other);
  oldestFirst(out.working);
  return out;
}

// Needs you, in dir: each of its running sessions that waits on you, and its unread past conversations with a
// question (past: those no running session has open), the oldest wait first.
export function needsYou(dir: string, sessions: Session[], past: Conversation[] = []): InboxLine[] {
  const lines = sessions.filter((s) => s.dir === dir).map(waitingLine).filter((l): l is InboxLine => !!l);
  return oldestFirst([...lines, ...unreadPast(past).filter((c) => c.note?.status === "question").map(pastLine)]);
}
