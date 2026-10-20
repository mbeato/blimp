// The server browser in blimpd: one Chrome, started when something needs it (a session's MCP
// connecting, a tab opened from the app, or tabs saved from before), restarted the next time
// something needs it after it exits, with the saved tabs reopened. Sessions reach it through the
// gate's listener on 127.0.0.1: /s/<session>, for connections of blimpd's own uid only. The tabs
// (folder, address, who opened them) are saved in <blimp dir>/browser/tabs.json.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { HttpError } from "../files";
import { isSafeName, parseZmxList, realDir, zmxListAsync } from "../sessions";
import { findChrome, launchChrome, type Chrome } from "./chrome";
import { Gate, type Tab } from "./gate";
import { browserDir, mcpConfig, mcpConfigPath, portFile, selfCommand } from "./mcp";
import { peerUid } from "./peer";

export type { Tab };
type Saved = { folder: string; url: string; openedBy?: string };
type Ws = ServerWebSocket<{ folder: string; session: string; conn?: ReturnType<Gate["connect"]>; queue: string[] }>;

let chrome: Chrome | null = null;
let gate: Gate | null = null;
let starting: Promise<Gate> | null = null;
let refresher: ReturnType<typeof setInterval> | undefined;
let listener: Server | null = null;
const sockets = new Set<Ws>();
const listeners: ((tabs: Tab[]) => void)[] = [];
let saveTimer: ReturnType<typeof setTimeout> | undefined;

const tabsFile = () => join(browserDir(), "tabs.json");

function loadSaved(): Saved[] {
  try {
    const v = JSON.parse(readFileSync(tabsFile(), "utf8"));
    return Array.isArray(v) ? v.filter((t) => typeof t?.folder === "string" && typeof t?.url === "string") : [];
  } catch {
    return [];
  }
}

function save() {
  if (!gate) return;
  const tabs: Saved[] = gate.tabs().map((t) => ({ folder: t.folder, url: t.url, ...(t.openedBy && { openedBy: t.openedBy }) }));
  writeFileSync(tabsFile(), JSON.stringify(tabs, null, 2) + "\n", { mode: 0o600 });
}

function changed() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 500);
  const tabs = browserTabs();
  listeners.forEach((f) => f(tabs));
}

function ensureDir() {
  mkdirSync(join(browserDir(), "profile"), { recursive: true, mode: 0o700 });
  chmodSync(browserDir(), 0o700);
  chmodSync(join(browserDir(), "profile"), 0o700);
}

// Whether there's a Chrome to run (looked for at most every 30 s).
let found: { at: number; path: string | null } | undefined;
export function chromePath(): string | null {
  if (!found || Date.now() - found.at > 30_000) found = { at: Date.now(), path: findChrome() };
  return found.path;
}
export const browserAvailable = () => chromePath() !== null;

const NO_CHROME = "No Chrome or Chromium on the server. Install one: npx playwright install chromium";

// Chrome, and the gate on it. One that can't start (a missing library, say) exits at once; so
// does one started while the Chrome of a blimpd that just quit still holds the profile (it quits
// within seconds of losing its pipe), so that gets a second try.
async function launch(path: string, tries = 2): Promise<{ c: Chrome; g: Gate }> {
  const c = launchChrome(path, join(browserDir(), "profile"));
  const g = new Gate(c);
  const died = c.exited.then((code) => Promise.reject(new Error(`Chrome exited as it started (code ${code}). Run it by hand to see why: ${path} --headless=new`)));
  try {
    await Promise.race([g.ready(), died]);
  } catch (e) {
    c.kill();
    if (tries <= 1) throw e;
    await Bun.sleep(5000);
    return launch(path, tries - 1);
  }
  died.catch(() => {});
  return { c, g };
}

