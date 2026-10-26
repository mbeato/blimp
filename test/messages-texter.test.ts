// The texting loop (src/messages/texter.ts), with fakes for the assistant's session, its replies, typing, answering
// and the phone alert, against a real state file in a temp folder.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpError } from "../src/files";
import { addOut, markSent, readState } from "../src/messages/store";
import { QUIET, Texter, type TexterDeps } from "../src/messages/texter";
import { ALREADY, OFF, OFFLINE, OPEN_BLIMP, PICTURE_NOTE, PICTURE_ONLY, STUCK } from "../src/messages/words";
import type { Session } from "../src/sessions";
import { Asking } from "../src/typing";

const T = 1_800_000_000_000;
let dir = "";
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "blimp-texter-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const permission = (at: number) => ({ kind: "permission" as const, tool: "Bash", summary: "blimpd send x hi", options: ["Yes", "No"], keys: ["1", "\x1b"], answerable: true as const, at });
const ASKED = "OK to run this?\nblimpd send x hi\n\nReply yes or no.";

function setup() {
  const t = {
    on: true,
    assistantOn: true,
    session: { name: "assistant", kind: "claude", state: "done", transcript: "/t.jsonl" } as Session | undefined,
    reply: {} as { id?: string; text?: string; ended?: { id: string; text: string }[] },
    typed: [] as string[],
    typeFails: undefined as Error | undefined,
    answers: [] as { id: string; m: unknown }[],
    answerFails: undefined as Error | undefined,
    alerts: [] as string[],
    clock: T,
    logs: [] as string[],
  };
  const deps: TexterDeps = {
    on: () => t.on,
    assistantOn: () => t.assistantOn,
    session: async () => t.session,
    // As the real one: the replies that ended a turn are given once.
    reply: async () => {
      const r = t.reply;
      t.reply = { ...r, ended: undefined };
      return r;
    },
    type: async (text) => {
      if (t.typeFails) throw t.typeFails;
      t.typed.push(text);
    },
    answer: async (id, m) => {
      if (t.answerFails) throw t.answerFails;
      t.answers.push({ id, m });
    },
    alert: async (body) => void t.alerts.push(body),
    file: join(dir, "messages.json"),
    now: () => t.clock,
    log: (m) => void t.logs.push(m),
  };
  const set = (s: Partial<Session>) => (t.session = { ...t.session!, ...s } as Session);
  return { t, x: new Texter(deps), set, state: () => readState(deps.file), out: () => readState(deps.file).outbox.map((o) => o.text) };
}
const text = (id: string, words: string, picture?: boolean) => ({ id, from: "+15550000000", text: words, ...(picture !== undefined && { picture }) });

test("a body that isn't a text is refused; the same text twice is taken once", async () => {
  const { x, state } = setup();
  for (const bad of [null, {}, { id: "", from: "a", text: "x" }, { id: "a", from: "a", text: 5 }, { id: "a", from: "a", text: "x", picture: "yes" }, { id: "a".repeat(201), from: "a", text: "x" }, { id: "a", from: "a", text: "x".repeat(20_001) }])
    await expect(x.receive(bad)).rejects.toBeInstanceOf(HttpError);
  expect(await x.receive(text("g1", "hi"))).toEqual({ ok: true });
  expect(await x.receive(text("g1", "hi"))).toEqual({ ok: true, dup: true });
  expect([state().held, state().seen]).toEqual([["hi"], ["g1"]]);
});

test("with the assistant off, a text gets a text back saying so", async () => {
  const { t, x, out, state } = setup();
  t.assistantOn = false;
  await x.receive(text("g1", "hi"));
  expect([out(), state().held]).toEqual([[OFF], []]);
});

test("a picture alone gets a text back; a picture with words is typed with a note", async () => {
  const { x, out, state } = setup();
  await x.receive(text("g1", "", true));
  expect(out()).toEqual([PICTURE_ONLY]);
  await x.receive(text("g2", "look", true));
  expect(state().held).toEqual(["look" + PICTURE_NOTE]);
});

