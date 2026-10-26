import { expect, test } from "bun:test";
import type { Note, Session } from "./api";
import { jobCounts, jobRows } from "./assistant";

// The same cases as the phone's (ios/BlimpKit/Tests/BlimpKitTests/AssistantJobsTests.swift).

const s = (name: string, extra: Partial<Session> = {}): Session => ({
  name,
  kind: "claude",
  pid: 1,
  clients: 0,
  created: 1,
  dir: "/h/web",
  cmd: "claude",
  sessionId: name + "-id",
  title: name.toUpperCase(),
  status: "idle",
  state: "done",
  updatedAt: 1000,
  ...extra,
});
const job = (reason: string) => ({ job: { reason, at: 1 } });
const note = (status: Note["status"], text: string): Note => ({ status, text, at: 1 });
const lines = (sessions: Session[]) => jobRows(sessions).map((r) => `${r.session.name} ${r.bucket} ${r.project} · ${r.reason}: ${r.words ?? ""}`);

test("each job is in one bucket: needs you, working or done; the rest aren't shown", () => {
  expect(
    lines([
      s("wait", { ...job("run the tests"), dir: "/h/api", state: "waiting", stateSince: 3000, updatedAt: 3000, prompt: { kind: "permission", summary: "Ran `bun test`" } }),
      s("ask", { ...job("ship it"), stateSince: 1000, updatedAt: 1000, note: note("question", "ship v0.2.16?") }),
      s("work", { ...job("fix CI"), state: "working", stateSince: 2000, updatedAt: 2500, note: note("done", "an earlier turn") }),
      s("prog", { ...job("the docs"), stateSince: 1500, updatedAt: 1500, unread: true, note: note("progress", "half the pages done") }),
      s("fin", { ...job("release"), updatedAt: 4000, unread: true, note: note("done", "released v0.2.16") }),
      s("fin2", { ...job("tidy"), updatedAt: 6000, unread: true }),
      s("read", { ...job("old"), updatedAt: 7000, unread: false, note: note("done", "read already") }),
      s("plain", { state: "waiting", updatedAt: 500 }),
      s("idle", { ...job("shell"), state: "unknown", updatedAt: 8000 }),
    ]),
  ).toEqual([
    "ask needs web · ship it: ship v0.2.16?",
    "wait needs api · run the tests: Ran `bun test`",
    "prog working web · the docs: half the pages done",
    "work working web · fix CI: ",
    "fin2 done web · tidy: ",
    "fin done web · release: released v0.2.16",
  ]);
});

test("the counts line leaves out empty buckets; no job to show, no line", () => {
  const rows = jobRows([
    s("a", { ...job("x"), state: "waiting" }),
    s("b", { ...job("y"), state: "working" }),
    s("c", { ...job("z"), state: "working" }),
    s("d", { ...job("w"), unread: true }),
  ]);
  expect(jobCounts(rows)).toBe("1 needs you · 2 working · 1 done");
  expect(jobCounts(jobRows([s("b", { ...job("y"), state: "working" })]))).toBe("1 working");
  expect(jobCounts(jobRows([s("e", { state: "waiting" })]))).toBe("");
});
