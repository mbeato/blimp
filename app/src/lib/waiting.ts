// Mac notifications and the Dock badge for sessions that start waiting for you.

import { inTauri } from "./connection";
import type { Session } from "./api";
import { tildify } from "./sidebar";

export type NotifyFn = (title: string, body: string) => void;

// Where the user is looking right now. activeTab is "<server key>/<session name>".
export type Focus = { focused: boolean; activeTab: string | null };

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
      if (f.focused && f.activeTab === `${server}/${s.name}`) continue;
      this.notify(`${s.title} is waiting for you`, tildify(s.dir, home));
    }
  }
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

export const notify: NotifyFn = (title, body) => {
  permission ??= allowed().catch(() => false);
  void permission.then(async (ok) => {
    if (!ok) return;
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