test("a text with no words and no picture is ignored", async () => {
  const { x, state, t, out } = setup();
  expect(await x.receive(text("g1", "   "))).toEqual({ ok: true });
  expect([state().held, out(), t.answers, state().seen]).toEqual([[], [], [], ["g1"]]);
});

test("texts are typed on the next tick, together, once the assistant isn't asking anything", async () => {
  const { t, x, set, state } = setup();
  await x.tick();
  await x.receive(text("g1", "one"));
  await x.receive(text("g2", "two"));
  set({ state: "waiting", prompt: permission(T) });
  await x.tick(); // a wait under 3 s: not texted, and nothing typed into it
  expect([t.typed, state().held]).toEqual([[], ["one", "two"]]);
  set({ state: "working", prompt: undefined });
  t.typeFails = new Asking();
  await x.tick();
  expect([t.typed, t.logs]).toEqual([[], []]);
  t.typeFails = undefined;
  await x.tick();
  expect([t.typed, state().held]).toEqual([["one\n\ntwo"], []]);
});

test("a question is texted once it has waited 3 s, and once; a texted yes answers it", async () => {
  const { t, x, set, out, state } = setup();
  await x.tick();
  set({ state: "waiting", prompt: permission(T) });
  t.clock = T + 2999;
  await x.tick();
  expect(out()).toEqual([]);
  t.clock = T + 3000;
  await x.tick();
  await x.tick();
  expect(out()).toEqual([ASKED]);
  expect(state()).toMatchObject({ lastWait: T, open: true });
  await x.receive(text("g1", "Yes"));
  expect(t.answers).toEqual([{ id: "g1", m: { type: "answer", at: T, pick: 0, label: "Yes" } }]);
  expect([state().open, state().held]).toEqual([false, []]);
});

test("other words to a texted permission are a no, with them as the reason", async () => {
  const { t, x, set } = setup();
  await x.tick();
  set({ state: "waiting", prompt: permission(T) });
  t.clock = T + 3000;
  await x.tick();
  await x.receive(text("g1", "use the other branch"));
  expect(t.answers).toEqual([{ id: "g1", m: { type: "deny", at: T, text: "use the other branch" } }]);
});

test("a yes after the question was answered in blimp is told so and not typed; after that a yes is just a message", async () => {
  const { t, x, set, out, state } = setup();
  await x.tick();
  set({ state: "waiting", prompt: permission(T) });
  t.clock = T + 3000;
  await x.tick();
  set({ state: "working", prompt: undefined });
  await x.receive(text("g1", "yes"));
  expect(out()).toEqual([ASKED, ALREADY]);
  expect([t.answers, state().held]).toEqual([[], []]);
  await x.receive(text("g2", "yes"));
  expect(state().held).toEqual(["yes"]);
});

test("an answer that lands after the question moved on is told as already answered", async () => {
  const { t, x, set, out } = setup();
  await x.tick();
  set({ state: "waiting", prompt: permission(T) });
  t.clock = T + 3000;
  await x.tick();
  t.answerFails = new HttpError(409, "the question changed");
  await x.receive(text("g1", "yes"));
  expect(out()).toEqual([ASKED, ALREADY]);
  t.answerFails = new HttpError(409, "stopped: Claude's screen didn't show question 1 as expected. Finish it on the Mac.");
  set({ prompt: permission(T + 10) });
  t.clock = T + 4000;
  await x.tick();
  await x.receive(text("g2", "no"));
  expect(out().at(-1)).toBe("Couldn't answer that: stopped: Claude's screen didn't show question 1 as expected. Finish it on the Mac.");
});

