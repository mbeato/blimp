// The widgets' pinger (docs/superpowers/specs/2026-10-25-phone-widgets-design.md, "How they stay up to date"): every
// second, while there's a push key and a widget push token, the widgets' summary (widget.ts) from the session list.
// When what they show changes, a widget push, which only tells iOS to reload them (they then GET /widget): a
// needs-you that wasn't there at once, anything else 2 minutes after the last ping at the earliest, one ping then
// covering everything since. What it finds first counts as known, so a restart pings nothing.

import type { Session } from "../sessions";
import { widgetShape, widgetSummary } from "../widget";
import { goneDevice, type Sent } from "./apns";
import type { Creds, Device } from "./store";

export const PING = { aps: { "content-changed": true } };
export const PING_GAP = 2 * 60_000;

export type WidgetDeps = {
  sessions: () => Promise<Session[]>;
  hidden: () => Set<string>;
  creds: () => Creds | undefined;
  widgets: () => Device[];
  send: (c: Creds, d: Device) => Promise<Sent>;
  gone: (d: Device) => void;
  now: () => number;
  log: (line: string) => void;
};

export class WidgetPinger {
  // What the widgets show now, and which sessions need you in it.
  private known?: { shape: string; needs: Set<string> };
  private listed = false;
  private pending = false;
  private lastPing = -Infinity;
  private busy = false;

  constructor(private deps: WidgetDeps) {}

  async tick(): Promise<void> {
    if (this.busy) return; // a slow zmx shouldn't pile up checks
    this.busy = true;
    try {
      const widgets = this.deps.widgets();
      const creds = widgets.length ? this.deps.creds() : undefined;
      if (!creds) {
        this.known = undefined;
        this.listed = false;
        this.pending = false;
        return;
      }
      const now = this.deps.now();
      const list = await this.deps.sessions();
      // An empty list after sessions is more likely a zmx list that failed than every session gone (as in watch.ts).
      if (!list.length && this.listed) return;
      this.listed = list.length > 0;
      const w = widgetSummary(list, this.deps.hidden(), now);
      const shape = widgetShape(w);
      const needs = new Set(w.rows.filter((r) => r.state === "needs").map((r) => r.session));
      const was = this.known;
      this.known = { shape, needs };
      if (!was) return;
      if (shape !== was.shape) this.pending = true;
      const urgent = [...needs].some((n) => !was.needs.has(n));
      if (this.pending && (urgent || now - this.lastPing >= PING_GAP)) {
        this.pending = false;
        this.lastPing = now;
        await this.ping(creds, widgets);
      }
    } catch (e) {
      this.deps.log(`push: widgets: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  private async ping(creds: Creds, widgets: Device[]) {
    for (const d of widgets) {
      const r = await this.deps.send(creds, d);
      if (goneDevice(r)) {
        this.deps.gone(d);
        this.deps.log(`push: Apple says a widget push token no longer works (${r.reason ?? r.status}), so it's removed`);
      } else if (r.status !== 200) this.deps.log(`push: Apple said ${r.status || "nothing"}${r.reason ? ` (${r.reason})` : ""} to a widget ping`);
    }
  }
}
