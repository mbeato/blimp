// When blimpd tells the phone (src/push/rule.ts): lists of sessions one after another, and what each step tells.

import { expect, test } from "bun:test";
import { ASK_SETTLE, dueAt, FINISH_MIN, HOLD, type PushEvent, type PushSession, pushChanges, stillDue } from "../src/push/rule";

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
