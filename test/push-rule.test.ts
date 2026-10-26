// When blimpd tells the phone (src/push/rule.ts): lists of sessions one after another, and what each step tells.

import { expect, test } from "bun:test";
import { ASK_SETTLE, dueAt, FINISH_MIN, HOLD, type PushEvent, type PushSession, pushChanges, stillDue, UPDATE_SLACK } from "../src/push/rule";

const T = 1_800_000_000_000;
const claude = (name: string, state: PushSession["state"], stateSince: number, prompt?: { at: number }) =>
  ({ name, kind: "claude", state, stateSince, ...(prompt && { prompt: { kind: "other", answerable: false, ...prompt } }) }) as PushSession;
const codex = (state: PushSession["state"], stateSince: number) => ({ name: "c", kind: "codex", state, stateSince }) as PushSession;

// From a blimpd that already saw `first` (at T), each step's list at its time, and the events each step gives.
function run(first: PushSession[], steps: [number, PushSession[]][]): PushEvent[][] {
  let seen = pushChanges(undefined, first, T).seen;
  return steps.map(([now, list]) => {
    const r = pushChanges(seen, list, now);
    seen = r.seen;
    return r.events;
  });
}

test("what blimpd finds first counts as seen: nothing for a wait or a finish already there", () => {
  const waiting = claude("a", "waiting", T - 60_000, { at: T - 60_000 });
  expect(pushChanges(undefined, [waiting, claude("b", "done", T - 5000)], T).events).toEqual([]);
  expect(run([waiting], [[T + 1000, [waiting]]])).toEqual([[]]);
});

test("a wait is told once, when it has lasted 3 s", () => {
  const w = claude("a", "waiting", T, { at: T });
  expect(run([claude("a", "working", T - 10_000)], [[T + 1000, [w]], [T + ASK_SETTLE, [w]], [T + ASK_SETTLE + 1000, [w]]])).toEqual([
    [],
    [{ kind: "ask", session: "a", key: T }],
    [],
  ]);
});

test("a wait answered within 3 s isn't told", () => {
  expect(
    run([claude("a", "working", T - 10_000)], [
      [T + 1000, [claude("a", "waiting", T, { at: T })]],
      [T + 2000, [claude("a", "working", T + 1500)]],
      [T + 5000, [claude("a", "working", T + 1500)]],
    ]),
  ).toEqual([[], [], []]);
});

test("a new wait in the same session is told again, and a new session that's already waiting is told too", () => {
  const old = claude("a", "waiting", T - 9000, { at: T - 9000 });
  const next = claude("a", "waiting", T - 9000, { at: T });
  expect(
    run([old], [
      [T, [old]],
      [T + 5000, [next]],
      [T + 6000, [next, claude("b", "waiting", T, { at: T })]],
    ]),
  ).toEqual([[], [{ kind: "ask", session: "a", key: T }], [{ kind: "ask", session: "b", key: T }]]);
});

test("a wait without a question (Codex) is keyed by when its state began; Codex never finishes", () => {
  expect(
    run([codex("working", T - 60_000)], [
      [T + 3000, [codex("waiting", T)]],
      [T + 4000, [codex("working", T + 3500)]],
      [T + 100_000, [codex("done", T + 99_000)]],
    ]),
  ).toEqual([[{ kind: "ask", session: "c", key: T }], [], []]);
});

test("a Claude turn of 30 s or more that ends is told once; one of 29 s isn't", () => {
  expect(run([claude("a", "done", T - 1000)], [[T, [claude("a", "working", T)]], [T + 29_000, [claude("a", "done", T + 29_000)]]])).toEqual([[], []]);
  expect(
    run([claude("a", "done", T - 1000)], [
      [T, [claude("a", "working", T)]],
      [T + FINISH_MIN, [claude("a", "done", T + FINISH_MIN)]],
      [T + FINISH_MIN + 1000, [claude("a", "done", T + FINISH_MIN)]],
    ]),
  ).toEqual([[], [{ kind: "finish", session: "a", key: T + FINISH_MIN }], []]);
});

test("a turn goes on through its waits: 10 s of work, a question, then more work to 31 s is a 31 s turn", () => {
  const q = claude("a", "waiting", T + 10_000, { at: T + 10_000 });
  expect(
    run([claude("a", "done", T - 1000)], [
      [T, [claude("a", "working", T)]],
      [T + 10_000, [q]],
      [T + 14_000, [q]],
      [T + 15_000, [claude("a", "working", T + 15_000)]],
      [T + 31_000, [claude("a", "done", T + 31_000)]],
    ]),
  ).toEqual([[], [], [{ kind: "ask", session: "a", key: T + 10_000 }], [], [{ kind: "finish", session: "a", key: T + 31_000 }]]);
});

test("a turn that starts after a finish is timed from its own start", () => {
  expect(
    run([claude("a", "working", T - 60_000)], [
      [T, [claude("a", "done", T)]],
      [T + 1000, [claude("a", "working", T + 1000)]],
      [T + 11_000, [claude("a", "done", T + 11_000)]],
    ]),
  ).toEqual([[{ kind: "finish", session: "a", key: T }], [], []]);
});

