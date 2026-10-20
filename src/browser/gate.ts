// The gate: one Chrome, many DevTools clients, each shown a browser with only its folder's tabs
// (docs/superpowers/specs/2026-10-20-server-browser-design.md). It holds blimpd's one connection
// to Chrome (the pipe) and multiplexes it:
// - Command ids are the gate's own, mapped back to each client's on the way out.
// - Sessions (flat mode) belong to the client that attached; their messages go to that client
//   only. Child sessions (iframes, workers) attached inside a session belong to the same client.
// - Target discovery and auto-attach are the gate's: it discovers every target itself, and tells
//   each client only of page targets in its folder, in the order Chrome would (the existing
//   targets before the reply), or Puppeteer starts with no pages.
// - A tab's folder: the one whose client created it, the opener's for a page a page opened, or the
//   one blimp opened it for. Targets with no folder (Chrome's first blank tab) are nobody's.
// Folders keep sessions' tabs apart; they aren't a security boundary: every tab shares one
// profile.

import type { CdpMessage, Chrome } from "./chrome";

export type Tab = { id: string; folder: string; url: string; title: string; openedBy?: string };
export type GateClient = { folder: string; session?: string; send(text: string): void };

type Target = { info: any; folder: string | null; openedBy?: string; seen: boolean; announced: boolean };
type Conn = GateClient & { discover: boolean; autoAttach: boolean; sessions: Set<string> };

const NO_TARGET = "No target with given id found";

export class Gate {
  private next = 1;
  // The gate's command ids: a client's command (answered to it under its own id), or one of the
  // gate's own with something to do with the answer.
  private pending = new Map<number, { conn: Conn; id?: number; after?: (m: CdpMessage) => void }>();
  private targets = new Map<string, Target>();
  private owners = new Map<string, Conn>(); // sessionId → client
  private attachFor = new Map<string, Conn[]>(); // targetId → clients whose attach is on its way
  private conns = new Set<Conn>();
  private listeners: (() => void)[] = [];
  private discovering?: Promise<void>;

  constructor(private chrome: Chrome) {
    chrome.onMessage((m) => this.fromChrome(m));
  }

  ready(): Promise<void> {
    return (this.discovering ??= this.chrome.call("Target.setDiscoverTargets", { discover: true }).then(() => {}));
  }

  onChange(f: () => void) {
    this.listeners.push(f);
  }

  tabs(): Tab[] {
    return [...this.targets.values()]
      .filter((t) => t.seen && t.folder && t.info.type === "page")
      .map((t) => ({ id: t.info.targetId, folder: t.folder!, url: t.info.url ?? "", title: t.info.title ?? "", ...(t.openedBy && { openedBy: t.openedBy }) }));
  }

  async createTab(folder: string, url: string, openedBy?: string): Promise<string> {
    const r = await this.chrome.call("Target.createTarget", { url });
    if (!r.result?.targetId) throw new Error(r.error?.message ?? "Chrome didn't open the tab");
    this.claim(r.result.targetId, folder, openedBy);
    return r.result.targetId;
  }

  // Chrome doesn't say when a page's own title comes in (targetInfoChanged carries the address as
  // the title), but Target.getTargets has it. Called every few seconds while Chrome runs.
  async refresh(): Promise<void> {
    const r = await this.chrome.call("Target.getTargets");
    let changed = false;
    for (const info of r.result?.targetInfos ?? []) {
      const t = this.targets.get(info.targetId);
      if (!t?.seen || (t.info.title === info.title && t.info.url === info.url)) continue;
      t.info = info;
      changed ||= !!t.folder;
    }
    if (changed) this.changed();
  }

  async closeTab(id: string): Promise<void> {
    await this.chrome.call("Target.closeTarget", { targetId: id });
  }

