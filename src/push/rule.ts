// When blimpd tells the phone (docs/superpowers/specs/2026-10-20-phone-push-design.md, section 3), from the session
// list each second and what it saw the second before: a session that starts waiting (an ask), and a Claude session
// whose turn of 30 s or more ends (a finish). Each wait and each finish once. The first list blimpd sees (after it
// starts, or after push is set up) counts as seen, so a restart doesn't tell them again.
// With the assistant running, a job's finish is left to it, and its own turn that a job update began is told however short.

import { CLAUDE_KINDS } from "../kinds";
import type { Session, State } from "../sessions";

export type PushSession = Pick<Session, "name" | "kind" | "state" | "stateSince" | "prompt" | "job" | "assistant">;
// What a session was doing: its state, the wait told (or seen) while waiting, and when its turn began.
export type Seen = { state: State; wait?: number; turn?: number };
export type PushEvent = { kind: "ask" | "finish"; session: string; key: number };

// A permission's options come from the screen up to 2 s after the wait starts (promptFor in sessions.ts), and Yes
// and No on the notification need the final ones. A wait answered before then isn't told at all.
export const ASK_SETTLE = 3000;
export const FINISH_MIN = 30_000;
// How long the phone waits while the Mac is in use.
export const HOLD = 2 * 60_000;
// A job update typed into the assistant (reports.ts) this long before its turn began still counts as what began it.
export const UPDATE_SLACK = 15_000;

// The wait: when the hook says it began, or for one without a prompt (Codex), when the state did.
export const waitKey = (s: PushSession) => s.prompt?.at ?? s.stateSince ?? 0;

// updated: when a job update was last typed into the assistant, if ever.
export function pushChanges(before: Map<string, Seen> | undefined, list: PushSession[], now: number, updated?: number): { seen: Map<string, Seen>; events: PushEvent[] } {
  // While the assistant runs, it tells its jobs' finishes itself.
  const reporting = list.some((s) => s.assistant);
  const seen = new Map<string, Seen>();
  const events: PushEvent[] = [];
  for (const s of list) {
    const was = before?.get(s.name);
    if (s.state === "waiting") {
      const wait = waitKey(s);
      const known = !before || was?.wait === wait;
      const settled = now - wait >= ASK_SETTLE;
      if (!known && settled) events.push({ kind: "ask", session: s.name, key: wait });
      // Not settled yet: the wait stays untold, so a later list tells it.
      seen.set(s.name, { state: s.state, wait: known || settled ? wait : was?.wait, turn: was?.turn });
    } else if (s.state === "working") {
      // A turn goes on through its waits. One from done, unknown or a new session begins at this state.
      const going = (was?.state === "working" || was?.state === "waiting") && was.turn !== undefined;
      seen.set(s.name, { state: s.state, turn: going ? was.turn : (s.stateSince ?? now) });
    } else {
      if (s.state === "done" && was?.state === "working" && was.turn !== undefined && CLAUDE_KINDS.includes(s.kind)) {
        const end = s.stateSince ?? now;
        // The assistant's turn that an update began is told however short; a job's finish is the assistant's to tell.
        const fromUpdate = !!s.assistant && updated !== undefined && updated >= was.turn - UPDATE_SLACK && updated <= end;
        if ((end - was.turn >= FINISH_MIN || fromUpdate) && !(s.job && reporting)) events.push({ kind: "finish", session: s.name, key: end });
      }
      seen.set(s.name, { state: s.state });
    }
  }
  return { seen, events };
}

// A held one goes only if the session still shows what it was about.
export function stillDue(e: PushEvent, list: PushSession[]): boolean {
  const s = list.find((x) => x.name === e.session);
  if (!s) return false;
  return e.kind === "ask" ? s.state === "waiting" && waitKey(s) === e.key : s.state === "done" && s.stateSince === e.key;
}

// When to send what happened now: at once, or, while the Mac was in use in the last 2 minutes, 2 minutes after that.
export const dueAt = (now: number, lastActive: number) => (now - lastActive < HOLD ? lastActive + HOLD : now);
