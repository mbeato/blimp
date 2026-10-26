// The push watcher (docs/superpowers/specs/2026-10-20-phone-push-design.md, section 3): every second, whether or not
// an app is connected, the session list goes through the rule (rule.ts), and what it finds goes to every phone that
// asked, at once or, while the Mac is in use, up to 2 minutes later. Without a key and a phone it runs nothing, not
// even the list; once both are there, what it finds first counts as seen. The widgets' pinger (widgets.ts) runs on the
// same tick, and likewise only with a key and a widget push token; so does the live panel's runner (live.ts), with a
// key and a push-to-start token.

import { readHidden } from "../hidden";
import { liveNow } from "../live";
import { follow, newSummary, type Summary } from "../names";
import { claudeDir, listSessionsLite, type Session, zmxListAsync } from "../sessions";
import { Apns, goneDevice, type Sent } from "./apns";
import { pushPayload } from "./payload";
import { dueAt, type PushEvent, pushChanges, type PushSession, type Seen, stillDue } from "./rule";
import { type LiveDeps, LiveRunner } from "./live";
import { clearLive, type Creds, type Device, readCreds, readDevices, readLive, readWidgets, removeDevice, removeLive, removeWidget } from "./store";
import { PING, type WidgetDeps, WidgetPinger } from "./widgets";

export type WatchedSession = PushSession & Pick<Session, "title" | "dir" | "transcript">;
export type PushDeps = {
  sessions: () => Promise<WatchedSession[]>;
  creds: () => Creds | undefined;
  devices: () => Device[];
  send: (c: Creds, d: Device, payload: object, collapseId: string) => Promise<Sent>;
  gone: (d: Device) => void;
  // Claude's last reply in a transcript.
  reply: (transcript: string) => Promise<string | undefined>;
  now: () => number;
  // When the Mac app last said a blimp window was in front.
  active: () => number;
  log: (line: string) => void;
};

export class PushWatcher {
  private seen?: Map<string, Seen>;
  private held: { e: PushEvent; due: number }[] = [];
  private warned = false;
  private busy = false;

  constructor(private deps: PushDeps) {}

  async tick(): Promise<void> {
    if (this.busy) return; // a slow zmx shouldn't pile up checks
    this.busy = true;
    try {
      const devices = this.deps.devices();
      const creds = devices.length ? this.deps.creds() : undefined;
      if (devices.length && !creds && !this.warned) {
        this.warned = true;
        this.deps.log("push: a phone asked for notifications, but there's no push key yet (blimpd push-key)");
      }
      if (!creds) {
        this.seen = undefined;
        this.held = [];
        return;
      }
      // The clock first: building the list can take seconds, and a wait read late would look longer than it was.
      const now = this.deps.now();
      const list = await this.deps.sessions();
      // An empty list after sessions is more likely a zmx list that failed than every session gone, and forgetting
      // them would tell their waits again.
      if (!list.length && this.seen?.size) return;
      const { seen, events } = pushChanges(this.seen, list, now);
      this.seen = seen;
      const due = dueAt(now, this.deps.active());
      this.held.push(...events.map((e) => ({ e, due })));
      const ready = this.held.filter((h) => h.due <= now);
      this.held = this.held.filter((h) => h.due > now);
      for (const { e } of ready) {
        const s = list.find((x) => x.name === e.session);
        if (s && stillDue(e, list)) await this.notify(creds, devices, s, e);
      }
    } catch (e) {
      this.deps.log(`push: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  private async notify(creds: Creds, devices: Device[], s: WatchedSession, e: PushEvent) {
    // A transcript that can't be read still gets its finish told, with the folder's name instead of the reply.
    let reply: string | undefined;
    if (e.kind === "finish" && s.transcript)
      try {
        reply = await this.deps.reply(s.transcript);
      } catch (err) {
        this.deps.log(`push: couldn't read ${s.name}'s last reply (${(err as Error).message}), so the notification says the folder`);
      }
    const payload = pushPayload(s, e, reply);
    for (const d of devices) {
      // A newer notification for a session replaces the older one (Apple allows 64 bytes; names are ASCII).
      const r = await this.deps.send(creds, d, payload, s.name.slice(0, 64));
      if (goneDevice(r)) {
        this.deps.gone(d);
        this.deps.log(`push: Apple says a phone's token no longer works (${r.reason ?? r.status}), so it's removed`);
      } else if (r.status !== 200) this.deps.log(`push: Apple said ${r.status || "nothing"}${r.reason ? ` (${r.reason})` : ""} to ${s.name}'s ${e.kind}`);
    }
  }
}

// When the Mac app last said a blimp window was in front ({ "type": "active" } on /events, events.ts).
let lastActive = 0;
export const markActive = (now = Date.now()) => void (lastActive = now);
export const lastActiveAt = () => lastActive;

const summaries = new Map<string, Summary>(); // by transcript: each finish reads on from where the last one stopped
let client: { id: string; apns: Apns } | undefined;

// One client while the key stays the same; push-key with a new one gets a new client. Notifications, the widgets'
// pings and the live panel share it, so one connection to Apple.
export function apnsFor(c: Creds): Apns {
  const id = `${c.keyId}\0${c.teamId}\0${c.key}`;
  if (client?.id !== id) {
    client?.apns.close();
    client = { id, apns: new Apns(c) };
  }
  return client.apns;
}

const live: PushDeps = {
  sessions: async () => listSessionsLite(claudeDir(), await zmxListAsync()),
  creds: () => readCreds(),
  devices: () => readDevices(),
  send: (c, d, payload, collapseId) => apnsFor(c).send(d, payload, { collapseId }),
  gone: (d) => void removeDevice(d.token),
  reply: async (file) => {
    if (summaries.size > 200) summaries.clear();
    let sum = summaries.get(file);
    if (!sum) summaries.set(file, (sum = newSummary()));
    await follow(file, sum);
    return sum.reply;
  },
  now: Date.now,
  active: lastActiveAt,
  log: (line) => console.log(line),
};

const widgetsLive: WidgetDeps = {
  sessions: async () => listSessionsLite(claudeDir(), await zmxListAsync()),
  hidden: () => new Set(readHidden()),
  creds: () => readCreds(),
  widgets: () => readWidgets(),
  send: (c, d) => apnsFor(c).send(d, PING, { type: "widgets" }),
  gone: (d) => void removeWidget(d.token),
  now: Date.now,
  log: (line) => console.log(line),
};

// The phone's open apps (server.ts sets it): a message to each events socket opened with the phone's token; false
// when there's none.
let tellPhone: (message: string) => boolean = () => false;
export const onPhoneApps = (f: (message: string) => boolean) => void (tellPhone = f);

const liveLive: LiveDeps = {
  sessions: async () => listSessionsLite(claudeDir(), await zmxListAsync()),
  content: (list, now) => liveNow(list, now),
  creds: () => readCreds(),
  starts: () => readLive("starts"),
  activities: () => readLive("activities"),
  clearActivities: () => clearLive("activities"),
  send: (c, d, payload, priority) => apnsFor(c).send(d, payload, { type: "liveactivity", priority }),
  gone: (list, d) => void removeLive(list, d.token),
  tellApp: (state) => tellPhone(JSON.stringify({ type: "live", state })),
  now: Date.now,
  log: (line) => console.log(line),
};

export function startPush(every = 1000) {
  const w = new PushWatcher(live);
  const p = new WidgetPinger(widgetsLive);
  const l = new LiveRunner(liveLive);
  setInterval(() => {
    void w.tick();
    void p.tick();
    void l.tick();
  }, every);
}
