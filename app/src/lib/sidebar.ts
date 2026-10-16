// How the sidebar orders sessions: one waiting queue for every server at the top, then one
// group per folder.

import type { Session } from "./api";

export const tildify = (dir: string, home: string) =>
  home && (dir === home || dir.startsWith(home + "/")) ? "~" + dir.slice(home.length) : dir;

export const lastActivity = (s: Session) => s.updatedAt ?? s.stateSince ?? s.created * 1000;

export type FolderGroup = { dir: string; label: string; sessions: Session[] };

// Waiting sessions from every server, oldest wait first, so the list reads like a queue and rows
// don't jump. One queue across servers, so a session waiting on the second server is still at
// the top of the sidebar.
export function waitingQueue<L>(servers: { link: L; sessions: Session[] }[]): { link: L; s: Session }[] {
  const since = (s: Session) => s.stateSince ?? lastActivity(s);
  return servers
    .flatMap(({ link, sessions }) => sessions.filter((s) => s.state === "waiting").map((s) => ({ link, s })))
    .sort((a, b) => since(a.s) - since(b.s));
}

// Folder groups hold the sessions that aren't waiting: a waiting one is shown only in the queue
// at the top. Sessions newest first; the groups are ordered by their newest session, which only
// changes when a session starts.
export function folderGroups(sessions: Session[], home: string): FolderGroup[] {
  const byDir = new Map<string, Session[]>();
  for (const s of sessions) {
    if (s.state === "waiting") continue;
    const list = byDir.get(s.dir) ?? [];
    list.push(s);
    byDir.set(s.dir, list);
  }
  const folders = [...byDir].map(([dir, list]) => ({
    dir,
    label: tildify(dir, home),
    sessions: list.sort((a, b) => b.created - a.created || a.name.localeCompare(b.name)),
  }));
  return folders.sort((a, b) => b.sessions[0].created - a.sessions[0].created || a.label.localeCompare(b.label));
}