test("a question a text can't answer says to open blimp; texts wait until it's over", async () => {
  const { t, x, set, out, state } = setup();
  await x.tick();
  set({ state: "waiting", prompt: { kind: "other", answerable: false, at: T } });
  t.clock = T + 3000;
  await x.tick();
  expect(out()).toEqual([OPEN_BLIMP]);
  await x.receive(text("g1", "yes"));
  expect([out(), state().held, t.answers]).toEqual([[OPEN_BLIMP], ["yes"], []]);
  set({ state: "done", prompt: undefined });
  await x.tick();
  expect(t.typed).toEqual(["yes"]);
});

test("a wait with no prompt is texted once it has waited 3 s, keyed as push keys it, and says to open blimp; texts wait", async () => {
  const { t, x, set, out, state } = setup();
  await x.tick();
  set({ state: "waiting", prompt: undefined, stateSince: T });
  t.clock = T + 2999;
  await x.tick();
  expect(out()).toEqual([]);
  t.clock = T + 3000;
  await x.tick();
  await x.tick();
  expect(out()).toEqual([OPEN_BLIMP]);
  expect(state()).toMatchObject({ lastWait: T, open: true });
  await x.receive(text("g1", "yes"));
  expect([out(), state().held]).toEqual([[OPEN_BLIMP], ["yes"]]);
});

test("a turn's reply is texted once the turn is over, once, as plain text; the reply from before texting began isn't", async () => {
  const { t, x, set, out, state } = setup();
  t.reply = { id: "r0", text: "old" };
  await x.tick();
  expect(out()).toEqual([]);
  expect(state()).toMatchObject({ primed: true, sentReply: "r0" });
  t.reply = { id: "r1", text: "**Done.** See [the PR](https://e.com/1)." };
  set({ state: "working" });
  await x.tick();
  expect(out()).toEqual([]);
  set({ state: "done" });
  await x.tick();
  await x.tick();
  expect(out()).toEqual(["Done. See the PR (https://e.com/1)."]);
  t.reply = { id: "r2", text: "  " };
  await x.tick();
  expect([out().length, state().sentReply]).toEqual([1, "r2"]);
});

// A prompt can follow a reply before a tick sees the turn done: that reply comes as ended.
test("a reply that ended a turn is texted while the next turn works, once, and before the reply of a turn now done", async () => {
  const { t, x, set, out, state } = setup();
  t.reply = { id: "r0", text: "old" };
  await x.tick();
  set({ state: "working" });
  t.reply = { id: "r2", text: "in between", ended: [{ id: "r1", text: "**first**" }] };
  await x.tick();
  expect([out(), state().sentReply]).toEqual([["first"], "r1"]);
  await x.tick();
  expect(out()).toEqual(["first"]);
  set({ state: "done" });
  t.reply = { id: "r2", text: "second" };
  await x.tick();
  expect(out()).toEqual(["first", "second"]);
  set({ state: "working" });
  t.reply = { id: "r2", text: "second", ended: [{ id: "r2", text: "second" }] }; // texted at done already
  await x.tick();
  expect(out()).toEqual(["first", "second"]);
  set({ state: "done" });
  t.reply = { id: "r4", text: "fourth", ended: [{ id: "r3", text: "third" }] };
  await x.tick();
  await x.tick();
  expect([out(), state().sentReply]).toEqual([["first", "second", "third", "fourth"], "r4"]);
});

test("with no conversation when texting began, the first reply is texted", async () => {
  const { t, x, set, out } = setup();
  set({ transcript: undefined });
  await x.tick();
  set({ transcript: "/t.jsonl" });
  t.reply = { id: "r1", text: "first" };
  await x.tick();
  expect(out()).toEqual(["first"]);
});

test("a texted reply closes the question: a yes after it is a message", async () => {
  const { t, x, set, state } = setup();
  await x.tick();
  set({ state: "waiting", prompt: permission(T) });
  t.clock = T + 3000;
  await x.tick();
  set({ state: "done", prompt: undefined });
  t.reply = { id: "r1", text: "ok, sent" };
  await x.tick();
  expect(state().open).toBe(false);
  await x.receive(text("g1", "yes"));
  expect(state().held).toEqual(["yes"]);
});

