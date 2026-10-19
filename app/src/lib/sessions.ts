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

export const lastActivity = (s: Session) => s.updatedAt ?? s.stateSince ?? s.created * 1000;

// Sessions started in exactly this folder, newest first, so a new one lands on top and rows
// don't move as their states change.
export const folderSessions = (sessions: Session[], dir: string) =>
  sessions.filter((s) => s.dir === dir).sort((a, b) => b.created - a.created || a.name.localeCompare(b.name));

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
