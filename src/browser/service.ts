// The server browser in blimpd: one Chrome, started when something needs it (a session's MCP
// connecting, a tab opened or woken from the app, or saved tabs used within the hour), started
// again a few seconds after it dies (or, if it died a minute before too, when something next needs
// it), with the saved tabs reopened. Sessions reach it through the
// gate's listener on 127.0.0.1: /s/<session>, for connections of blimpd's own uid only. A tab
// nobody has used for an hour sleeps: closed in Chrome, still in the list, opened again when the
// app wakes it. The tabs (folder, address, who opened them, when they were used and first made,
// and which sleep) are saved in <blimp dir>/browser/tabs.json.

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { HttpError } from "../files";
import { isSafeName, parseZmxList, realDir, zmxListAsync } from "../sessions";
import { chromeHint, findChrome, launchChrome, type Chrome } from "./chrome";
import { Gate, type Tab } from "./gate";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { browserDir, gateKey, portFile, writeMcpConfig } from "./mcp";
import { keepPasskeyDialogsOff } from "./passkeys";
import { macPeerUid, peerUid } from "./peer";
import { openView, type ViewSocket } from "./view";

export type { Tab };
type Saved = { folder: string; url: string; openedBy?: string; usedAt?: number; madeAt?: number; id?: string; title?: string; asleep?: boolean };
type Row = Saved & { madeAt: number };
type Ws = ServerWebSocket<{ folder: string; session: string; conn?: ReturnType<Gate["connect"]>; queue: string[] }>;

let chrome: Chrome | null = null;
let gate: Gate | null = null;
let starting: Promise<Gate> | null = null;
let refresher: ReturnType<typeof setInterval> | undefined;
let listener: Server | null = null;
let stopped = false; // stopBrowser: Chrome isn't to come back by itself
let lastRestart = 0; // when a Chrome that died by itself was last started again
const sockets = new Set<Ws>();
const listeners: ((tabs: Tab[]) => void)[] = [];
let saveTimer: ReturnType<typeof setTimeout> | undefined;
// A tab nobody has used for this long sleeps (docs/superpowers/specs/2026-11-23-sleeping-tabs-design.md).
export const SLEEP_AFTER = 60 * 60_000;
// The sleeping tabs, by the id each had awake: closed in Chrome, still in the list.
const asleep = new Map<string, { tab: Tab; madeAt: number }>();
// The saved awake tabs, while Chrome isn't running: what it opens when it next starts.
let toOpen: Row[] = [];
let loaded = false;
const viewing = new Map<string, number>(); // tab id → its open views
const waking = new Map<string, Promise<string>>(); // sleeping tab id → its wake under way
let sleeper: ReturnType<typeof setInterval> | undefined;

const tabsFile = () => join(browserDir(), "tabs.json");

function loadSaved(): Saved[] {
  try {
    const v = JSON.parse(readFileSync(tabsFile(), "utf8"));
    return Array.isArray(v) ? v.filter((t) => typeof t?.folder === "string" && typeof t?.url === "string") : [];
  } catch {
    return [];
  }
}

// The file's rows, in its order. Rows from before tabs slept have no madeAt: they keep the file's
// order, before any tab made from now on.
function savedRows(): Row[] {
  const saved = loadSaved();
  const base = Date.now() - saved.length;
  return saved.map((t, i) => ({ ...t, madeAt: t.madeAt ?? base + i }));
}
const awakeRows = () => savedRows().filter((t) => !t.asleep);

const putAsleep = (t: Row) => {
  const id = t.id ?? `asleep-${randomUUID()}`;
  asleep.set(id, { tab: { id, folder: t.folder, url: t.url, title: t.title ?? "", ...(t.openedBy && { openedBy: t.openedBy }), asleep: true }, madeAt: t.madeAt });
};

// Saved tabs nobody used within the limit (or from before tabs slept: no usedAt) don't open: they sleep.
function settle(now = Date.now()) {
  const stale = toOpen.filter((t) => !(now - (t.usedAt ?? 0) <= SLEEP_AFTER));
  if (!stale.length) return;
  toOpen = toOpen.filter((t) => !stale.includes(t));
  stale.forEach(putAsleep);
  save();
}

// The file, once per start.
function load() {
  loaded = true;
  const all = savedRows();
  all.filter((t) => t.asleep).forEach(putAsleep);
  toOpen = all.filter((t) => !t.asleep);
  settle();
}