  connect(client: GateClient): { message(text: string): void; close(): void } {
    const c: Conn = { ...client, discover: false, autoAttach: false, sessions: new Set() };
    this.conns.add(c);
    return {
      message: (text) => {
        let m: CdpMessage;
        try {
          m = JSON.parse(text);
        } catch {
          return;
        }
        if (typeof m.id === "number" && typeof m.method === "string") this.fromClient(c, m);
      },
      close: () => {
        if (!this.conns.delete(c)) return;
        for (const s of c.sessions) {
          this.owners.delete(s);
          this.chrome.send({ id: this.next++, method: "Target.detachFromTarget", params: { sessionId: s } });
        }
      },
    };
  }

  // ---- helpers ----

  private changed() {
    this.listeners.forEach((f) => f());
  }

  private send(c: Conn, m: CdpMessage) {
    c.send(JSON.stringify(m));
  }

  private reply(c: Conn, m: CdpMessage, result: any) {
    this.send(c, { id: m.id, result, ...(m.sessionId && { sessionId: m.sessionId }) });
  }

  private fail(c: Conn, m: CdpMessage, message: string) {
    this.send(c, { id: m.id, error: { code: -32000, message }, ...(m.sessionId && { sessionId: m.sessionId }) });
  }

  private forward(c: Conn, m: CdpMessage, after?: (r: CdpMessage) => void) {
    const id = this.next++;
    this.pending.set(id, { conn: c, id: m.id, after });
    this.chrome.send({ ...m, id });
  }

  private visible(c: Conn, t: Target | undefined): t is Target {
    return !!t && t.seen && t.folder === c.folder && t.info.type === "page";
  }

  // Client c waits for its attachedToTarget, which Chrome sends before its answer. An attach
  // Chrome refuses (the tab just closed) takes c out of the line again, so the next attach to that
  // target isn't handed to it.
  private queueAttach(c: Conn, targetId: string) {
    this.attachFor.set(targetId, [...(this.attachFor.get(targetId) ?? []), c]);
    return (r: CdpMessage) => {
      if (!r.error) return;
      const rest = (this.attachFor.get(targetId) ?? []).filter((x) => x !== c);
      if (rest.length) this.attachFor.set(targetId, rest);
      else this.attachFor.delete(targetId);
    };
  }

  // The gate attaches client c to a target.
  private attach(c: Conn, targetId: string) {
    const done = this.queueAttach(c, targetId);
    return this.chrome.call("Target.attachToTarget", { targetId, flatten: true }).then(done);
  }

  // A target is now in `folder`: Chrome's targetCreated may have come before or after this.
  private claim(targetId: string, folder: string, openedBy?: string) {
    const t = this.targets.get(targetId) ?? { info: { targetId, type: "page" }, folder: null, seen: false, announced: false };
    t.folder = folder;
    t.openedBy = openedBy;
    this.targets.set(targetId, t);
    if (t.seen) this.announce(t);
  }

  // Tell the folder's clients of a target they can now see.
  private announce(t: Target) {
    if (t.announced || !t.seen || !t.folder || t.info.type !== "page") return;
    t.announced = true;
    for (const c of this.conns) {
      if (!this.visible(c, t)) continue;
      if (c.discover) this.send(c, { method: "Target.targetCreated", params: { targetInfo: t.info } });
      if (c.autoAttach) void this.attach(c, t.info.targetId);
    }
    this.changed();
  }

  // ---- from Chrome ----

