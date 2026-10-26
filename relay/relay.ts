// The relay's work (docs/superpowers/specs/2026-10-26-messages-design.md, sections 1 and 3), apart from its files and
// the clock so tests can drive it.
// - In: new texts from chat.db go to blimpd (POST /messages/in) in order, each kept in the state file until blimpd
//   has it. With no server in relay.json they go straight back as "got: <text>" (echo mode, for testing the Mac on
//   its own).
// - Out: blimpd's texts to send (GET /messages/out, held up to 25 s), each sent through Messages and then marked
//   sent.

import type { Incoming } from "./chatdb";

export type Config = { server?: string; key?: string; allow: string[] };
// last: the last chat.db row read. to: whom to text, the sender of the latest allowed text. pending: texts in that
// blimpd doesn't have yet.
export type State = { last?: number; to?: string; pending: Incoming[] };

export type RelayDeps = {
  config: Config;
  state: State;
  save: (s: State) => void;
  watermark: () => number;
  read: (after: number) => { last: number; texts: Incoming[] };
  send: (text: string, to: string) => string | undefined;
  // A request to blimpd: a path under config.server, sent with the key.
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  log: (m: string) => void;
  sleep: (ms: number) => Promise<void>;
};

// relay.json's text. allow: the handles whose texts may reach blimpd. A server needs its key.
export function parseConfig(text: string): Config {
  const c = JSON.parse(text);
  if (!c || typeof c !== "object" || !Array.isArray(c.allow) || !c.allow.length || !c.allow.every((a: unknown) => typeof a === "string" && a.trim()))
    throw new Error("relay.json: allow must list the handles (+15551234567, name@example.com) whose texts may reach blimpd");
  if (c.server !== undefined && (typeof c.server !== "string" || !/^https?:\/\//.test(c.server) || typeof c.key !== "string" || !c.key))
    throw new Error("relay.json: server must be blimpd's https:// address, with its key");
  return { server: c.server?.replace(/\/+$/, ""), key: c.key, allow: c.allow.map((a: string) => a.trim()) };
}

// state.json's text; what's missing or broken starts empty.
export function parseState(text?: string): State {
  try {
    const s = JSON.parse(text ?? "");
    return { last: typeof s?.last === "number" ? s.last : undefined, to: typeof s?.to === "string" ? s.to : undefined, pending: Array.isArray(s?.pending) ? s.pending : [] };
  } catch {
    return { pending: [] };
  }
}

// One look at chat.db, then delivery of what's waiting.
export async function inStep(d: RelayDeps): Promise<void> {
  const s = d.state;
  s.last ??= d.watermark();
  const { last, texts } = d.read(s.last);
  if (last !== s.last || texts.length) {
    s.last = last;
    for (const t of texts) {
      s.to = t.from;
      s.pending.push(t);
    }
    d.save(s);
  }
  if (!d.config.server) {
    while (s.pending.length) {
      const t = s.pending[0];
      const err = d.send(`got: ${t.text}`, t.from);
      if (err) return d.log(`couldn't send a text: ${err}`);
      s.pending.shift();
      d.save(s);
    }
    return;
  }
  while (s.pending.length) {
    let r: Response;
    try {
      r = await d.fetch("/messages/in", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(s.pending[0]), signal: AbortSignal.timeout(15_000) });
    } catch (e) {
      return d.log(`blimpd can't be reached (${(e as Error).message}); trying again`);
    }
    if (r.status === 401) return d.log("blimpd refused the key in relay.json; texts wait until it's fixed");
    if (r.status >= 500) return d.log(`blimpd said ${r.status}; trying again`);
    if (!r.ok) d.log(`blimpd said ${r.status} (${await r.text()}); skipped a text`);
    s.pending.shift();
    d.save(s);
  }
}

// One round out: what blimpd has to send, each sent and then marked sent. Throws when blimpd can't be reached or
// says no, or a send fails; whatever wasn't marked sent comes again next round.
export async function outStep(d: RelayDeps): Promise<void> {
  const r = await d.fetch("/messages/out?wait=25", { signal: AbortSignal.timeout(40_000) });
  if (!r.ok) throw new Error(`blimpd said ${r.status}`);
  const { texts } = (await r.json()) as { texts: { id: string; text: string }[] };
  for (const t of texts) {
    const err = d.send(t.text, d.state.to ?? d.config.allow[0]);
    if (err) throw new Error(`couldn't send a text: ${err}`);
    const done = await d.fetch(`/messages/out/${encodeURIComponent(t.id)}/sent`, { method: "POST" });
    if (!done.ok) throw new Error(`blimpd said ${done.status} to a sent text`);
  }
}

// In, every 2 s, for ever.
export async function inLoop(d: RelayDeps): Promise<never> {
  for (;;) {
    try {
      await inStep(d);
    } catch (e) {
      d.log(`reading texts: ${(e as Error).message}`);
    }
    await d.sleep(2000);
  }
}

// Out, round after round; after a failure the gap grows from 2 s to at most a minute.
export async function outLoop(d: RelayDeps): Promise<never> {
  let gap = 0;
  for (;;) {
    try {
      await outStep(d);
      gap = 0;
    } catch (e) {
      d.log((e as Error).message);
      gap = Math.min(gap ? gap * 2 : 2000, 60_000);
      await d.sleep(gap);
    }
  }
}
