// The followed turn (docs/superpowers/specs/2026-10-26-phone-live-activity-design.md): the session Max last sent a
// prompt to from the phone (a chat socket's input, or a new session's first message, with the phone's token), until
// that turn ends: the session is done since the prompt, or gone. Waiting on Max keeps it: the turn goes on. One that
// hasn't started 2 minutes on (the prompt never reached Claude) ends too. One at a time, in memory: a restart of
// blimpd forgets it.

import type { Session } from "./sessions";

export const START_GRACE = 2 * 60_000;

let mark: { session: string; at: number } | undefined;

export const markFollowed = (session: string, now = Date.now()) => void (mark = { session, at: now });
export const clearFollowed = () => void (mark = undefined);

// The followed session and when its prompt went in (ms), or none. An empty list is more likely a zmx list that
// failed than every session gone (as in push/watch.ts), so it keeps the mark.
export function followed(list: Session[], now = Date.now()): { session: Session; at: number } | undefined {
  const m = mark;
  if (!m || !list.length) return;
  const s = list.find((x) => x.name === m.session);
  const ended = !s || (s.state === "done" && (s.stateSince ?? 0) >= m.at);
  const never = s && s.state !== "working" && s.state !== "waiting" && now - m.at >= START_GRACE;
  if (ended || never) return void (mark = undefined);
  return { session: s, at: m.at };
}