// Every tab, oldest first: the awake ones with their times, and the sleeping ones. With Chrome not
// running, the file's awake rows.
function rows(): Row[] {
  const g = gate;
  const awake: Row[] = g
    ? g.tabs().filter((t) => !asleep.has(t.id)).map((t) => ({ folder: t.folder, url: t.url, ...(t.openedBy && { openedBy: t.openedBy }), ...g.times(t.id)! }))
    : toOpen;
  const slept: Row[] = [...asleep.values()].map(({ tab, madeAt }) => ({ id: tab.id, folder: tab.folder, url: tab.url, title: tab.title, ...(tab.openedBy && { openedBy: tab.openedBy }), madeAt, asleep: true }));
  return [...awake, ...slept].sort((a, b) => a.madeAt - b.madeAt);
}

function save() {
  if (!loaded) return; // nothing read yet, so nothing to write: a write now would empty the file
  try {
    writeFileSync(tabsFile(), JSON.stringify(rows(), null, 2) + "\n", { mode: 0o600 });
  } catch (e) {
    console.log(`browser: couldn't save the tabs: ${(e as Error).message}`); // from a timer: never thrown
  }
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

const NO_CHROME = `No Chrome or Chromium on the server. Install one: ${chromeHint()}`;

// Chrome, and the gate on it. One that can't start (a missing library, say) exits at once; so
// does one started while the Chrome of a blimpd that just quit still holds the profile (it quits
// within seconds of losing its pipe), so that gets a second try.
async function launch(path: string, tries = 2): Promise<{ c: Chrome; g: Gate }> {
  const c = launchChrome(path, join(browserDir(), "profile"));
  const g = new Gate(c);
  keepPasskeyDialogsOff(c, (t) => g.attachDirect(t));
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
    if (!loaded) load();
    settle();
    const restore = toOpen;
    const { c, g } = await launch(path);
    chrome = c;
    // Watched from now on: a Chrome that dies while the tabs reopen ends the start, not hangs it.
    let dead = false;
    c.exited.then(() => {
      dead = true;
      if (chrome !== c) return;
      clearInterval(refresher);
      clearInterval(sleeper);
      clearTimeout(saveTimer); // tabs.json keeps the tabs Chrome had, to reopen next time
      toOpen = awakeRows(); // the file has what Chrome had
      chrome = gate = null;
      for (const ws of sockets) ws.close(1012, "Browser restarted");
      changed();
      // Died by itself (a crash, or killed): back with its tabs in a few seconds. Not again within
      // a minute, so a Chrome that keeps dying waits for something to need it.
      if (stopped || Date.now() - lastRestart < 60_000) return;
      lastRestart = Date.now();
      setTimeout(() => void ensureChrome().catch((e) => console.log(`browser: ${(e as Error).message}`)), 5000);
    });
    for (const t of restore) {
      if (dead) break;
      await g.createTab(t.folder, t.url, t.openedBy, { usedAt: t.usedAt, madeAt: t.madeAt }).catch(() => {});
    }
    if (dead) throw new Error("Chrome exited as it started");
    g.onChange(changed);
    gate = g;
    toOpen = [];
    refresher = setInterval(() => void g.refresh().catch(() => {}), 2000);
    sleeper = setInterval(() => void sleepIdleTabs().then(save).catch(() => {}), 60_000);
    changed();
    return g;
  })().finally(() => (starting = null));
  return starting;
}

// The live tabs and the sleeping ones, oldest first.
export function browserTabs(): Tab[] {
  const g = gate;
  const live = g ? g.tabs().filter((t) => !asleep.has(t.id)).map((t) => ({ tab: t, madeAt: g.times(t.id)?.madeAt ?? 0 })) : [];
  return [...live, ...asleep.values()].sort((a, b) => a.madeAt - b.madeAt).map((x) => x.tab);
}

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
  if (asleep.delete(id)) return changed();
  if (!gate || !gate.tabs().some((t) => t.id === id)) throw new HttpError(404, "no such browser tab");
  await gate.closeTab(id);
}

export const hasTab = (id: string) => browserTabs().some((t) => t.id === id && !t.asleep);

// Every tab with no view open that nobody has used for `after` goes to sleep: closed in Chrome,
// kept in the list. Saved before the close, so a blimpd that stops between the two doesn't open
// the tab again.
export async function sleepIdleTabs(now = Date.now(), after = SLEEP_AFTER): Promise<void> {
  const g = gate;
  if (!g) return;
  const idle = g.tabs().filter((t) => !viewing.has(t.id) && !asleep.has(t.id) && now - (g.times(t.id)?.usedAt ?? now) > after);
  if (!idle.length) return;
  for (const t of idle) asleep.set(t.id, { tab: { ...t, asleep: true }, madeAt: g.times(t.id)!.madeAt });
  save();
  await Promise.all(idle.map((t) => g.closeTab(t.id).catch(() => {})));
  changed();
}

