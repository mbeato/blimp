// What you've seen of each Claude conversation, the same for the Mac app and the phone: the time of the
// newest reply that was on screen in either (docs/DESIGN.md "Unread"). <socket dir>/seen.json:
//   { "since": <ms>, "seen": { "<sessionId>": <ms> } }
// A conversation with no entry counts as seen up to `since`, when blimpd first made the file, so nothing
// from before blimpd kept track shows as unread.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { blimpDir } from "./sessions";

export type Seen = { since: number; seen: Record<string, number> };

export const seenFile = () => join(blimpDir(), "seen.json");

// Missing or unreadable: nothing is unread (blimpd makes the file when it starts).
export function readSeen(file = seenFile()): Seen {
  try {
    const s = JSON.parse(readFileSync(file, "utf8"));
    if (typeof s?.since === "number" && s.seen && typeof s.seen === "object") return s;
  } catch {}
  return { since: Infinity, seen: {} };
}

function write(file: string, s: Seen) {
  writeFileSync(file + ".tmp", JSON.stringify(s), { mode: 0o600 });
  renameSync(file + ".tmp", file);
}

// At blimpd's start: from now on, a reply nobody has seen is unread.
export function startSeen(file = seenFile(), now = Date.now()) {
  if (!existsSync(file)) write(file, { since: now, seen: {} });
}

// Claude replied (at `replied`, ms) after the newest reply you've seen of that conversation.
export function isUnread(s: Seen, sessionId?: string, replied?: number): boolean {
  return !!sessionId && !!replied && replied > (s.seen[sessionId] ?? s.since);
}

// The conversation was on screen with its reply at `replied`: seen up to there. false if it already was.
export function markSeen(sessionId: string, replied: number, file = seenFile()): boolean {
  const s = readSeen(file);
  if (s.since === Infinity || !isUnread(s, sessionId, replied)) return false;
  s.seen[sessionId] = replied;
  write(file, s);
  return true;
}
