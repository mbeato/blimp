// How a folder's session list is built: its running sessions, then the earlier conversations
// that aren't running, as `claude --resume` lists them for the folder.

import type { Conversation, Session } from "./api";

export const tildify = (dir: string, home: string) =>
  home && (dir === home || dir.startsWith(home + "/")) ? "~" + dir.slice(home.length) : dir;

// Claude Code, on Claude or on GLM: titled by its conversation, ends at once when idle.
export const isClaude = (s: Pick<Session, "kind">) => s.kind === "claude" || s.kind === "claude-glm";

// Kinds whose hooks report working / waiting / idle. Anything else shows a plain mark, like a shell.
export const hasState = (s: Pick<Session, "kind">) => isClaude(s) || s.kind === "codex";

// What a row shows: Claude's conversation title, or the zmx name for anything else.
export const sessionTitle = (s: Session) => (isClaude(s) ? s.title : s.name);

// What Copy Reference puts on the clipboard: pasted into another session, enough for its Claude
// to read this one's conversation and, for Claude Code, send it a message (blimpd send).
export function sessionReference(s: Session): string {
  const lines = [`Another blimp session: ${isClaude(s) ? `"${s.title}" (${s.name})` : s.name}, in ${s.dir}.`];
  if (s.transcript) lines.push(`Its conversation so far (JSONL): ${s.transcript}`);
  if (s.sessionId) lines.push(`To send it a message: blimpd send ${s.name} "<message>"`);
  return lines.join("\n");
}

export const lastActivity = (s: Session) => s.updatedAt ?? s.stateSince ?? s.created * 1000;

// Sessions started in exactly this folder, newest first, so a new one lands on top and rows
// don't move as their states change.
export const folderSessions = (sessions: Session[], dir: string) =>
  sessions.filter((s) => s.dir === dir).sort((a, b) => b.created - a.created || a.name.localeCompare(b.name));

// The list's rows, newest first: a split group (its sessions in left-to-right order) sits where
// its newest session would be, so an old pair doesn't jump above sessions started after it.
// order: the order the rows were dragged into (session names, top to bottom). Sessions it has
// keep it; the others (a new one, say) keep the place newest first gives them, so a new session
// still lands on top. A group sits where its first session in that order is.
export function listItems(listed: Session[], groups: Session[][], order: string[] = []): (Session | Session[])[] {
  const rank = new Map(order.map((n, i) => [n, i]));
  const known = listed.filter((s) => rank.has(s.name)).sort((a, b) => rank.get(a.name)! - rank.get(b.name)!);
  let k = 0;
  const sorted = listed.map((s) => (rank.has(s.name) ? known[k++] : s));
  const items: (Session | Session[])[] = [];
  const placed = new Set<Session[]>();
  for (const s of sorted) {
    const g = groups.find((g) => g.includes(s));
    if (!g) items.push(s);
    else if (!placed.has(g)) placed.add(g), items.push(g);
  }
  return items;
}

// The list's order once row `from` (a session, or a whole group) is dragged to the gap before row
// `to` (items.length: after the last): every session's name, top to bottom, a group's together.
export function moveItem(items: (Session | Session[])[], from: number, to: number): string[] {
  const rest = items.filter((_, i) => i !== from);
  rest.splice(to > from ? to - 1 : to, 0, items[from]);
  return rest.flat().map((s) => s.name);
}

// Earlier conversations, minus the ones a running session already has open.
export function earlier(convs: Conversation[], running: Session[]): Conversation[] {
  const open = new Set(running.map((s) => s.sessionId).filter(Boolean));
  return convs.filter((c) => !open.has(c.sessionId));
}

// Which session the terminal pane shows when nothing (or a session that's gone) is selected:
// the one waiting longest, else the newest.
export function pickSession(list: Session[]): Session | undefined {
  const waiting = list.filter((s) => s.state === "waiting").sort((a, b) => (a.stateSince ?? 0) - (b.stateSince ?? 0));
  return waiting[0] ?? list[0];
}
