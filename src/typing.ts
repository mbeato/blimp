// Typing into a session, for the chat socket (chatsocket.ts) and for blimpd's own messages to Claude.
// Text goes in as a bracketed paste, then Enter 50 ms later, as a person would press it. Not while
// Claude asks something: the Enter would confirm its highlighted choice. The keys go through a zmx
// client of our own (a Typist), attached at the size the session is shown at elsewhere: a client of
// another size resizes the session for everyone. One thing is typed at a time per session, whoever
// types it, so two messages close together never interleave.

import type { Subprocess } from "bun";
import { cleanText } from "./prompt";
import { claudeDir, listSessions, type Session, sessionExists, zmxEnv, zmxListAsync, zmxPath } from "./sessions";
import { followSize, lastSize } from "./terminal";

// A session's zmx client, started on the first keys. queue: the last thing this typist typed.
export type Typist = { name: string; proc?: Subprocess; ready?: Promise<void>; unfollow?: () => void; queue?: Promise<unknown> };

export const typist = (name: string): Typist => ({ name });

// Text for the person who sent it: what they should do about it.
export class Asking extends Error {
  constructor() {
    super("Claude is asking something. Answer it first.");
  }
}

export async function findSession(name: string): Promise<Session | undefined> {
  return listSessions(claudeDir(), await zmxListAsync()).find((s) => s.name === name);
}

const seen = new Map<string, string[]>(); // session -> last 100 ids typed, across typists
const typing = new Map<string, Promise<void>>(); // session + id -> its write in progress
const queues = new Map<string, Promise<unknown>>(); // session -> the last thing queued to type into it

// When a session ends, its ids go: a new session can get the same name.
export const forget = (name: string) => void seen.delete(name);
export const wasTyped = (name: string, id: string) => (seen.get(name) ?? []).includes(id);

// The zmx client is started on the first keys, not before: a phone that only reads adds no client.
function client(t: Typist) {
  if (t.proc && t.proc.exitCode === null) return t.proc;
  const { cols, rows } = lastSize(t.name);
  let ready!: () => void;
  t.ready = new Promise<void>((r) => (ready = r));
  const proc = (t.proc = Bun.spawn([zmxPath(), "attach", t.name], {
    env: { ...zmxEnv(), TERM: "xterm-256color", COLORTERM: "truecolor" },
    // Its output is the same screen the viewers see, so nobody needs it here. zmx draws that screen
    // as it attaches the client: the first output says input will reach the session.
    terminal: { cols, rows, data: () => ready() },
  }));
  proc.exited.then(() => proc.terminal?.close()); // killed, or ended on its own (the next input starts another)
  t.unfollow?.();
  t.unfollow = followSize(t.name, (c, r) => {
    try {
      t.proc?.terminal?.resize(c, r);
    } catch {} // the client's terminal may already be closed
  });
  return t.proc;
}

// keys says what to type when its turn comes (an answer checks its question is still up); recheck
// runs again before each part after the first (input's Enter, each step of a dialog).
export type Recheck = (part: number) => Promise<void>;
export async function write(t: Typist, keys: () => Promise<string[]>, recheck?: Recheck) {
  const fresh = !t.proc || t.proc.exitCode !== null;
  if (fresh) {
    // `zmx attach` would create a session that has ended, and the text would go to a bare shell.
    const alive = await sessionExists(t.name).catch(() => false);
    if (!alive) throw new Error("the session ended");
  }
  const parts = await keys();
  const term = client(t).terminal!;
  // Typing too soon after the client starts can land before zmx has attached it.
  if (fresh) await Promise.race([t.ready, Bun.sleep(1000)]);
  // zmx 0.5 drops an Esc that is a new client's first input; an empty paste passes and the TUI ignores it.
  if (fresh && parts[0].startsWith("\x1b") && !parts[0].startsWith("\x1b[200~")) {
    term.write("\x1b[200~\x1b[201~");
    await Bun.sleep(50);
  }
  for (const [i, p] of parts.entries()) {
    if (i) {
      await Bun.sleep(50); // Enter apart from the paste, as a person would press it
      await recheck?.(i);
    }
    term.write(p);
  }
}

// f's turn in the session's queue. t.queue is this typist's last turn, for release to wait for.
function queued<T>(t: Typist, f: () => Promise<T>): Promise<T> {
  const step = (queues.get(t.name) ?? Promise.resolve()).then(f);
  const done = step.catch(() => {});
  queues.set(t.name, done);
  done.then(() => queues.get(t.name) === done && queues.delete(t.name));
  t.queue = done;
  return step;
}

// Typed once per id: the phone resends what it didn't see acknowledged, maybe on a new socket while
// the old one is still typing it (then it waits for that one).
export function typed(t: Typist, id: string, keys: () => Promise<string[]>, recheck?: Recheck): Promise<void> {
  const key = `${t.name}\0${id}`;
  return queued(t, async () => {
    if (wasTyped(t.name, id)) return;
    const other = typing.get(key);
    if (other) return other;
    const p = write(t, keys, recheck).then(() => void seen.set(t.name, [...(seen.get(t.name) ?? []), id].slice(-100)));
    typing.set(key, p);
    try {
      await p;
    } finally {
      typing.delete(key);
    }
  });
}

// The typist's last keys are typed first, then its client goes: killed mid-write, its last keys could be lost.
export async function release(t: Typist) {
  await t.queue;
  t.unfollow?.();
  if (t.proc) await Bun.sleep(100); // for zmx to pass the last keys on
  t.proc?.kill("SIGTERM");
}

// Throws Asking while Claude asks something (checked before the paste and again before Enter: a
// question that starts in between leaves the paste in Claude's input box without Enter).
const notWaiting = async (name: string) => {
  const s = await findSession(name);
  if (!s) throw new Error("the session ended");
  if (s.state === "waiting") throw new Asking();
};

const pasted = (text: string) => "\x1b[200~" + cleanText(text) + "\x1b[201~";

// Types text into a session from blimpd itself (a run's result, a handoff, a secret's note), with its
// own zmx client for just this. Control characters are taken out (cleanText). Callers check it's a
// Claude session; this checks it's there and not asking something (Asking), and resolves once typed.
export async function typeInto(name: string, text: string, { enter }: { enter: boolean }): Promise<void> {
  const t = typist(name);
  const check = () => notWaiting(name);
  try {
    await queued(t, () => write(t, async () => {
      await check();
      return enter ? [pasted(text), "\r"] : [pasted(text)];
    }, check));
  } finally {
    await release(t);
  }
}
