// What the phone's widgets show (src/widget.ts): every running session outside the hidden projects, by the inbox's
// rules, and the widget key.

import { expect, test } from "bun:test";
import type { Session } from "../src/sessions";
import { MAX_ROWS, widgetKey, widgetShape, widgetSummary } from "../src/widget";

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
  unread: false,
  ...o,
});
const order = (sessions: Session[], hidden: string[] = []) =>
  widgetSummary(sessions, new Set(hidden), T).rows.map((r) => [r.session, r.state]);

test("needs you: a waiting session, and a done one with a question in its note, the oldest wait first", () => {
  const late = s("late", { state: "waiting", stateSince: T - 1000 });
  const asks = s("asks", { stateSince: T - 5000, note: { status: "question", text: "Which one?", at: T } });
  expect(order([late, asks])).toEqual([["asks", "needs"], ["late", "needs"]]);
  expect(widgetSummary([late, asks], new Set(), T).counts).toEqual({ needs: 2, new: 0, working: 0 });
});

test("new: done and unread, the newest first; one still in progress by its note, or read, isn't", () => {
  const old = s("old", { unread: true, updatedAt: T - 9000 });
  const recent = s("recent", { unread: true, updatedAt: T - 1000 });
  const midway = s("midway", { unread: true, note: { status: "progress", text: "Halfway", at: T } });
  const read = s("read");
  expect(order([old, recent, midway, read])).toEqual([["recent", "new"], ["old", "new"]]);
});

test("working: the longest-running first, after needs you and new", () => {
  const short = s("short", { state: "working", stateSince: T - 60_000 });
  const long = s("long", { state: "working", stateSince: T - 3_000_000 });
  const ask = s("ask", { state: "waiting", stateSince: T });
  const fresh = s("fresh", { unread: true });
  expect(order([short, long, ask, fresh])).toEqual([["ask", "needs"], ["fresh", "new"], ["long", "working"], ["short", "working"]]);
});

test("every project's sessions, the hidden projects' left out", () => {
  const a = s("a", { dir: "/u/cq", state: "working", stateSince: T - 5000 });
  const b = s("b", { dir: "/u/blimp", state: "working", stateSince: T - 9000 });
  const secret = s("secret", { dir: "/u/secret", state: "waiting" });
  expect(order([a, b, secret], ["/u/secret"])).toEqual([["b", "working"], ["a", "working"]]);
  expect(widgetSummary([a, b, secret], new Set(["/u/secret"]), T).counts).toEqual({ needs: 0, new: 0, working: 2 });
});

test("at most 9 rows; the counts count them all", () => {
  const many = Array.from({ length: 12 }, (_, i) => s(`w${i}`, { state: "working", stateSince: T - i }));
  const w = widgetSummary(many, new Set(), T);
  expect(w.rows.length).toBe(MAX_ROWS);
  expect(MAX_ROWS).toBe(9);
  expect(w.counts.working).toBe(12);
});

test("a row's since: when it started waiting or working, else its newest activity", () => {
  const w = widgetSummary([s("a", { state: "working", stateSince: T - 7000 }), s("b", { unread: true, updatedAt: T - 3000 })], new Set(), T);
  expect(w.rows.map((r) => r.since)).toEqual([T - 3000, T - 7000]);
  expect(w.rows[0]).toEqual({ session: "b", dir: "/u/blimp", title: "b", state: "new", since: T - 3000 });
  expect(w.at).toBe(T);
});

test("lastFinished: when the last done session finished; none with none done", () => {
  expect(widgetSummary([s("a", { stateSince: T - 9000 }), s("b", { stateSince: T - 2000 })], new Set(), T).lastFinished).toBe(T - 2000);
  expect("lastFinished" in widgetSummary([s("a", { state: "working" })], new Set(), T)).toBe(false);
});

test("the shape changes with the counts and the rows' states, not with a working row's time", () => {
  const shape = (o: Partial<Session>) => widgetShape(widgetSummary([s("a", { state: "working", ...o })], new Set(), T));
  expect(shape({ stateSince: T - 1000, updatedAt: T })).toBe(shape({ stateSince: T - 1000, updatedAt: T - 500 }));
  expect(shape({})).not.toBe(shape({ state: "waiting" }));
});

test("the widget key: HMAC-SHA256 of the phone's token with the text 'blimp widget', hex; none without a token", () => {
  expect(widgetKey("abc")).toBe("7a0a9292d52985672c308670910039f0f48e762e6393d92d5a1233f6762c52ff");
  expect(widgetKey("abd")).not.toBe(widgetKey("abc"));
  expect(widgetKey("")).toBe("");
});
