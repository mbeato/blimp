// The chat socket (docs/DESIGN.md, Chat): a session's conversation as messages, and a way to type
// into it, for the phone. Each socket keeps one zmx client attached while it's open, at the size
// the session is shown at elsewhere: a client per message, or one of another size, upsets Claude's
// screen (the probe in the phone spec). How keys are typed is in typing.ts, shared with blimpd's own messages;
// how answers are typed is in answer.ts, shared with POST /sessions/<name>/answer.

import type { ServerWebSocket } from "bun";
import { type ChatMessage, type ChatScan, newScan, readAppended, readLast } from "./chat";
import { answer } from "./answer";
import { cleanText } from "./prompt";
import { existsSync } from "node:fs";
import { markFollowed } from "./followed";
import { claudeDir, type Session, transcriptPath } from "./sessions";
import { Asking, findSession, forget, release, typed, type Typist, typist, wasTyped } from "./typing";

export type ChatData = {
  kind: "chat";
  name: string;
  closed?: boolean;
  session?: Session;
  file?: string;
  scan?: ChatScan;
  fresh?: boolean; // sent an empty history: the transcript isn't there yet, and all of it goes out as append
  typist: Typist; // this socket's zmx client, started on the first input
  timer?: ReturnType<typeof setInterval>;
  ticks: number;
  busy?: boolean;
  opened?: Promise<void>;
  handling?: Set<Promise<void>>; // messages being handled: closeChat waits for them
  phone?: string; // the phone's token, when the phone opened it (server.ts's upgrade sets it)
};

export const chatData = (name: string): ChatData => ({ kind: "chat", name, ticks: 0, typist: typist(name) });

const HISTORY = 200;

const send = (ws: ServerWebSocket<ChatData>, m: object) => ws.data.closed || ws.send(JSON.stringify(m));

const find = findSession;

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
        forget(d.name);
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
    // Claude asks whether to trust its folder before it has a conversation: an empty one, like a new session's.
    else send(ws, d.session.prompt?.kind === "trust" ? { type: "history", messages: [] } : { type: "unreadable" });
    if (d.closed) return; // closed while the history was read
    d.timer = setInterval(() => tick(ws), 250);
  } catch {
    // zmx missing or refused, the transcript folder changing under us…
    if (d.closed) return;
    d.closed = true;
    ws.close(1011, "couldn't read the session");
  }
}

// What the phone sent is typed even if the socket closes before its turn: closeChat waits for it. A
// Stop sent just before the phone's link drops still stops Claude.
export function chatMessage(ws: ServerWebSocket<ChatData>, msg: string | Buffer) {
  const handling = (ws.data.handling ??= new Set());
  const p = handle(ws, msg).finally(() => handling.delete(p));
  handling.add(p);
  return p;
}

async function handle(ws: ServerWebSocket<ChatData>, msg: string | Buffer) {
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
    if (!d.session?.sessionId) {
      // Before Claude has a conversation, the one thing to answer is its folder trust question.
      const trust = m.type !== "interrupt" && (await find(d.name))?.prompt?.kind === "trust";
      if (trust && m.type === "input") return fail("Claude is asking something. Answer it first.");
      if (!trust || m.type !== "answer") return fail("open this session on the Mac");
    }
    if (m.type !== "input" && wasTyped(d.name, id)) return send(ws, { type: "ack", id });
    if (m.type === "input") {
      if (typeof m.text !== "string" || m.text.length > 100_000) return fail("text must be a string of at most 100 000 characters");
      // No control characters from the phone: ESC would end the paste early and turn the rest into key
      // presses, ctrl+\ detaches zmx's client, ctrl+C interrupts. Newlines and tabs stay; \r is a newline.
      const text = cleanText(m.text);
      // Not while Claude asks something: the Enter after the paste would confirm its highlighted choice.
      // Checked right before the paste, which goes in one write with its Enter (Claude 2.1.300 sends it,
      // queues it while working): a question can't start between them and leave the text in Claude's box.
      // A resent id was typed already: it is not a new prompt, so it doesn't follow anything again.
      const fresh = !wasTyped(d.name, id);
      await typed(d.typist, id, async () => {
        if ((await find(d.name))?.state === "waiting") throw new Asking();
        return ["\x1b[200~" + text + "\x1b[201~\r"];
      });
      // A prompt from the phone: the live panel follows this turn (followed.ts).
      if (d.phone && fresh) markFollowed(d.name);
      return send(ws, { type: "ack", id });
    }
    // answer, interrupt and deny (answer.ts); anything else is "unknown message".
    await answer(d.typist, id, m);
    return send(ws, { type: "ack", id });
  } catch (e) {
    fail((e as Error).message);
  }
}

// Everything the phone sent is typed first (a message still waiting for the history, or queued behind
// another), then the client goes: killed mid-write, its last keys could be lost while the id counts as typed.
export async function closeChat(ws: ServerWebSocket<ChatData>) {
  const d = ws.data;
  d.closed = true;
  clearInterval(d.timer);
  while (d.handling?.size) await Promise.all(d.handling);
  await release(d.typist);
}
