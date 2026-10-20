// The events socket: the session list whenever it changes, the ports programs in sessions listen
// on (ports.ts), the server browser's tabs (browser/service.ts), and changes to the paths the app
// watches.

import { type FSWatcher, statSync, watch } from "node:fs";
import type { Server, ServerWebSocket } from "bun";
import { browserTabs } from "./browser/service";
import { guard } from "./files";
import { sessionPorts } from "./ports";
import { claudeDir, listSessions, parseZmxList, zmxListAsync } from "./sessions";

export type EventsData = {
  kind: "events";
  watches: Map<string, { real: string; ino: number; w: FSWatcher }>;
  changed: Set<string>;
  renamed: Set<string>;
  timer?: ReturnType<typeof setTimeout>;
};

export const eventsData = (): EventsData => ({ kind: "events", watches: new Map(), changed: new Set(), renamed: new Set() });

// One check per second for all sockets, and only while someone is listening.
let ticker: ReturnType<typeof setInterval> | undefined;
let listeners = 0;
let last = "";
let lastPorts = "";
let ticks = 0;
let checking = false;

const sessionsMessage = (zmx: string) => JSON.stringify({ type: "sessions", sessions: listSessions(claudeDir(), zmx) });
export const browserMessage = () => JSON.stringify({ type: "browser", tabs: browserTabs() });
const portsMessage = async (zmx: string) => JSON.stringify({ type: "ports", ports: await sessionPorts(parseZmxList(zmx)) });

async function tick(server: Server) {
  if (checking) return; // a slow zmx shouldn't pile up checks
  checking = true;
  try {
    const zmx = await zmxListAsync();
    const m = sessionsMessage(zmx);
    if (m !== last) server.publish("sessions", (last = m));
    // Ports every other second.
    if (ticks++ % 2 === 0) {
      const p = await portsMessage(zmx);
      if (p !== lastPorts) server.publish("sessions", (lastPorts = p));
    }
  } catch {
  } finally {
    checking = false;
  }
}

export async function openEvents(ws: ServerWebSocket<EventsData>, server: Server) {
  ws.subscribe("sessions");
  listeners++;
  ticker ??= setInterval(() => tick(server), 1000);
  try {
    const zmx = await zmxListAsync();
    ws.send(sessionsMessage(zmx));
    ws.send(await portsMessage(zmx));
  } catch {}
  ws.send(browserMessage());
}

const MAX_WATCHES = 2000;
const DEBOUNCE_MS = 150;

// Replaces this socket's watch set. Each path is watched on its own, not recursively.
export function eventsMessage(ws: ServerWebSocket<EventsData>, msg: string | Buffer) {
  if (typeof msg !== "string") return;
  let m: any;
  try {
    m = JSON.parse(msg);
  } catch {
    return;
  }
  if (m?.type !== "watch" || !Array.isArray(m.paths)) return;
  const d = ws.data;
  const want = new Set<string>(m.paths.filter((p: unknown) => typeof p === "string").slice(0, MAX_WATCHES));
  for (const [p, x] of d.watches)
    if (!want.has(p)) {
      x.w.close();
      d.watches.delete(p);
    }
  for (const p of want) if (!d.watches.has(p)) startWatch(ws, p);
}

function startWatch(ws: ServerWebSocket<EventsData>, path: string) {
  const d = ws.data;
  let real: string;
  try {
    real = guard(path); // paths outside home are ignored
    const ino = statSync(real).ino;
    const w = watch(real, { persistent: false }, (event) => {
      d.changed.add(path);
      if (event === "rename") d.renamed.add(path);
      d.timer ??= setTimeout(() => flush(ws), DEBOUNCE_MS);
    });
    w.on("error", () => {});
    d.watches.set(path, { real, ino, w });
  } catch {} // outside home, or doesn't exist
}

function flush(ws: ServerWebSocket<EventsData>) {
  const d = ws.data;
  d.timer = undefined;
  // A file saved by rename (most editors, and blimp itself) is a new inode the old watch can't see,
  // so watch the path again. A path that's gone stops being watched until the app sends it again.
  for (const p of d.renamed) {
    const x = d.watches.get(p);
    if (!x) continue;
    let ino = -1;
    try {
      ino = statSync(x.real).ino;
    } catch {}
    if (ino === x.ino) continue;
    x.w.close();
    d.watches.delete(p);
    if (ino !== -1) startWatch(ws, p);
  }
  d.renamed.clear();
  if (d.changed.size) ws.send(JSON.stringify({ type: "fs", paths: [...d.changed] }));
  d.changed.clear();
}

export function closeEvents(ws: ServerWebSocket<EventsData>) {
  const d = ws.data;
  for (const x of d.watches.values()) x.w.close();
  d.watches.clear();
  if (d.timer) clearTimeout(d.timer);
  if (--listeners === 0) {
    clearInterval(ticker);
    ticker = undefined;
    last = "";
    lastPorts = "";
  }
}
