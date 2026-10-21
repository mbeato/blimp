// A project's inbox (docs/DESIGN.md, "Inbox"): its sessions and unread Earlier conversations sorted under
// Waiting on you and Done, each with a few words from what it asks or Haiku's note on its last turn. Work
// still going on isn't listed (the phone's paragraph tells it). The phone builds the same (ios/BlimpKit
// Inbox.swift), by the same rules.

import type { Conversation, Session } from "./api";
import { lastActivity } from "./sessions";

export type InboxLine = { id: string; title: string; words?: string; activity: number; session?: Session; conversation?: Conversation };
export type Inbox = { waiting: InboxLine[]; done: InboxLine[] };

// What a waiting session asks: a permission's summary, or its first question.
export const askedWords = (p: Session["prompt"]): string | undefined =>
  p?.kind === "permission" ? p.summary : p?.kind === "question" ? p.questions?.[0]?.question : undefined;

export function inbox(running: Session[], past: Conversation[]): Inbox {
  const out: Inbox = { waiting: [], done: [] };
  for (const s of running) {
    const line = { id: "session-" + s.name, title: s.title, activity: lastActivity(s), session: s };
    const n = s.note;
    if (s.state === "waiting") out.waiting.push({ ...line, words: askedWords(s.prompt) ?? n?.text });
    else if (s.state === "done" && n?.status === "question") out.waiting.push({ ...line, words: n.text });
    else if (s.state === "done" && s.unread && n?.status !== "progress") out.done.push({ ...line, words: n?.text });
  }
  for (const c of past) {
    if (!c.unread || c.note?.status === "progress") continue;
    const line = { id: "past-" + c.sessionId, title: c.title, words: c.note?.text, activity: c.updatedAt, conversation: c };
    out[c.note?.status === "question" ? "waiting" : "done"].push(line);
  }
  for (const list of Object.values(out)) list.sort((a, b) => b.activity - a.activity); // stable: ties keep the list's order
  return out;
}
