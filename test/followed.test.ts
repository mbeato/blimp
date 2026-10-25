// The followed turn (src/followed.ts): the session last sent a prompt from the phone, until that turn ends.

import { beforeEach, expect, test } from "bun:test";
import { clearFollowed, followed, markFollowed, START_GRACE } from "../src/followed";
import type { Session } from "../src/sessions";

const T = 1_800_000_000_000;
const s = (name: string, o: Partial<Session> = {}): Session => ({
  name,
  pid: 1,
  clients: 0,
  created: (T - 3_600_000) / 1000,
  dir: "/u/blimp",
  cmd: "claude",
  kind: "claude",
  title: name,
  status: "idle",
  state: "done",
  stateSince: T - 60_000,
  unread: false,
  ...o,
});

beforeEach(clearFollowed);

test("none until a prompt goes in from the phone", () => {
  expect(followed([s("a")], T)).toBeUndefined();
});

test("the session and when its prompt went in, while it works and while it waits on you", () => {
  markFollowed("a", T);
  expect(followed([s("a")], T + 1000)?.at).toBe(T); // Claude hasn't started yet
  const working = s("a", { state: "working", stateSince: T + 500 });
  expect(followed([working, s("b")], T + 2000)?.session).toBe(working);
  expect(followed([s("a", { state: "waiting", stateSince: T + 9000 })], T + 10_000)?.session.name).toBe("a");
});

test("it ends when the session is done since the prompt, and stays ended", () => {
  markFollowed("a", T);
  expect(followed([s("a", { state: "done", stateSince: T + 60_000 })], T + 61_000)).toBeUndefined();
  expect(followed([s("a", { state: "working", stateSince: T + 70_000 })], T + 71_000)).toBeUndefined();
});

test("it ends when the session is gone; an empty list (a failed zmx list) keeps it", () => {
  markFollowed("a", T);
  expect(followed([], T + 1000)).toBeUndefined();
  expect(followed([s("a")], T + 1000)?.session.name).toBe("a");
  expect(followed([s("b")], T + 2000)).toBeUndefined();
  expect(followed([s("a")], T + 3000)).toBeUndefined();
});

test("a turn that hasn't started 2 minutes on ends", () => {
  markFollowed("a", T);
  expect(followed([s("a")], T + START_GRACE - 1)?.session.name).toBe("a");
  expect(followed([s("a")], T + START_GRACE)).toBeUndefined();
});

test("the newest prompt from the phone is the followed one", () => {
  markFollowed("a", T);
  markFollowed("b", T + 1000);
  const list = [s("a", { state: "working" }), s("b", { state: "working" })];
  expect(followed(list, T + 2000)?.session.name).toBe("b");
});
