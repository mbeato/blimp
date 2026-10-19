// The chat socket (docs/DESIGN.md, Chat): a session's conversation as messages, and a way to type
// into it, for the phone. Each socket keeps one zmx client attached while it's open, at the size
// the session is shown at elsewhere: a client per message, or one of another size, upsets Claude's
// screen (the probe in the phone spec).

import type { ServerWebSocket, Subprocess } from "bun";
import { type ChatMessage, type ChatScan, mergeById, newScan, readAppended } from "./chat";
import { answerKeys } from "./prompt";
import { existsSync } from "node:fs";
import { claudeDir, listSessions, type Session, sessionExists, transcriptPath, zmxEnv, zmxListAsync, zmxPath } from "./sessions";
import { followSize, lastSize } from "./terminal";

export type ChatData = {
  kind: "chat";
  name: string;
  closed?: boolean;
  session?: Session;
  file?: string;
  scan?: ChatScan;
  proc?: Subprocess;
  unfollow?: () => void;
  timer?: ReturnType<typeof setInterval>;
  ticks: number;
  busy?: boolean;
  opened?: Promise<void>;
  queue?: Promise<unknown>; // writes to the zmx client, one at a time
};

export const chatData = (name: string): ChatData => ({ kind: "chat", name, ticks: 0 });

const HISTORY = 200;
const seen = new Map<string, string[]>(); // session -> last 100 input ids, across sockets

const send = (ws: ServerWebSocket<ChatData>, m: object) => ws.data.closed || ws.send(JSON.stringify(m));

async function find(name: string): Promise<Session | undefined> {
  return listSessions(claudeDir(), await zmxListAsync()).find((s) => s.name === name);
}

// The current conversation from the start: the last 200 messages.
function loadHistory(ws: ServerWebSocket<ChatData>) {
  const d = ws.data;
  const s = d.session!;
  d.file = s.sessionId ? transcriptPath(claudeDir(), s.sessionId) : undefined;
  if (!d.file) {
    d.scan = undefined;
    return send(ws, { type: "unreadable" });
  }
  d.scan = newScan(s.dir);
  try {
    const all = mergeById([], readAppended(d.file, d.scan));
    send(ws, { type: "history", messages: all.slice(-HISTORY) });
  } catch {
    d.scan = undefined;
    send(ws, { type: "unreadable" });
  }
}

// Every 250 ms: new transcript lines. Every 4th: is the session still there, still the same conversation?
async function tick(ws: ServerWebSocket<ChatData>) {
  const d = ws.data;
  if (d.busy || d.closed) return;
  d.busy = true;
  try {
    if (d.ticks++ % 4 === 0) {
      const s = await find(d.name);
      if (d.closed) return;
      if (!s) {
        d.closed = true;
        seen.delete(d.name);
        return ws.close(4000, "ended");
      }
      const changed = s.sessionId !== d.session?.sessionId;
      d.session = s;
      if (changed) {
        send(ws, { type: "reset" });
        loadHistory(ws);
      } else if (s.sessionId && !d.scan && existsSync(transcriptPath(claudeDir(), s.sessionId))) {
        loadHistory(ws); // the transcript wasn't there yet when the socket opened
      }
    }
    if (d.file && d.scan) {
      const add: ChatMessage[] = readAppended(d.file, d.scan);
      if (add.length) send(ws, { type: "append", messages: add });
    }
  } catch {
  } finally {
    d.busy = false;
  }
}

export function openChat(ws: ServerWebSocket<ChatData>) {
  return (ws.data.opened = start(ws));
}

async function start(ws: ServerWebSocket<ChatData>) {
  const d = ws.data;
  d.session = await find(d.name);
  if (d.closed) return;
  if (!d.session) {
    d.closed = true;
    return ws.close(4000, "ended");
  }
  if (d.session.sessionId) loadHistory(ws);
  else send(ws, { type: "unreadable" });
  d.timer = setInterval(() => tick(ws), 250);
}

