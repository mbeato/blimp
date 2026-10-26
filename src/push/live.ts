// The live panel's runner (docs/superpowers/specs/2026-10-26-phone-live-activity-design.md, "When it shows"): every
// second, while there's a push key and a push-to-start token, what the panel shows (live.ts). One panel:
// - started when something needs you or works (or a followed turn runs): by the app itself when it's open (the events
//   socket's "live" message, so no banner), else, or when the app hasn't sent the new panel's token 10 s on, by a
//   push-to-start (a quiet alert: no sound);
// - updated when what it shows changes, to the newest token the app sent for it: priority 5, 10 for a new needs-you,
//   no alert (notifications already ring);
// - ended after 10 minutes with nothing needing you or working, dismissed at once;
// - ended and started again at 7 h 45 min, before iOS ends it at 8 hours.
// A panel whose token never came, or went (Apple said gone), gets no pushes until it ends. Tokens Apple says are gone
// are removed. When blimpd starts with a panel's token kept, it carries on with that panel.

import { isBusy, livePayload, liveShape, type LiveState } from "../live";
import type { Session } from "../sessions";
import { goneDevice, type Sent } from "./apns";
import type { Creds, Device, LiveList } from "./store";

export const QUIET = 10 * 60_000;
export const RESTART = (7 * 60 + 45) * 60_000;
export const APP_GRACE = 10_000;

export type LiveDeps = {
  sessions: () => Promise<Session[]>;
  // What the panel shows, from the session list (liveNow in live.ts).
  content: (list: Session[], now: number) => LiveState;
  creds: () => Creds | undefined;
  // Newest first, as push.json keeps them.
  starts: () => Device[];
  activities: () => Device[];
  clearActivities: () => void;
  send: (c: Creds, d: Device, payload: object, priority: 5 | 10) => Promise<Sent>;
  gone: (list: LiveList, d: Device) => void;
  // Asks every app open with the phone's token to start the panel; false when none is.
  tellApp: (state: LiveState) => boolean;
  now: () => number;
  log: (line: string) => void;
};

type Panel = {
  since: number; // when it started (ms)
  sent: string; // what it shows (liveShape), as last sent or asked for
  needs: Set<string>; // which sessions needed you in that
  asked?: number; // when the open app was asked to start it
  quiet?: number; // since when nothing needs you or works
};

// The sessions that need you in what it shows, the followed turn's among them.
const needsOf = (l: LiveState) =>
  new Set([...(l.turn?.state === "needs" ? [l.turn.session] : []), ...l.rows.filter((r) => r.state === "needs").map((r) => r.session)]);

export class LiveRunner {
  private panel?: Panel;
  private listed = false;
  private busy = false;

  constructor(private deps: LiveDeps) {}

  async tick(): Promise<void> {
    if (this.busy) return; // a slow zmx shouldn't pile up checks
    this.busy = true;
    try {
      const start = this.deps.starts()[0];
      const creds = start ? this.deps.creds() : undefined;
      if (!start || !creds) {
        this.panel = undefined;
        this.listed = false;
        return;
      }
      const now = this.deps.now();
      const list = await this.deps.sessions();
      // An empty list after sessions is more likely a zmx list that failed than every session gone (as in watch.ts).
      if (!list.length && this.listed) return;
      this.listed = list.length > 0;
      const state = this.deps.content(list, now);
      const token = this.deps.activities()[0];
      // blimpd started again while a panel was up: carry on with it, as of when its token came.
      if (!this.panel && token) this.panel = { since: token.at, sent: "", needs: new Set() };
      const p = this.panel;
      if (!p) {
        if (isBusy(state)) await this.begin(creds, start, state, now);
        return;
      }
      if (isBusy(state)) p.quiet = undefined;
      else p.quiet ??= now;
      if (p.quiet !== undefined && now - p.quiet >= QUIET) return await this.end(creds, token, state, now);
      if (now - p.since >= RESTART) {
        await this.end(creds, token, state, now);
        if (isBusy(state)) await this.begin(creds, start, state, now);
        return;
      }
      if (!token) {
        // The app was asked, and no token came: it wasn't open after all.
        if (p.asked !== undefined && now - p.asked >= APP_GRACE) {
          p.asked = undefined;
          await this.pushStart(creds, start, state, p, now);
        }
        return;
      }
      const shape = liveShape(state);
      if (shape === p.sent) return;
      const needs = needsOf(state);
      const urgent = [...needs].some((n) => !p.needs.has(n));
      p.sent = shape;
      p.needs = needs;
      await this.send(creds, "activities", token, livePayload("update", state, now), urgent ? 10 : 5);
    } catch (e) {
      this.deps.log(`push: live panel: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  // Tokens kept from before are an ended panel's. The open app starts it with no banner; with none open, Apple does.
  private async begin(creds: Creds, start: Device, state: LiveState, now: number) {
    this.deps.clearActivities();
    const p: Panel = { since: now, sent: liveShape(state), needs: needsOf(state) };
    this.panel = p;
    if (this.deps.tellApp(state)) p.asked = now;
    else await this.pushStart(creds, start, state, p, now);
  }

  private async pushStart(creds: Creds, start: Device, state: LiveState, p: Panel, now: number) {
    p.sent = liveShape(state);
    p.needs = needsOf(state);
    await this.send(creds, "starts", start, livePayload("start", state, now), 10);
  }

  private async end(creds: Creds, token: Device | undefined, state: LiveState, now: number) {
    this.panel = undefined;
    if (token) await this.send(creds, "activities", token, livePayload("end", state, now), 10);
    this.deps.clearActivities();
  }

  private async send(creds: Creds, list: LiveList, d: Device, payload: object, priority: 5 | 10) {
    const r = await this.deps.send(creds, d, payload, priority);
    if (goneDevice(r)) {
      this.deps.gone(list, d);
      this.deps.log(`push: Apple says a live panel token no longer works (${r.reason ?? r.status}), so it's removed`);
    } else if (r.status !== 200) this.deps.log(`push: Apple said ${r.status || "nothing"}${r.reason ? ` (${r.reason})` : ""} to the live panel`);
  }
}