  private fromChrome(m: CdpMessage) {
    if (m.id !== undefined) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      p.after?.(m);
      return this.send(p.conn, { ...m, id: p.id });
    }
    if (m.sessionId) {
      const c = this.owners.get(m.sessionId);
      if (!c) return;
      if (m.method === "Target.attachedToTarget") (this.owners.set(m.params.sessionId, c), c.sessions.add(m.params.sessionId));
      if (m.method === "Target.detachedFromTarget") (this.owners.delete(m.params.sessionId), c.sessions.delete(m.params.sessionId));
      return this.send(c, m);
    }
    switch (m.method) {
      case "Target.targetCreated": {
        const info = m.params.targetInfo;
        const opener = info.openerId ? this.targets.get(info.openerId) : undefined;
        const t = this.targets.get(info.targetId) ?? { info, folder: opener?.folder ?? null, openedBy: opener?.openedBy, seen: false, announced: false };
        t.info = info;
        t.seen = true;
        this.targets.set(info.targetId, t);
        return this.announce(t);
      }
      case "Target.targetInfoChanged": {
        const t = this.targets.get(m.params.targetInfo.targetId);
        if (!t) return;
        t.info = m.params.targetInfo;
        if (!t.folder) return;
        for (const c of this.conns) if (c.discover && this.visible(c, t)) this.send(c, m);
        return this.changed();
      }
      case "Target.targetDestroyed": {
        const t = this.targets.get(m.params.targetId);
        this.targets.delete(m.params.targetId);
        if (!t?.folder) return;
        for (const c of this.conns) if (c.discover && this.visible(c, t)) this.send(c, m);
        return this.changed();
      }
      case "Target.attachedToTarget": {
        const id = m.params.targetInfo.targetId;
        const waiting = this.attachFor.get(id) ?? [];
        const c = waiting.shift();
        if (!waiting.length) this.attachFor.delete(id);
        if (!c || !this.conns.has(c)) return;
        this.owners.set(m.params.sessionId, c);
        c.sessions.add(m.params.sessionId);
        // The gate never pauses targets, so nothing waits for the client to resume them.
        return this.send(c, { ...m, params: { ...m.params, waitingForDebugger: false } });
      }
      case "Target.detachedFromTarget": {
        const c = this.owners.get(m.params.sessionId);
        this.owners.delete(m.params.sessionId);
        if (!c) return;
        c.sessions.delete(m.params.sessionId);
        return this.send(c, m);
      }
    }
  }

  // ---- from a client ----

  private fromClient(c: Conn, m: CdpMessage) {
    if (m.sessionId) {
      if (!c.sessions.has(m.sessionId)) return this.fail(c, m, "Session with given id not found.");
      return this.forward(c, m);
    }
    const p = m.params ?? {};
    // Another folder's target is as good as no target.
    if (m.method?.startsWith("Target.") && typeof p.targetId === "string" && !this.visible(c, this.targets.get(p.targetId))) return this.fail(c, m, NO_TARGET);
    switch (m.method) {
      case "Target.setDiscoverTargets":
        c.discover = !!p.discover;
        if (c.discover) for (const t of this.targets.values()) if (this.visible(c, t)) this.send(c, { method: "Target.targetCreated", params: { targetInfo: t.info } });
        return this.reply(c, m, {});
      case "Target.setAutoAttach": {
        c.autoAttach = !!p.autoAttach;
        if (!c.autoAttach) return this.reply(c, m, {});
        const mine = [...this.targets.values()].filter((t) => this.visible(c, t));
        return void Promise.all(mine.map((t) => this.attach(c, t.info.targetId))).then(() => this.reply(c, m, {}));
      }
      case "Target.getTargets":
        return this.reply(c, m, { targetInfos: [...this.targets.values()].filter((t) => this.visible(c, t)).map((t) => t.info) });
      case "Target.createTarget":
        return this.forward(c, m, (r) => r.result?.targetId && this.claim(r.result.targetId, c.folder, c.session));
      case "Target.attachToTarget":
        return this.forward(c, m, this.queueAttach(c, p.targetId));
      case "Target.detachFromTarget":
        if (!c.sessions.has(p.sessionId)) return this.fail(c, m, "No session with given id");
        return this.forward(c, m);
      // The browser is everyone's: a client's close (Puppeteer's browser.close()) closes nothing.
      case "Browser.close":
        return this.reply(c, m, {});
      // A browser session would see every target, past the folder.
      case "Target.attachToBrowserTarget":
      case "Target.exposeDevToolsProtocol":
        return this.fail(c, m, "Not available here");
      default:
        return this.forward(c, m);
    }
  }
}