test("a held one still goes only if nothing changed: the same wait, or still done from the same turn", () => {
  const ask: PushEvent = { kind: "ask", session: "a", key: T };
  expect(stillDue(ask, [claude("a", "waiting", T, { at: T })])).toBe(true);
  expect(stillDue(ask, [claude("a", "working", T + 5000)])).toBe(false);
  expect(stillDue(ask, [claude("a", "waiting", T, { at: T + 9000 })])).toBe(false);
  expect(stillDue(ask, [])).toBe(false);
  const fin: PushEvent = { kind: "finish", session: "a", key: T };
  expect(stillDue(fin, [claude("a", "done", T)])).toBe(true);
  expect(stillDue(fin, [claude("a", "working", T + 1000)])).toBe(false);
});

test("while the Mac was in use in the last 2 minutes, a notification waits until 2 minutes after that", () => {
  expect(dueAt(T, 0)).toBe(T);
  expect(dueAt(T, T - 30_000)).toBe(T - 30_000 + HOLD);
  expect(dueAt(T, T - HOLD)).toBe(T);
});

test("while the assistant runs, a job's finish isn't told: the assistant tells it; with no assistant, it is", () => {
  const job = (state: PushSession["state"], since: number) => ({ ...claude("j", state, since), job: { reason: "fix CI", at: T - 60_000 } }) as PushSession;
  const assistant = { ...claude("assistant", "done", T - 60_000), assistant: true } as PushSession;
  const turn = (others: PushSession[]) => run([job("working", T - 60_000), ...others], [[T + 1000, [job("done", T + 1000), ...others]]]);
  expect(turn([assistant])).toEqual([[]]);
  expect(turn([])).toEqual([[{ kind: "finish", session: "j", key: T + 1000 }]]);
  // With the assistant switched off its stand-in tells nothing, so the finish is told.
  const off = (others: PushSession[]) => {
    const seen = pushChanges(undefined, [job("working", T - 60_000), ...others], T).seen;
    return pushChanges(seen, [job("done", T + 1000), ...others], T + 1000, undefined, false).events;
  };
  expect(off([assistant])).toEqual([{ kind: "finish", session: "j", key: T + 1000 }]);
  // A job's wait is still told while the assistant runs.
  const wait = job("waiting", T + 1000) as PushSession;
  expect(run([job("working", T - 60_000), assistant], [[T + 1000 + ASK_SETTLE, [{ ...wait, prompt: { kind: "other", answerable: false, at: T + 1000 } } as PushSession, assistant]]])).toEqual([[{ kind: "ask", session: "j", key: T + 1000 }]]);
});

test("the assistant's turn that a job update began is told however short; its other short turns aren't", () => {
  const a = (state: PushSession["state"], since: number) => ({ ...claude("assistant", state, since), assistant: true }) as PushSession;
  const short = (updated?: number) => {
    let seen = pushChanges(undefined, [a("done", T - 60_000)], T).seen;
    seen = pushChanges(seen, [a("working", T + 1000)], T + 1000, updated).seen;
    return pushChanges(seen, [a("done", T + 5000)], T + 5000, updated).events;
  };
  expect(short(T + 500)).toEqual([{ kind: "finish", session: "assistant", key: T + 5000 }]);
  expect(short(T + 1000 - UPDATE_SLACK)).toEqual([{ kind: "finish", session: "assistant", key: T + 5000 }]);
  expect(short(T + 1000 - UPDATE_SLACK - 1)).toEqual([]);
  expect(short(T + 6000)).toEqual([]);
  expect(short(undefined)).toEqual([]);
});

test("while texting is live, the assistant's own questions and finishes aren't pushed (the texts tell them); a job's question still is", () => {
  const a = (state: PushSession["state"], since: number, prompt?: { at: number }) => ({ ...claude("assistant", state, since, prompt), assistant: true }) as PushSession;
  const step = (before: PushSession[], after: PushSession[], at: number, texting: boolean) => pushChanges(pushChanges(undefined, before, T).seen, after, at, undefined, true, texting).events;
  const working = a("working", T - 60_000);
  const asking = a("waiting", T + 1000, { at: T + 1000 });
  expect(step([working], [asking], T + 1000 + ASK_SETTLE, false)).toEqual([{ kind: "ask", session: "assistant", key: T + 1000 }]);
  expect(step([working], [asking], T + 1000 + ASK_SETTLE, true)).toEqual([]);
  const done = a("done", T + FINISH_MIN);
  expect(step([working], [done], T + FINISH_MIN, false)).toEqual([{ kind: "finish", session: "assistant", key: T + FINISH_MIN }]);
  expect(step([working], [done], T + FINISH_MIN, true)).toEqual([]);
  const job = (s: PushSession) => ({ ...s, job: { reason: "fix CI", at: T - 120_000 } }) as PushSession;
  expect(step([working, job(claude("j", "working", T - 60_000))], [working, job(claude("j", "waiting", T + 1000, { at: T + 1000 }))], T + 1000 + ASK_SETTLE, true)).toEqual([{ kind: "ask", session: "j", key: T + 1000 }]);
});