// The zmx client is started on the first input, not on open: a phone that only reads adds no client.
function client(ws: ServerWebSocket<ChatData>) {
  const d = ws.data;
  if (d.proc && d.proc.exitCode === null) return d.proc;
  const { cols, rows } = lastSize(d.name);
  d.proc = Bun.spawn([zmxPath(), "attach", d.name], {
    env: { ...zmxEnv(), TERM: "xterm-256color", COLORTERM: "truecolor" },
    terminal: { cols, rows, data() {} }, // its output is the same screen the viewers see; nobody needs it here
  });
  d.unfollow?.();
  d.unfollow = followSize(d.name, (c, r) => {
    try {
      d.proc?.terminal?.resize(c, r);
    } catch {} // the client's terminal may already be closed
  });
  return d.proc;
}

// Typing too soon after the client attaches can land before zmx has connected it.
async function write(ws: ServerWebSocket<ChatData>, parts: string[]) {
  const d = ws.data;
  if (d.closed) throw new Error("the socket is closed");
  const fresh = !d.proc || d.proc.exitCode !== null;
  if (fresh) {
    // `zmx attach` would create a session that has ended, and the text would go to a bare shell.
    const alive = await sessionExists(d.name).catch(() => false);
    if (d.closed) throw new Error("the socket is closed");
    if (!alive) throw new Error("the session ended");
  }
  const term = client(ws).terminal!;
  if (fresh) await Bun.sleep(150);
  // zmx 0.5 drops an Esc that is a new client's first input; an empty paste passes and the TUI ignores it.
  if (fresh && parts[0].startsWith("\x1b") && !parts[0].startsWith("\x1b[200~")) {
    term.write("\x1b[200~\x1b[201~");
    await Bun.sleep(50);
  }
  for (const [i, p] of parts.entries()) {
    if (i) await Bun.sleep(50); // Enter apart from the paste, as a person would press it
    term.write(p);
  }
}

// One typed thing at a time, so two inputs close together don't interleave. A repeated id is typed
// once: the phone resends what it didn't see acknowledged.
async function typed(ws: ServerWebSocket<ChatData>, id: string, parts: string[]) {
  const d = ws.data;
  const step = (d.queue ?? Promise.resolve()).then(async () => {
    const ids = seen.get(d.name) ?? [];
    if (ids.includes(id)) return;
    await write(ws, parts);
    seen.set(d.name, [...(seen.get(d.name) ?? []), id].slice(-100));
  });
  d.queue = step.catch(() => {});
  await step;
}

export async function chatMessage(ws: ServerWebSocket<ChatData>, msg: string | Buffer) {
  if (typeof msg !== "string") return;
  let m: any;
  try {
    m = JSON.parse(msg);
  } catch {
    return;
  }
  const id = m?.id;
  if (typeof id !== "string" || !id || id.length > 100) return;
  const fail = (error: string) => send(ws, { type: "error", id, error });
  const d = ws.data;
  await d.opened;
  if (!d.session?.sessionId) return fail("open this session on the Mac");
  if (m.type !== "input" && (seen.get(d.name) ?? []).includes(id)) return send(ws, { type: "ack", id });
  try {
    if (m.type === "input") {
      if (typeof m.text !== "string" || m.text.length > 100_000) return fail("text must be a string of at most 100 000 characters");
      // No ESC from the phone: it would end the paste early and turn the rest into key presses.
      await typed(ws, id, ["\x1b[200~" + m.text.replaceAll("\x1b", "") + "\x1b[201~", "\r"]);
      return send(ws, { type: "ack", id });
    }
    if (m.type === "answer") {
      const s = await find(d.name);
      const keys = s?.state === "waiting" && s.prompt && s.prompt.at === m.at ? answerKeys(s.prompt, m.pick) : undefined;
      if (!keys) return fail("the question changed");
      await typed(ws, id, [keys]);
      return send(ws, { type: "ack", id });
    }
    if (m.type === "interrupt") {
      await typed(ws, id, ["\x1b"]);
      return send(ws, { type: "ack", id });
    }
    fail("unknown message");
  } catch (e) {
    fail((e as Error).message);
  }
}

export function closeChat(ws: ServerWebSocket<ChatData>) {
  const d = ws.data;
  d.closed = true;
  clearInterval(d.timer);
  d.unfollow?.();
  d.proc?.kill("SIGTERM");
  d.proc?.exited.then(() => d.proc?.terminal?.close());
}
