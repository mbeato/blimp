// The texting loop (docs/superpowers/specs/2026-10-26-messages-design.md, section 2).
// - Texts in from the relay answer the question last texted, or wait in the state file's `held`.
// - Every second:
//   - the assistant's finished turns and its questions become texts out (the outbox, which the relay takes);
//   - held texts are typed into it once it isn't asking anything;
//   - a relay that's been quiet for 5 minutes is told to the phone, once.

import { answerOnce } from "../answer";
import { ASSISTANT, assistantOn } from "../assistant";
import { HttpError } from "../files";
import { follow, newSummary, type Summary } from "../names";
import { cleanText } from "../prompt";
import { Apns, HOSTS } from "../push/apns";
import { ASK_SETTLE } from "../push/rule";
import { readCreds, readDevices } from "../push/store";
import type { Session } from "../sessions";
import { Asking, findSession, typeInto } from "../typing";
import { addOut, change, messagesFile, messagesOn, pushOut, readState, SEEN } from "./store";
import { ALREADY, isShortAnswer, OFF, OFFLINE, PICTURE_NOTE, PICTURE_ONLY, plainLines, replyFor, waitText } from "./words";

export const QUIET = 5 * 60_000;
const MAX_TEXT = 20_000;

export type TexterDeps = {
  on: () => boolean;
  assistantOn: () => boolean;
  session: () => Promise<Session | undefined>; // the assistant's
  reply: (transcript: string) => Promise<{ id?: string; text?: string }>; // its latest reply
  type: (text: string) => Promise<void>; // into the assistant; throws Asking while it asks something
  answer: (id: string, m: Record<string, unknown>) => Promise<void>; // answer.ts's answerOnce for the assistant
  alert: (body: string) => Promise<void>; // to the phones
  file: string; // messages.json
  now: () => number;
  log: (m: string) => void;
};

export class Texter {
  private busy = false;
  private started: number;
  private relaySeen?: number;
  private alerted = false;

  constructor(private deps: TexterDeps) {
    this.started = deps.now();
  }

  // The relay called.
  touch() {
    const now = this.deps.now();
    this.relaySeen = now;
    this.alerted = false;
    change((s) => void (s.relaySeen = now), this.deps.file);
  }

  // Texting is on and the relay called within 5 minutes: the texts are the assistant's alerts (push/rule.ts).
  live(): boolean {
    return this.deps.on() && this.relaySeen !== undefined && this.deps.now() - this.relaySeen < QUIET;
  }

