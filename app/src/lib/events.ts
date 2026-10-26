// The /events WebSocket: the session list as it changes, the ports sessions listen on, the
// server browser's tabs, changes to watched paths, and pages sessions showed (lib/visuals.ts).

import type { Api, BrowserTab, Port, Session, Visual } from "./api";
import { visualFrom } from "./visuals";

export type EventHandlers = {
  onSessions: (sessions: Session[]) => void;
  onPorts: (ports: Port[]) => void;
  onBrowser: (tabs: BrowserTab[]) => void;
  onFs: (paths: string[]) => void;
  onVisual: (v: Visual) => void;
  onClose: () => void; // the socket dropped or never opened; the caller decides when to retry
};

export class EventsSocket {
  private ws: WebSocket;
  private watching: string[] = [];
  private closed = false;

  constructor(api: Api, private h: EventHandlers) {
    this.ws = new WebSocket(api.eventsUrl());
    // The watch set belongs to the socket on the server, so send it again on every new socket.
    this.ws.onopen = () => this.sendWatch();
    this.ws.onmessage = (e) => {
      if (typeof e.data !== "string") return;
      let msg: any;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === "sessions" && Array.isArray(msg.sessions)) this.h.onSessions(msg.sessions);
      else if (msg.type === "ports" && Array.isArray(msg.ports)) this.h.onPorts(msg.ports);
      else if (msg.type === "browser" && Array.isArray(msg.tabs)) this.h.onBrowser(msg.tabs);
      else if (msg.type === "fs" && Array.isArray(msg.paths)) this.h.onFs(msg.paths);
      else if (msg.type === "visual") {
        const v = visualFrom(msg);
        if (v) this.h.onVisual(v);
      }
    };
    this.ws.onclose = () => {
      if (!this.closed) h.onClose();
      this.closed = true;
    };
  }

  // Replaces the watch set (expanded folders plus open files).
  watch(paths: string[]) {
    this.watching = paths;
    this.sendWatch();
  }

  private sendWatch() {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "watch", paths: this.watching }));
  }

  close() {
    this.closed = true;
    this.ws.close();
  }
}
