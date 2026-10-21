// Mac notifications and the Dock badge for sessions that start waiting for you.

import { inTauri } from "./connection";
import type { Session } from "./api";
import { claimNotice } from "./place";
import { tildify } from "./sessions";

// session: "<server key>/<session name>". wait: that plus when the wait started, so each wait
// is announced once even when several windows see it.
export type NotifyFn = (title: string, body: string, id: { session: string; wait: string }) => void;

// Where the user is looking right now. viewing: the sessions on screen in this window
// ("<server key>/<session name>"), one per terminal split.
export type Focus = { focused: boolean; viewing: string[] };

// Remembers each server's last states and notifies when a session becomes waiting.
// The first list from a server only records states, so opening the app doesn't announce
// every session that was already waiting.
export class WaitWatcher {
  private last = new Map<string, Map<string, string>>();

  constructor(
    private notify: NotifyFn,
    private focus: () => Focus,
  ) {}

  update(server: string, home: string, sessions: Session[]) {
    const prev = this.last.get(server);
    this.last.set(server, new Map(sessions.map((s) => [s.name, s.state])));
    if (!prev) return;
    const f = this.focus();
    for (const s of sessions) {
      if (s.state !== "waiting" || prev.get(s.name) === "waiting") continue;
      const session = `${server}/${s.name}`;
      if (f.focused && f.viewing.includes(session)) continue;
      this.notify(`${s.title} is waiting for you`, tildify(s.dir, home), { session, wait: `${session}/${s.stateSince ?? s.updatedAt ?? Date.now()}` });
    }
  }
}

// The conversations to mark read (blimpd's /seen): the unread sessions on screen in a window that has
// focus. sent: when each was last sent, so it isn't sent again before blimpd's list catches up.
export function toMarkSeen(server: string, sessions: Session[], f: Focus, sent: Map<string, number>, now = Date.now()): string[] {
  if (!f.focused) return [];
  const out: string[] = [];
  for (const s of sessions) {
    if (!s.unread || !s.sessionId || !f.viewing.includes(`${server}/${s.name}`)) continue;
    if (now - (sent.get(s.sessionId) ?? -Infinity) < 3000) continue;
    sent.set(s.sessionId, now);
    out.push(s.sessionId);
  }
  return out;
}

let permission: Promise<boolean> | null = null;

async function allowed(): Promise<boolean> {
  if (inTauri()) {
    const n = await import("@tauri-apps/plugin-notification");
    return (await n.isPermissionGranted()) || (await n.requestPermission()) === "granted";
  }
  if (!("Notification" in window)) return false;
  if (Notification.permission === "default") return (await Notification.requestPermission()) === "granted";
  return Notification.permission === "granted";
}

export const notify: NotifyFn = (title, body, id) => {
  permission ??= allowed().catch(() => false);
  void permission.then(async (ok) => {
    if (!ok || !(await claimNotice(id.session, id.wait))) return;
    if (inTauri()) (await import("@tauri-apps/plugin-notification")).sendNotification({ title, body });
    else new Notification(title, { body });
  });
};

// Dock badge = number of waiting sessions. Only the Mac app has a Dock.
export async function setBadge(n: number) {
  if (!inTauri()) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow()
    .setBadgeCount(n || undefined)
    .catch(() => {});
}