// The running gate, starting Chrome first if it isn't running.
export function ensureChrome(): Promise<Gate> {
  if (gate) return Promise.resolve(gate);
  starting ??= (async () => {
    const path = chromePath();
    if (!path) throw new Error(NO_CHROME);
    ensureDir();
    const restore = loadSaved();
    const { c, g } = await launch(path);
    for (const t of restore) await g.createTab(t.folder, t.url, t.openedBy).catch(() => {});
    g.onChange(changed);
    chrome = c;
    gate = g;
    refresher = setInterval(() => void g.refresh().catch(() => {}), 2000);
    c.exited.then(() => {
      if (chrome !== c) return;
      clearInterval(refresher);
      clearTimeout(saveTimer); // tabs.json keeps the tabs Chrome had, to reopen next time
      chrome = gate = null;
      for (const ws of sockets) ws.close(1012, "Browser restarted");
      changed();
    });
    changed();
    return g;
  })().finally(() => (starting = null));
  return starting;
}

export const browserTabs = (): Tab[] => gate?.tabs() ?? [];

export function onBrowserChange(f: (tabs: Tab[]) => void) {
  listeners.push(f);
}

export async function openTab(folder: string, url: string): Promise<string> {
  let g: Gate;
  try {
    g = await ensureChrome();
  } catch (e) {
    throw new HttpError(503, (e as Error).message);
  }
  return g.createTab(folder, url);
}

export async function closeTab(id: string): Promise<void> {
  if (!gate || !gate.tabs().some((t) => t.id === id)) throw new HttpError(404, "no such browser tab");
  await gate.closeTab(id);
}

// The gate's listener. It keeps the port it had last time if it's free, so sessions' MCPs from
// before a blimpd restart still find it. Writes the port file and the MCP config. Returns the port.
export async function startBrowserGate(): Promise<number> {
  ensureDir();
  let last = 0;
  try {
    last = Number(readFileSync(portFile(), "utf8").trim()) || 0;
  } catch {}
  const options = {
    hostname: "127.0.0.1",
    async fetch(req: Request, srv: Server) {
      const ip = srv.requestIP(req);
      if (!ip || peerUid(ip.address, ip.port) !== process.getuid!()) return new Response("not yours", { status: 403 });
      const m = new URL(req.url).pathname.match(/^\/s\/([^/]+)$/);
      const session = m ? decodeURIComponent(m[1]) : "";
      if (!isSafeName(session)) return new Response("not found", { status: 404 });
      const z = parseZmxList(await zmxListAsync()).find((s) => s.name === session);
      if (!z) return new Response(`no session named ${session}`, { status: 404 });
      if (srv.upgrade(req, { data: { folder: realDir(z.dir), session, queue: [] } })) return;
      return new Response("expected a WebSocket", { status: 400 });
    },
    websocket: {
      // Screenshots and heap snapshots are big.
      maxPayloadLength: 256 * 1024 * 1024,
      open(ws: Ws) {
        sockets.add(ws);
        ensureChrome().then(
          (g) => {
            if (!sockets.has(ws)) return;
            ws.data.conn = g.connect({ folder: ws.data.folder, session: ws.data.session, send: (t) => void ws.send(t) });
            for (const t of ws.data.queue.splice(0)) ws.data.conn.message(t);
          },
          (e) => ws.close(1011, String((e as Error).message).slice(0, 120)),
        );
      },
      message(ws: Ws, msg: string | Buffer) {
        const text = String(msg);
        if (ws.data.conn) ws.data.conn.message(text);
        else ws.data.queue.push(text);
      },
      close(ws: Ws) {
        sockets.delete(ws);
        ws.data.conn?.close();
      },
    },
  };
  try {
    listener = Bun.serve({ ...options, port: last });
  } catch {
    listener = Bun.serve({ ...options, port: 0 });
  }
  writeFileSync(portFile(), `${listener.port}\n`, { mode: 0o600 });
  writeFileSync(mcpConfigPath(), mcpConfig(selfCommand()), { mode: 0o600 });
  // Tabs from before: Chrome starts now, so they're there for the app and the sessions.
  if (loadSaved().length && browserAvailable()) ensureChrome().catch((e) => console.log(`browser: ${(e as Error).message}`));
  return listener.port!;
}

// Whether a session started now can get the browser: a Chrome to run and the MCP config written.
export const browserReady = () => browserAvailable() && existsSync(mcpConfigPath());

// For tests: Chrome and the listener stop; tabs.json stays.
export async function stopBrowser() {
  const c = chrome;
  listener?.stop(true);
  listener = null;
  c?.kill();
  await c?.exited;
}