// A sleeping tab opens again at its address, in its folder and at its place in the list. The new
// tab's id (Chrome's). Two wakes of one tab at once get the same answer.
export function wakeTab(id: string): Promise<string> {
  const going = waking.get(id);
  if (going) return going;
  if (!asleep.has(id)) return Promise.reject(new HttpError(404, "no such sleeping tab"));
  const p = (async () => {
    let g: Gate;
    try {
      g = await ensureChrome();
    } catch (e) {
      throw new HttpError(503, (e as Error).message);
    }
    const s = asleep.get(id);
    if (!s) throw new HttpError(404, "no such sleeping tab"); // closed meanwhile
    asleep.delete(id);
    try {
      const made = await g.createTab(s.tab.folder, s.tab.url, s.tab.openedBy, { madeAt: s.madeAt });
      save(); // at once: the file no longer says it sleeps, so a Chrome that dies now reopens it
      return made;
    } catch (e) {
      asleep.set(id, s);
      changed();
      throw new HttpError(503, (e as Error).message);
    }
  })().finally(() => waking.delete(id));
  waking.set(id, p);
  return p;
}

// A live view of tab `id` for the app (view.ts). It counts the view and touches the tab as it opens
// and closes.
export async function viewTab(id: string, sock: ViewSocket) {
  const g = gate;
  if (!chrome || !g?.tabs().some((t) => t.id === id) || asleep.has(id)) throw new Error("That browser tab is closed.");
  // A tab with a view open doesn't sleep; the hour starts when the last view closes.
  viewing.set(id, (viewing.get(id) ?? 0) + 1);
  let left = false;
  const leave = () => {
    if (left) return;
    left = true;
    const n = (viewing.get(id) ?? 1) - 1;
    if (n) viewing.set(id, n);
    else viewing.delete(id);
    g.touch(id);
  };
  try {
    const v = await openView(chrome, (t) => g.attachDirect(t), id, sock);
    return { message: v.message, close: () => (leave(), v.close()) };
  } catch (e) {
    leave();
    throw e;
  }
}

// The gate's listener. It keeps the port it had last time if it's free, so sessions' MCPs from
// before a blimpd restart still find it. Writes the port file and the MCP config. Returns the port.
export async function startBrowserGate(): Promise<number> {
  stopped = false;
  ensureDir();
  let last = 0;
  try {
    last = Number(readFileSync(portFile(), "utf8").trim()) || 0;
  } catch {}
  const key = Buffer.from(gateKey());
  const options = {
    hostname: "127.0.0.1",
    async fetch(req: Request, srv: Server) {
      // Your own process (the uid), not a web page (pages send Origin; DNS rebinding changes
      // Host), and one that could read the key file. On macOS the uid check runs lsof, so it comes
      // last there: a page, or a caller without the key, can't make blimpd start one.
      const ip = srv.requestIP(req);
      const mac = process.platform === "darwin";
      if (!mac && (!ip || peerUid(ip.address, ip.port) !== process.getuid!())) return new Response("not yours", { status: 403 });
      if (req.headers.has("origin") || req.headers.get("host") !== `127.0.0.1:${srv.port}`) return new Response("not from a page", { status: 403 });
      const url = new URL(req.url);
      const given = Buffer.from(url.searchParams.get("key") ?? "");
      if (given.length !== key.length || !timingSafeEqual(given, key)) return new Response("wrong key", { status: 403 });
      if (mac && (!ip || (await macPeerUid(ip.address, ip.port, srv.port!)) !== process.getuid!())) return new Response("not yours", { status: 403 });
      const m = url.pathname.match(/^\/s\/([^/]+)$/);
      let session = "";
      try {
        session = m ? decodeURIComponent(m[1]) : "";
      } catch {}
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
  writeMcpConfig(true);
  // Tabs from before used within the hour: Chrome starts now, so they're there for the app and the
  // sessions. The others sleep.
  load();
  if (toOpen.length && browserAvailable()) ensureChrome().catch((e) => console.log(`browser: ${(e as Error).message}`));
  return listener.port!;
}

// Whether a session started now can get the browser: a Chrome to run and the gate listening.
export const browserReady = () => browserAvailable() && listener !== null;

// For tests: Chrome and the listener stop; tabs.json stays.
export async function stopBrowser() {
  stopped = true;
  const c = chrome;
  listener?.stop(true);
  listener = null;
  c?.kill();
  await c?.exited;
  // Reset for the next start. Chrome's exit schedules a save; one after the reset would write an empty list.
  clearTimeout(saveTimer);
  asleep.clear();
  toOpen = [];
  loaded = false;
  viewing.clear();
}
