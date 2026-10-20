// The chat socket (docs/DESIGN.md, Chat): a session's conversation as messages, and a way to type
// into it, for the phone. Each socket keeps one zmx client attached while it's open, at the size
// the session is shown at elsewhere: a client per message, or one of another size, upsets Claude's
// screen (the probe in the phone spec).

import type { ServerWebSocket, Subprocess } from "bun";
import { type ChatMessage, type ChatScan, newScan, readAppended, readLast } from "./chat";
import { answerKeys, choiceLabel } from "./prompt";
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
  fresh?: boolean; // sent an empty history: the transcript isn't there yet, and all of it goes out as append
  proc?: Subprocess;
  ready?: Promise<void>; // the zmx client's first output: zmx has attached it
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
const typing = new Map<string, Promise<void>>(); // session + id -> its write in progress, across sockets

const send = (ws: ServerWebSocket<ChatData>, m: object) => ws.data.closed || ws.send(JSON.stringify(m));

async function find(name: string): Promise<Session | undefined> {
  return listSessions(claudeDir(), await zmxListAsync()).find((s) => s.name === name);
}

// The current conversation from the start: the last 200 messages.
async function loadHistory(ws: ServerWebSocket<ChatData>) {
  const d = ws.data;
  const s = d.session!;
  d.file = s.sessionId ? transcriptPath(claudeDir(), s.sessionId) : undefined;
  d.scan = undefined;
  d.fresh = false;
  if (!d.file) {
    if (!s.sessionId) return send(ws, { type: "unreadable" });
    // A new session has no transcript until its first message: an empty chat, then tick appends.
    d.fresh = true;
    return send(ws, { type: "history", messages: [] });
  }
  d.scan = newScan(s.dir);
  try {
    send(ws, { type: "history", messages: await readLast(d.file, d.scan, HISTORY, undefined, () => !!d.closed) });
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
        await loadHistory(ws);
      } else if (s.sessionId && !d.scan) {
        const file = transcriptPath(claudeDir(), s.sessionId);
        if (file && d.fresh) {
          d.file = file; // the first message was written: all of it is new
          d.scan = newScan(s.dir);
          d.fresh = false;
        } else if (file && existsSync(file)) await loadHistory(ws); // it wasn't readable when the socket opened
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

// Never rejects: Bun exits on an unhandled rejection from a WebSocket handler.
export function openChat(ws: ServerWebSocket<ChatData>) {
  return (ws.data.opened = start(ws).catch(() => {}));
}

async function start(ws: ServerWebSocket<ChatData>) {
  const d = ws.data;
  try {
    d.session = await find(d.name);
    if (d.closed) return;
    if (!d.session) {
      d.closed = true;
      return ws.close(4000, "ended");
    }
    if (d.session.sessionId) await loadHistory(ws);
    else send(ws, { type: "unreadable" });
    if (d.closed) return; // closed while the history was read
    d.timer = setInterval(() => tick(ws), 250);
  } catch {
    // zmx missing or refused, the transcript folder changing under us…
    if (d.closed) return;
    d.closed = true;
    ws.close(1011, "couldn't read the session");
  }
}

// The zmx client is started on the first input, not on open: a phone that only reads adds no client.
function client(ws: ServerWebSocket<ChatData>) {
  const d = ws.data;
  if (d.proc && d.proc.exitCode === null) return d.proc;
  const { cols, rows } = lastSize(d.name);
  let ready!: () => void;
  d.ready = new Promise<void>((r) => (ready = r));
  const proc = (d.proc = Bun.spawn([zmxPath(), "attach", d.name], {
    env: { ...zmxEnv(), TERM: "xterm-256color", COLORTERM: "truecolor" },
    // Its output is the same screen the viewers see, so nobody needs it here. zmx draws that screen
    // as it attaches the client: the first output says input will reach the session.
    terminal: { cols, rows, data: () => ready() },
  }));
  proc.exited.then(() => proc.terminal?.close()); // killed, or ended on its own (the next input starts another)
  d.unfollow?.();
  d.unfollow = followSize(d.name, (c, r) => {
    try {
      d.proc?.terminal?.resize(c, r);
    } catch {} // the client's terminal may already be closed
  });
  return d.proc;
}

// keys says what to type when its turn comes (an answer checks its question is still up); recheck
// runs again before each part after the first (input's Enter). Once started, a write finishes even
// if the socket closes: closeChat waits for it.
async function write(ws: ServerWebSocket<ChatData>, keys: () => Promise<string[]>, recheck?: () => Promise<void>) {
  const d = ws.data;
  if (d.closed) throw new Error("the socket is closed");
  const fresh = !d.proc || d.proc.exitCode !== null;
  if (fresh) {
    // `zmx attach` would create a session that has ended, and the text would go to a bare shell.
    const alive = await sessionExists(d.name).catch(() => false);
    if (!alive) throw new Error("the session ended");
  }
  const parts = await keys();
  const term = client(ws).terminal!;
  // Typing too soon after the client starts can land before zmx has attached it.
  if (fresh) await Promise.race([d.ready, Bun.sleep(1000)]);
  // zmx 0.5 drops an Esc that is a new client's first input; an empty paste passes and the TUI ignores it.
  if (fresh && parts[0].startsWith("\x1b") && !parts[0].startsWith("\x1b[200~")) {
    term.write("\x1b[200~\x1b[201~");
    await Bun.sleep(50);
  }
  for (const [i, p] of parts.entries()) {
    if (i) {
      await Bun.sleep(50); // Enter apart from the paste, as a person would press it
      await recheck?.();
    }
    term.write(p);
  }
}

// One typed thing at a time, so two inputs close together don't interleave. A repeated id is typed
// once: the phone resends what it didn't see acknowledged, maybe on a new socket while the old one
// is still typing it (then it waits for that one).
async function typed(ws: ServerWebSocket<ChatData>, id: string, keys: () => Promise<string[]>, recheck?: () => Promise<void>) {
  const d = ws.data;
  const key = `${d.name}\0${id}`;
  const step = (d.queue ?? Promise.resolve()).then(async () => {
    if ((seen.get(d.name) ?? []).includes(id)) return;
    const other = typing.get(key);
    if (other) return other;
    const p = write(ws, keys, recheck).then(() => void seen.set(d.name, [...(seen.get(d.name) ?? []), id].slice(-100)));
    typing.set(key, p);
    try {
      await p;
    } finally {
      typing.delete(key);
    }
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
  try {
    await d.opened;
    if (!d.session?.sessionId) return fail("open this session on the Mac");
    if (m.type !== "input" && (seen.get(d.name) ?? []).includes(id)) return send(ws, { type: "ack", id });
    if (m.type === "input") {
      if (typeof m.text !== "string" || m.text.length > 100_000) return fail("text must be a string of at most 100 000 characters");
      // No control characters from the phone: ESC would end the paste early and turn the rest into key
      // presses, ctrl+\ detaches zmx's client, ctrl+C interrupts. Newlines and tabs stay; \r is a newline.
      const text = m.text.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
      // Not while Claude asks something: the Enter after the paste would confirm its highlighted choice.
      // Checked before the paste and again before Enter. A question that starts in between leaves the
      // paste in Claude's input box without Enter: it isn't sent, and the id doesn't count as typed.
      const notWaiting = async () => {
        if ((await find(d.name))?.state === "waiting") throw new Error("Claude is asking something. Answer it first.");
      };
      const keys = async () => {
        await notWaiting();
        return ["\x1b[200~" + text + "\x1b[201~", "\r"];
      };
      await typed(ws, id, keys, notWaiting);
      return send(ws, { type: "ack", id });
    }
    if (m.type === "answer") {
      await typed(ws, id, async () => {
        const s = await find(d.name);
        // The same wait and the same choice under pick: the options can change within one wait.
        const p = s?.state === "waiting" ? s.prompt : undefined;
        const keys = p && p.at === m.at && typeof m.label === "string" && choiceLabel(p, m.pick) === m.label ? answerKeys(p, m.pick) : undefined;
        if (!keys) throw new Error("the question changed");
        return [keys];
      });
      return send(ws, { type: "ack", id });
    }
    if (m.type === "interrupt") {
      await typed(ws, id, async () => ["\x1b"]);
      return send(ws, { type: "ack", id });
    }
    fail("unknown message");
  } catch (e) {
    fail((e as Error).message);
  }
}

// What is being typed finishes (what's queued after it doesn't start), then the client goes: killed
// mid-write, its last keys could be lost while the id counts as typed.
export async function closeChat(ws: ServerWebSocket<ChatData>) {
  const d = ws.data;
  d.closed = true;
  clearInterval(d.timer);
  await d.queue;
  d.unfollow?.();
  if (d.proc) await Bun.sleep(100); // for zmx to pass the last keys on
  d.proc?.kill("SIGTERM");
}