test("a relay quiet for 5 minutes is told once; a call starts the count again; live means it called within 5 minutes", async () => {
  const { t, x, state } = setup();
  await x.tick(); // texting is on from T
  t.clock = T + QUIET - 1;
  await x.tick();
  expect(t.alerts).toEqual([]);
  t.clock = T + QUIET;
  await x.tick();
  await x.tick();
  expect(t.alerts).toEqual([OFFLINE]);
  expect(x.live()).toBe(false);
  x.touch();
  expect([x.live(), state().relaySeen]).toEqual([true, T + QUIET]);
  t.clock = T + 2 * QUIET;
  expect(x.live()).toBe(false);
  await x.tick();
  expect(t.alerts).toEqual([OFFLINE, OFFLINE]);
});

test("a relay that calls but can't send: once a text has waited 5 minutes, texting isn't live and the phone is told, once", async () => {
  const { t, x, state } = setup();
  const file = join(dir, "messages.json");
  x.touch();
  await x.tick();
  addOut("hi", T, file);
  t.clock = T + QUIET - 1;
  x.touch();
  await x.tick();
  expect([x.live(), t.alerts]).toEqual([true, []]);
  t.clock = T + QUIET;
  x.touch();
  expect(x.live()).toBe(false);
  await x.tick();
  await x.tick();
  expect(t.alerts).toEqual([STUCK]);
  markSent(state().outbox[0].id, file);
  expect(x.live()).toBe(true);
  await x.tick();
  addOut("again", T + QUIET, file);
  t.clock = T + 1.5 * QUIET;
  x.touch();
  t.clock = T + 2 * QUIET;
  x.touch();
  await x.tick();
  expect([x.live(), t.alerts]).toEqual([false, [STUCK, STUCK]]);
});

test("texts that waited while the relay was quiet aren't stuck: the relay is told offline, and is live once it calls", async () => {
  const { t, x } = setup();
  x.touch();
  await x.tick();
  addOut("hi", T, join(dir, "messages.json"));
  t.clock = T + QUIET;
  await x.tick();
  expect(t.alerts).toEqual([OFFLINE]);
  t.clock = T + 2 * QUIET;
  x.touch();
  await x.tick();
  expect([x.live(), t.alerts]).toEqual([true, [OFFLINE]]);
});

test("off: nothing is typed, texted or told", async () => {
  const { t, x, out } = setup();
  t.on = false;
  t.clock = T + 10 * QUIET;
  t.reply = { id: "r1", text: "x" };
  await x.tick();
  expect([t.alerts, out(), x.live()]).toEqual([[], [], false]);
});

test("waitOut: the texts at once when there are some, none after the wait", async () => {
  const { x } = setup();
  const t0 = Date.now();
  expect(await x.waitOut(300)).toEqual([]);
  expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
  await x.receive({ id: "g1", from: "+15550000000", text: "", picture: true });
  const [o] = await x.waitOut(5000);
  expect(o.text).toBe(PICTURE_ONLY);
  expect(Object.keys(o).sort()).toEqual(["id", "text"]);
});

test("turning texting on after a long off spell doesn't alert at once: the quiet counts from when it was turned on", async () => {
  const { t, x } = setup();
  t.on = false;
  for (let i = 0; i <= 10; i++) {
    t.clock = T + i * QUIET;
    await x.tick();
  }
  t.on = true;
  t.clock = T + 10 * QUIET;
  await x.tick();
  expect(t.alerts).toEqual([]);
  t.clock = T + 11 * QUIET;
  await x.tick();
  expect(t.alerts).toEqual([OFFLINE]);
  await x.tick();
  expect(t.alerts).toEqual([OFFLINE]);
});
