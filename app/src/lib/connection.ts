// How the UI reaches each blimpd.
// In the Mac app the Rust shell opens an SSH tunnel (invoke "connect") and keeps the server list
// in the store plugin. In a plain browser (development, e2e tests) the page URL carries
// ?blimpd=http://127.0.0.1:PORT&token=T instead, and the server list lives in localStorage.

import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Api, type BrowserTab, type Conn, type Port, type Session } from "./api";
import { EventsSocket } from "./events";

export type Server = { host: string; user?: string; port?: number };

export const inTauri = () => isTauri();

// user@host:port, leaving out what the user left blank. The same as the id the Rust shell gives
// the tunnel (Target::id in src-tauri/src/tunnel.rs), so it also names the tunnel to disconnect.
export const serverKey = (s: Server) => `${s.user ? s.user + "@" : ""}${s.host}${s.port ? ":" + s.port : ""}`;

const LS_KEY = "blimp.servers";

function browserTarget(): { base: string; token: string } | null {
  const q = new URLSearchParams(location.search);
  const base = q.get("blimpd");
  return base ? { base, token: q.get("token") ?? "" } : null;
}

export async function loadServers(): Promise<Server[]> {
  if (inTauri()) {
    const { load } = await import("@tauri-apps/plugin-store");
    const store = await load("servers.json");
    return (await store.get<Server[]>("servers")) ?? [];
  }
  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEY) ?? "null");
    if (Array.isArray(saved) && saved.length) return saved;
  } catch {}
  // A browser can only reach the blimpd in its URL, so that one is the default server.
  return browserTarget() ? [{ host: "localhost" }] : [];
}

export async function saveServers(list: Server[]) {
  if (inTauri()) {
    const { load } = await import("@tauri-apps/plugin-store");
    const store = await load("servers.json");
    await store.set("servers", list);
    await store.save();
    return;
  }
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(list));
  } catch {}
}

async function connectServer(s: Server): Promise<Conn> {
  let conn: Conn;
  if (inTauri()) {
    const r = await invoke<{ id: string; port: number; token: string; home: string }>("connect", {
      host: s.host,
      user: s.user,
      port: s.port,
    });
    conn = { id: r.id, base: `http://127.0.0.1:${r.port}`, token: r.token, home: "" };
  } else {
    const t = browserTarget();
    if (!t) throw new Error("A browser can't open SSH. Open blimp with ?blimpd=http://127.0.0.1:PORT&token=TOKEN.");
    conn = { id: serverKey(s), base: t.base, token: t.token, home: "" };
  }
  // blimpd's home has symlinks resolved, like the session folders it reports, so "~" matches
  // them. The shell's $HOME (what connect returns) may not.
  const { home, version } = await new Api(conn).health();
  return { ...conn, home, version };
}

// Retry after 1, 2, 5, 10 s, then every 10 s.
const BACKOFF = [1000, 2000, 5000, 10000];
export const backoff = (attempt: number) => BACKOFF[Math.min(attempt, BACKOFF.length - 1)];

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export type LinkStatus = "connecting" | "connected" | "offline";

const links = new Set<ServerLink>();
let serial = 0;
let tunnelListener: Promise<unknown> | null = null;

// The Rust shell says when an ssh child exits; the link that used it reconnects.
function listenForTunnels() {
  if (tunnelListener || !inTauri()) return;
  tunnelListener = listen<{ id: string }>("tunnel-closed", (e) => {
    for (const l of links) if (l.conn?.id === e.payload.id) l.retry("The SSH tunnel closed.");
  });
}

// After the Mac sleeps or changes networks, ssh can run on for up to a minute on a connection
// that is gone (ServerAlive in tunnel.rs), and connect reuses it while it runs. So on wake or a
// network change, every link checks its tunnel at once (ServerLink.check).
// Timers stop during sleep, so a long gap between ticks means the Mac just woke.
const TICK_MS = 2000;
// Long enough for a tunnel that survived to answer once Wi-Fi has rejoined, still far under
// ssh's own minute.
const PROBE_MS = 8000;
let wakeWatch = false;

function watchForWake() {
  if (wakeWatch || typeof window === "undefined") return;
  wakeWatch = true;
  const checkAll = () => links.forEach((l) => void l.check());
  let last = Date.now();
  setInterval(() => {
    if (Date.now() - last > TICK_MS + 5000) checkAll();
    last = Date.now();
  }, TICK_MS);
  window.addEventListener("online", checkAll);
}

