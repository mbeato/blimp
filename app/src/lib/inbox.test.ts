import { expect, test } from "bun:test";
import type { Conversation, Note, Session } from "./api";
import { askedWords, inbox } from "./inbox";

const s = (name: string, extra: Partial<Session> = {}): Session => ({
  name,
  kind: "claude",
  pid: 1,
  clients: 0,
  created: 1,
  dir: "/p",
  cmd: "claude",
  sessionId: name + "-id",
  title: name.toUpperCase(),
  status: "idle",
  state: "done",
  updatedAt: 1000,
  ...extra,
});
const c = (id: string, extra: Partial<Conversation> = {}): Conversation => ({ sessionId: id, title: id.toUpperCase(), updatedAt: 500, ...extra });
const note = (status: Note["status"], text: string): Note => ({ status, text, at: 1 });
const lines = (r: ReturnType<typeof inbox>) => ({
  waiting: r.waiting.map((l) => `${l.title}: ${l.words ?? ""}`),
  progress: r.progress.map((l) => `${l.title}: ${l.words ?? ""}`),
  done: r.done.map((l) => `${l.title}: ${l.words ?? ""}`),
});

test("waiting on you: a session that waits, with what it asks; or one done with a question in its note", () => {
  const r = inbox(
    [
      s("perm", { state: "waiting", prompt: { kind: "permission", summary: "Ran `bun test`" }, note: note("done", "old") }),
      s("ask", { state: "waiting", prompt: { kind: "question", questions: [{ question: "Which layout?" }] } }),
      s("other", { state: "waiting", prompt: { kind: "other" }, note: note("question", "release it?") }),
      s("prose", { state: "done", note: note("question", "ship v0.2.16?") }),
    ],
    [],
  );
  expect(lines(r).waiting).toEqual(["PERM: Ran `bun test`", "ASK: Which layout?", "OTHER: release it?", "PROSE: ship v0.2.16?"]);
});

test("in progress: working (no words: its note is about the turn before), or done with a progress note", () => {
  const r = inbox([s("busy", { state: "working", note: note("done", "released") }), s("part", { note: note("progress", "fixing a flaky test") })], []);
  expect(lines(r).progress).toEqual(["BUSY: ", "PART: fixing a flaky test"]);
});

test("done: a session done and unread, with its note; once seen it's gone", () => {
  const r = inbox([s("new", { unread: true, note: note("done", "v0.2.16 out") }), s("read", { unread: false, note: note("done", "x") }), s("bare", { unread: true })], []);
  expect(lines(r).done).toEqual(["NEW: v0.2.16 out", "BARE: "]);
});

test("earlier conversations: only unread ones, under the heading their note gives (done without one)", () => {
  const r = inbox([], [c("a", { unread: true, note: note("done", "fixed") }), c("b", { unread: true, note: note("progress", "half way") }), c("q", { unread: true, note: note("question", "which?") }), c("d", { unread: false, note: note("done", "x") }), c("e", { unread: true })]);
  expect(lines(r)).toEqual({ waiting: ["Q: which?"], progress: ["B: half way"], done: ["A: fixed", "E: "] });
  expect(r.done[0].conversation?.sessionId).toBe("a");
  expect(r.done[0].session).toBeUndefined();
});

test("newest activity first within a heading; shells and idle read sessions don't show", () => {
  const r = inbox(
    [s("old", { unread: true, updatedAt: 100 }), s("newer", { unread: true, updatedAt: 900 }), s("sh", { kind: "shell", sessionId: undefined, state: "unknown" })],
    [c("mid", { unread: true, updatedAt: 500 })],
  );
  expect(r.done.map((l) => l.id)).toEqual(["session-newer", "past-mid", "session-old"]);
  expect(r.waiting.length + r.progress.length).toBe(0);
});

test("askedWords", () => {
  expect(askedWords({ kind: "permission", summary: "Edited a.ts" })).toBe("Edited a.ts");
  expect(askedWords({ kind: "question", questions: [{ question: "A?" }, { question: "B?" }] })).toBe("A?");
  expect(askedWords({ kind: "other" })).toBeUndefined();
  expect(askedWords(undefined)).toBeUndefined();
});
