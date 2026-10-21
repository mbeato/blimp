// The chat socket (docs/DESIGN.md, Chat): a session's conversation as messages, and a way to type
// into it, for the phone. Each socket keeps one zmx client attached while it's open, at the size
// the session is shown at elsewhere: a client per message, or one of another size, upsets Claude's
// screen (the probe in the phone spec). How keys are typed is in typing.ts, shared with blimpd's own messages.

import type { ServerWebSocket } from "bun";
import { type ChatMessage, type ChatScan, newScan, readAppended, readLast } from "./chat";
import { answerKeys, answerSteps, choiceLabel, cleanText, type Expect, type Prompt, parseDialog, parseTrust, screenMeets, trustSteps } from "./prompt";
import { existsSync } from "node:fs";
import { claudeDir, type Session, transcriptPath, zmxEnv, zmxPath } from "./sessions";
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
      // Checked before the paste and again before Enter. A question that starts in between leaves the
      // paste in Claude's input box without Enter: it isn't sent, and the id doesn't count as typed.
      const notWaiting = async () => {
        if ((await find(d.name))?.state === "waiting") throw new Asking();
      };
      const keys = async () => {
        await notWaiting();
        return ["\x1b[200~" + text + "\x1b[201~", "\r"];
      };
      await typed(d.typist, id, keys, notWaiting);
      return send(ws, { type: "ack", id });
    }
    if (m.type === "answer" && m.answers !== undefined) {
      // Every question of a dialog: blimpd types it step by step, each after the screen shows its place.
      let steps: { expect: Expect }[] = [];
      let p: Prompt | undefined;
      await typed(d.typist, id, async () => {
        const s = await find(d.name);
        p = s?.state === "waiting" && s.prompt?.at === m.at ? s.prompt : undefined;
        const r = p ? answerSteps(p, m.answers, m.labels) : { error: "the question changed" };
        if ("error" in r) throw new Error(r.error);
        steps = r.steps;
        await onScreen(d.name, p!, steps[0].expect);
        return r.steps.map((s) => s.keys);
      }, (i) => onScreen(d.name, p!, steps[i].expect));
      return send(ws, { type: "ack", id });
    }
    if (m.type === "answer") {
      let steps: ReturnType<typeof trustSteps>;
      let preview: { p: Prompt; steps: { expect: Expect }[] } | undefined;
      await typed(d.typist, id, async () => {
        const s = await find(d.name);
        // The same wait and the same choice under pick: the options can change within one wait.
        const p = s?.state === "waiting" ? s.prompt : undefined;
        const same = p && p.at === m.at && typeof m.label === "string" && choiceLabel(p, m.pick) === m.label;
        // Folder trust has no digits: the cursor is moved and Enter pressed, each after the screen shows it.
        if (same && p.kind === "trust" && (steps = trustSteps(m.pick))) {
          await onTrust(d.name, steps[0].cursor);
          return steps.map((t) => t.keys);
        }
        // A question with previews: the digit moves the cursor, then Enter, each after the screen shows its place.
        if (same && p.kind === "question" && p.questions[0]?.preview) {
          const r = answerSteps(p, [{ picks: [m.pick] }], [[m.label]]);
          if ("error" in r) throw new Error(r.error);
          preview = { p, steps: r.steps };
          await onScreen(d.name, p, r.steps[0].expect);
          return r.steps.map((s) => s.keys);
        }
        const keys = same ? answerKeys(p, m.pick) : undefined;
        if (!keys) throw new Error("the question changed");
        return [keys];
      }, (i) => (preview ? onScreen(d.name, preview.p, preview.steps[i].expect) : onTrust(d.name, steps![i].cursor)));
      return send(ws, { type: "ack", id });
    }
    if (m.type === "interrupt") {
      // With `at`, the phone dismisses that question: Esc only while it's still up. Otherwise the Esc would
      // stop Claude's work, if it was answered on the Mac just before.
      await typed(d.typist, id, async () => {
        if (m.at !== undefined) {
          const s = await find(d.name);
          if (s?.state !== "waiting" || s.prompt?.at !== m.at) throw new Error("the question changed");
        }
        return ["\x1b"];
      });
      return send(ws, { type: "ack", id });
    }
    fail("unknown message");
  } catch (e) {
    fail((e as Error).message);
  }
}

// Waits (up to 3 s) for Claude's screen to show where the next keys belong. Otherwise the answer stops
// there: the rest would land in the wrong place.
async function untilScreen(name: string, where: string, want: string, meets: (screen: string) => boolean, read: (screen: string) => unknown) {
  const end = Date.now() + 3000;
  for (;;) {
    const r = Bun.spawn([zmxPath(), "history", name], { env: zmxEnv(), stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const screen = (await new Response(r.stdout).text()).split("\n").slice(-120).join("\n");
    if (meets(screen)) return;
    if (Date.now() > end) {
      // What it saw, so a stopped answer can be told apart from a new dialog layout.
      console.error(`answer for ${name} stopped before ${where} (${want}); the screen read as ${JSON.stringify(read(screen))}; the screen's end:\n${screen.split("\n").slice(-30).join("\n")}`);
      throw new Error(`stopped: Claude's screen didn't show ${where} as expected. Finish it on the Mac.`);
    }
    await Bun.sleep(100);
  }
}

const onScreen = (name: string, p: Prompt, e: Expect) =>
  untilScreen(name, "review" in e ? "the review screen" : `question ${e.q + 1}`, JSON.stringify(e), (s) => screenMeets(p, parseDialog(s), e), parseDialog);

const onTrust = (name: string, cursor: "yes" | "no") =>
  untilScreen(name, "the folder trust question", `cursor on ${cursor}`, (s) => parseTrust(s)?.cursor === cursor, parseTrust);

// Everything the phone sent is typed first (a message still waiting for the history, or queued behind
// another), then the client goes: killed mid-write, its last keys could be lost while the id counts as typed.
export async function closeChat(ws: ServerWebSocket<ChatData>) {
  const d = ws.data;
  d.closed = true;
  clearInterval(d.timer);
  while (d.handling?.size) await Promise.all(d.handling);
  await release(d.typist);
}