// One server: its tunnel, its events socket and its session list, kept alive with retries.
export class ServerLink {
  // A server removed and added again gets a new link with the same key; this tells them apart.
  readonly id = ++serial;
  status: LinkStatus = "connecting";
  error = "";
  sessions: Session[] | null = null; // null until the first list arrives
  ports: Port[] = [];
  portsKnown = false; // the first port list has arrived
  browserTabs: BrowserTab[] = [];
  conn: Conn | null = null;
  api: Api | null = null;
  private events: EventsSocket | null = null;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private checking = false;
  private watching = new Map<number, string[]>();
  private fsListeners = new Set<(paths: string[]) => void>();

  constructor(
    public server: Server,
    private onChange: (link: ServerLink) => void,
  ) {
    links.add(this);
    listenForTunnels();
    watchForWake();
  }

  get key() {
    return serverKey(this.server);
  }

  get home() {
    return this.conn?.home ?? "";
  }

  // blimpd's version on this server, once connected.
  get version() {
    return this.conn?.version ?? "";
  }

  start() {
    void this.open();
  }

  private async open() {
    this.timer = undefined;
    this.set("connecting");
    try {
      const conn = await connectServer(this.server);
      // stop() may have run before the Rust side knew about this connect; close what it opened.
      if (this.stopped) return this.disconnect();
      this.conn = conn;
      this.api = new Api(conn);
      // A retry can start another open while one is still connecting; keep one socket.
      this.events?.close();
      this.events = new EventsSocket(this.api, {
        onSessions: (s) => {
          this.sessions = s;
          this.attempt = 0;
          this.error = "";
          this.set("connected");
        },
        onPorts: (p) => {
          this.ports = p;
          this.portsKnown = true;
          this.onChange(this);
        },
        onBrowser: (tabs) => {
          this.browserTabs = tabs;
          this.onChange(this);
        },
        onFs: (paths) => this.fsListeners.forEach((f) => f(paths)),
        onClose: () => this.retry("Lost the connection to blimpd."),
      });
      this.events.watch(this.watched());
    } catch (e) {
      this.retry(errorText(e));
    }
  }

  retry(error: string) {
    if (this.stopped || this.timer) return;
    this.events?.close();
    this.events = null;
    this.error = error;
    this.set("offline");
    this.timer = setTimeout(() => void this.open(), backoff(this.attempt++));
  }

  retryNow() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.attempt = 0;
    this.events?.close();
    this.events = null;
    void this.open();
  }

  // The Mac woke or its network changed. A link whose tunnel blimpd doesn't answer through in
  // time gets a new tunnel; an offline one also stops waiting out its backoff. One still
  // connecting, or already checking (a wake and an "online" can come together), is left alone.
  async check() {
    if (this.stopped || this.checking || this.status === "connecting") return;
    // Offline now: the "online" event checks again once the network is back.
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    const { api, conn } = this;
    if (!api || !conn) {
      if (this.status === "offline") this.retryNow();
      return;
    }
    this.checking = true;
    try {
      const alive = await Promise.race([
        api.health().then(() => true, () => false),
        new Promise<boolean>((r) => setTimeout(() => r(false), PROBE_MS)),
      ]);
      // Something else reconnected the link meanwhile.
      const moved = () => this.stopped || this.api !== api || (this.status as LinkStatus) === "connecting";
      if (moved()) return;
      if (alive) {
        if (this.status === "offline") this.retryNow();
        return;
      }
      // Stop the dead ssh first, or connect would hand back the same tunnel. Only the one this
      // link used: another window may already have replaced it, and that one stays.
      if (inTauri()) await invoke("drop_tunnel", { id: conn.id, port: Number(new URL(conn.base).port) }).catch(() => {});
      if (moved()) return;
      this.retryNow();
    } finally {
      this.checking = false;
    }
  }

  // Also during a connect: disconnect cancels a tunnel that is still starting.
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.events?.close();
    links.delete(this);
    this.disconnect();
  }

  private disconnect() {
    if (inTauri()) invoke("disconnect", { id: this.key }).catch(() => {});
  }

  // Each workbench's watch set (expanded folders + open files), by workbench; blimpd watches them
  // all, since every tab on this server shares the one events socket. Kept here so it survives
  // reconnects. An empty list removes the workbench's set.
  watch(owner: number, paths: string[]) {
    if (paths.length) this.watching.set(owner, paths);
    else this.watching.delete(owner);
    this.events?.watch(this.watched());
  }

  private watched() {
    return [...new Set([...this.watching.values()].flat())];
  }

  onFs(fn: (paths: string[]) => void) {
    this.fsListeners.add(fn);
    return () => void this.fsListeners.delete(fn);
  }

  private set(status: LinkStatus) {
    this.status = status;
    this.onChange(this);
  }
}