  // A text from the relay.
  async receive(body: unknown): Promise<{ ok: true; dup?: true }> {
    const t = (body ?? {}) as { id?: unknown; from?: unknown; text?: unknown; picture?: unknown };
    if (typeof t.id !== "string" || !t.id || t.id.length > 200 || typeof t.from !== "string" || t.from.length > 200 || typeof t.text !== "string" || t.text.length > MAX_TEXT || (t.picture !== undefined && typeof t.picture !== "boolean"))
      throw new HttpError(400, "expected a text: {id, from, text, picture?}");
    const id = t.id;
    const file = this.deps.file;
    const dup = change((s) => {
      if (s.seen.includes(id)) return true;
      s.seen = [...s.seen, id].slice(-SEEN);
      return false;
    }, file);
    if (dup) return { ok: true, dup: true };
    const say = (words: string) => addOut(words, this.deps.now(), file);
    if (!this.deps.assistantOn()) {
      say(OFF);
      return { ok: true };
    }
    let text = cleanText(t.text).trim();
    if (t.picture && !text) {
      say(PICTURE_ONLY);
      return { ok: true };
    }
    if (!text) return { ok: true };
    if (t.picture) text += PICTURE_NOTE;
    const s = await this.deps.session();
    const st = readState(file);
    const p = s?.state === "waiting" && s.prompt?.at === st.lastWait ? s.prompt : undefined;
    if (p && st.open) {
      const m = replyFor(p, text);
      if (m) {
        change((x) => void (x.open = false), file);
        try {
          await this.deps.answer(id, m);
        } catch (e) {
          const why = (e as Error).message;
          say(why === "the question changed" ? ALREADY : `Couldn't answer that: ${why}`);
        }
        return { ok: true };
      }
    } else if (!p && st.open && isShortAnswer(text)) {
      change((x) => void (x.open = false), file);
      say(ALREADY);
      return { ok: true };
    }
    change((x) => void x.held.push(text), file);
    return { ok: true };
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      if (!this.deps.on()) return;
      const now = this.deps.now();
      const file = this.deps.file;
      if (!this.alerted && now - Math.max(this.relaySeen ?? 0, this.started) >= QUIET) {
        this.alerted = true;
        await this.deps.alert(OFFLINE).catch((e) => this.deps.log(`messages: couldn't tell the phone the relay is quiet (${(e as Error).message})`));
      }
      const s = await this.deps.session();
      if (!s) return;
      // Its reply, once its turn is over and it's one not texted yet. The first look only notes the latest one.
      if (!readState(file).primed) {
        const r: { id?: string } = s.transcript ? await this.deps.reply(s.transcript) : {};
        change((x) => {
          x.primed = true;
          x.sentReply = r.id;
        }, file);
      } else if (s.state === "done" && s.transcript) {
        const r = await this.deps.reply(s.transcript);
        if (r.id && r.id !== readState(file).sentReply) {
          const words = plainLines(r.text ?? "");
          change((x) => {
            x.sentReply = r.id;
            x.open = false;
            if (words) pushOut(x, words, now);
          }, file);
        }
      }
      // Its question, once it has asked for 3 s: texted once.
      const p = s.state === "waiting" ? s.prompt : undefined;
      if (p && now - p.at >= ASK_SETTLE && p.at !== readState(file).lastWait)
        change((x) => {
          x.lastWait = p.at;
          x.open = true;
          pushOut(x, waitText(p), now);
        }, file);
      // Held texts, once it isn't asking anything.
      const held = readState(file).held;
      if (held.length && s.state !== "waiting") {
        try {
          await this.deps.type(held.join("\n\n"));
          change((x) => void (x.held = x.held.slice(held.length)), file);
        } catch (e) {
          if (!(e instanceof Asking)) this.deps.log(`messages: couldn't type a text into the assistant (${(e as Error).message}); trying again`);
        }
      }
    } catch (e) {
      this.deps.log(`messages: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  // The texts to send: as soon as there are some, or none after ms (real time: the relay holds its request open).
  async waitOut(ms: number, signal?: AbortSignal): Promise<{ id: string; text: string }[]> {
    const end = Date.now() + ms;
    for (;;) {
      const out = readState(this.deps.file).outbox;
      if (out.length || Date.now() >= end || signal?.aborted) return out.map(({ id, text }) => ({ id, text }));
      await Bun.sleep(Math.min(250, Math.max(end - Date.now(), 1)));
    }
  }
}

// The latest reply's id and text, read on from where it was, one transcript at a time (the assistant's).
let summary: { file: string; sum: Summary } | undefined;

const live = (): TexterDeps => ({
  on: () => messagesOn(),
  assistantOn: () => assistantOn(),
  session: () => findSession(ASSISTANT),
  reply: async (file) => {
    if (summary?.file !== file) summary = { file, sum: newSummary() };
    await follow(file, summary.sum);
    return { id: summary.sum.replyId, text: summary.sum.reply };
  },
  type: (text) => typeInto(ASSISTANT, text, { enter: true }),
  answer: (id, m) => answerOnce(ASSISTANT, `messages-${id}`, m),
  alert: async (body) => {
    const creds = readCreds();
    const devices = readDevices();
    if (!creds || !devices.length) return console.log(`messages: ${body} (no phone to tell)`);
    const apns = new Apns(creds, HOSTS);
    try {
      for (const d of devices) await apns.send(d, { aps: { alert: { title: "blimp", body }, sound: "default" } });
    } finally {
      apns.close();
    }
  },
  file: messagesFile(),
  now: Date.now,
  log: (m) => console.log(m),
});

let texter: Texter | undefined;
export const theTexter = () => (texter ??= new Texter(live()));

// Every second; it reads nothing while texting is off.
export function startMessages(every = 1000) {
  setInterval(() => void theTexter().tick(), every);
}
