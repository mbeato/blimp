import { expect, test } from "bun:test";
import type { Conversation, Note, Session } from "./api";
import { askedWords, inbox, needsYou } from "./inbox";

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

test("work still going on is under Working, the longest-running first; a turn done mid-way, even unread, is with the other sessions", () => {
  const r = inbox(
    [
      s("busy", { state: "working", unread: true, updatedAt: 9000, stateSince: 5000, note: note("done", "released") }),
      s("older", { state: "working", updatedAt: 9500, stateSince: 2000 }),
      s("part", { unread: true, note: note("progress", "fixing a flaky test") }),
    ],
    [],
  );
  expect(lines(r)).toEqual({ waiting: [], done: [] });
  expect(r.working.map((l) => l.id)).toEqual(["session-older", "session-busy"]);
  expect(r.working.map((l) => l.since)).toEqual([2000, 5000]);
  expect(r.other.map((l) => l.id)).toEqual(["session-part"]);
  expect(Object.keys(r)).toEqual(["waiting", "done", "working", "other"]);
});

test("shells, runs and sessions already read are the other sessions, newest first", () => {
  const r = inbox([s("read", { unread: false, updatedAt: 2000 }), s("sh", { kind: "shell", sessionId: undefined, state: "unknown", updatedAt: 3000 })], []);
  expect(r.other.map((l) => l.id)).toEqual(["session-sh", "session-read"]);
  expect(r.other.map((l) => l.words)).toEqual([undefined, undefined]);
});

test("needs you: the project's waiting sessions, oldest wait first, with its past questions; not another project's", () => {
  const yes = { kind: "permission" as const, summary: "Ran `ls`" };
  const r = needsYou(
    "/p",
    [
      s("new", { state: "waiting", stateSince: 9000, updatedAt: 9000, prompt: yes }),
      s("far", { dir: "/q", state: "waiting", stateSince: 2000, updatedAt: 2000, prompt: yes }),
      s("asks", { stateSince: 5000, updatedAt: 5000, note: note("question", "ship it?") }),
      s("away", { dir: "/q", stateSince: 1000, updatedAt: 1000, note: note("question", "which one?") }),
      s("busy", { state: "working", stateSince: 1000 }),
    ],
    [c("c1", { unread: true, updatedAt: 4000, note: note("question", "which?") }), c("c2", { unread: true, updatedAt: 3000, note: note("done", "x") })],
  );
  expect(r.map((l) => l.id)).toEqual(["past-c1", "session-asks", "session-new"]);
  expect(r.map((l) => l.words)).toEqual(["which?", "ship it?", "Ran `ls`"]);
});

test("done: a session done and unread, with its note; once seen it's gone", () => {
  const r = inbox([s("new", { unread: true, note: note("done", "v0.2.16 out") }), s("read", { unread: false, note: note("done", "x") }), s("bare", { unread: true })], []);
  expect(lines(r).done).toEqual(["NEW: v0.2.16 out", "BARE: "]);
});

test("earlier conversations: only unread ones, under the heading their note gives (done without one; not one still in progress)", () => {
  const r = inbox([], [c("a", { unread: true, note: note("done", "fixed") }), c("b", { unread: true, note: note("progress", "half way") }), c("q", { unread: true, note: note("question", "which?") }), c("d", { unread: false, note: note("done", "x") }), c("e", { unread: true })]);
  expect(lines(r)).toEqual({ waiting: ["Q: which?"], done: ["A: fixed", "E: "] });
  expect(r.done[0].conversation?.sessionId).toBe("a");
  expect(r.done[0].session).toBeUndefined();
});

test("newest activity first within a heading; shells and idle read sessions don't show", () => {
  const r = inbox(
    [s("old", { unread: true, updatedAt: 100 }), s("newer", { unread: true, updatedAt: 900 }), s("sh", { kind: "shell", sessionId: undefined, state: "unknown" })],
    [c("mid", { unread: true, updatedAt: 500 })],
  );
  expect(r.done.map((l) => l.id)).toEqual(["session-newer", "past-mid", "session-old"]);
  expect(r.waiting.length).toBe(0);
});

test("askedWords", () => {
  expect(askedWords({ kind: "permission", summary: "Edited a.ts" })).toBe("Edited a.ts");
  expect(askedWords({ kind: "question", questions: [{ question: "A?" }, { question: "B?" }] })).toBe("A?");
  expect(askedWords({ kind: "other" })).toBeUndefined();
  expect(askedWords(undefined)).toBeUndefined();
});
