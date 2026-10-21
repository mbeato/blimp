import { expect, test } from "bun:test";
import type { Job, Session } from "./api";
import { duration, jobNotice, jobState, jobsWords, JobWatcher, viewingList } from "./jobs";

const MIN = 60_000;
const NOW = 1_000_000_000;

const j = (id: string, extra: Partial<Job> = {}): Job => ({ id, kind: "bash", label: `Job ${id}`, startedAt: NOW - 5 * MIN, status: "running", ...extra });

const s = (name: string, jobs?: Job[], extra: Partial<Session> = {}): Session => ({
  name,
  kind: "claude",
  pid: 1,
  clients: 0,
  created: 1,
  dir: "/home/u/proj",
  cmd: "claude",
  title: `Title ${name}`,
  status: "",
  state: "working",
  ...(jobs && { jobs }),
  ...extra,
});

test("a session without jobs says nothing about them", () => {
  expect(jobsWords(undefined, NOW)).toBe("");
  expect(jobsWords([], NOW)).toBe("");
});

test("the row counts the jobs that still run", () => {
  expect(jobsWords([j("a")], NOW)).toBe("1 job");
  expect(jobsWords([j("a"), j("b"), j("c", { status: "done", endedAt: NOW - MIN })], NOW)).toBe("2 jobs");
});

test("with none running, a job that finished in the last 30 minutes shows as job done", () => {
  expect(jobsWords([j("a", { status: "done", endedAt: NOW - 29 * MIN, exit: 0 })], NOW)).toBe("job done");
  expect(jobsWords([j("a", { status: "failed", endedAt: NOW - MIN, exit: 1 })], NOW)).toBe("job done");
});

test("a job that finished over 30 minutes ago, or was stopped, isn't mentioned", () => {
  expect(jobsWords([j("a", { status: "done", endedAt: NOW - 31 * MIN })], NOW)).toBe("");
  expect(jobsWords([j("a", { status: "stopped", endedAt: NOW - MIN })], NOW)).toBe("");
});

test("how long a job has run reads as minutes, then hours and minutes, then days", () => {
  expect(duration(20_000)).toBe("<1m");
  expect(duration(12 * MIN + 59_000)).toBe("12m");
  expect(duration(65 * MIN)).toBe("1h 5m");
  expect(duration(2 * 60 * MIN)).toBe("2h");
  expect(duration(50 * 60 * MIN)).toBe("2d");
});

test("a job's state: its running time, or how it ended with its exit code", () => {
  expect(jobState(j("a", { startedAt: NOW - 12 * MIN }), NOW)).toBe("12m");
  expect(jobState(j("a", { status: "done", exit: 0 }), NOW)).toBe("done · exit 0");
  expect(jobState(j("a", { status: "done" }), NOW)).toBe("done");
  expect(jobState(j("a", { status: "failed", exit: 1 }), NOW)).toBe("failed · exit 1");
  expect(jobState(j("a", { status: "failed" }), NOW)).toBe("failed");
  expect(jobState(j("a", { status: "stopped" }), NOW)).toBe("stopped");
});

test("the notice for a finished job names it, says how it ended, and the session and folder", () => {
  const t = s("a");
  expect(jobNotice(j("x", { label: "Run the build", status: "done", exit: 0 }), t, "/home/u")).toEqual({ title: "Run the build finished", body: "Title a · ~/proj" });
  expect(jobNotice(j("x", { label: "Run the build", status: "failed", exit: 2 }), t, "/home/u")).toEqual({ title: "Run the build failed, exit 2", body: "Title a · ~/proj" });
  expect(jobNotice(j("x", { label: "Run the build", status: "failed" }), t, "/home/u").title).toBe("Run the build failed");
});

function setup(open: string | null = null) {
  const calls: { title: string; body: string; id: { session: string; wait: string } }[] = [];
  const w = new JobWatcher((title, body, id) => calls.push({ title, body, id }), (session) => session === open);
  return { w, calls };
}

test("no notification on the first list, even for jobs that already finished", () => {
  const { w, calls } = setup();
  w.update("srv", "/home/u", [s("a", [j("x", { status: "done", endedAt: NOW, exit: 0 })])]);
  expect(calls).toEqual([]);
});

test("a job that goes from running to done notifies once, keyed by server, session, job and end", () => {
  const { w, calls } = setup();
  w.update("srv", "/home/u", [s("a", [j("x")])]);
  w.update("srv", "/home/u", [s("a", [j("x", { status: "done", endedAt: NOW, exit: 0 })])]);
  w.update("srv", "/home/u", [s("a", [j("x", { status: "done", endedAt: NOW, exit: 0 })])]);
  expect(calls).toEqual([{ title: "Job x finished", body: "Title a · ~/proj", id: { session: "jobs:srv/a", wait: `srv/a/x/${NOW}` } }]);
});

test("a job that fails notifies with its exit code", () => {
  const { w, calls } = setup();
  w.update("srv", "/home/u", [s("a", [j("x")])]);
  w.update("srv", "/home/u", [s("a", [j("x", { status: "failed", endedAt: NOW, exit: 1 })])]);
  expect(calls.map((c) => c.title)).toEqual(["Job x failed, exit 1"]);
});

test("a stopped job, a job that ends in a session that went away, or one first seen finished, doesn't notify", () => {
  const { w, calls } = setup();
  w.update("srv", "/home/u", [s("a", [j("x"), j("y")])]);
  w.update("srv", "/home/u", [s("a", [j("x", { status: "stopped", endedAt: NOW }), j("y"), j("z", { status: "done", endedAt: NOW })])]);
  w.update("srv", "/home/u", []);
  expect(calls).toEqual([]);
});

test("an agent that finishes, goes on and finishes again notifies each time", () => {
  const { w, calls } = setup();
  w.update("srv", "/home/u", [s("a", [j("x", { kind: "agent" })])]);
  w.update("srv", "/home/u", [s("a", [j("x", { kind: "agent", status: "done", endedAt: NOW })])]);
  w.update("srv", "/home/u", [s("a", [j("x", { kind: "agent" })])]);
  w.update("srv", "/home/u", [s("a", [j("x", { kind: "agent", status: "done", endedAt: NOW + MIN })])]);
  expect(calls.map((c) => c.id.wait)).toEqual([`srv/a/x/${NOW}`, `srv/a/x/${NOW + MIN}`]);
});

test("servers are followed apart: one server's first list isn't another's", () => {
  const { w, calls } = setup();
  w.update("one", "/home/u", [s("a", [j("x")])]);
  w.update("two", "/home/u", [s("a", [j("x", { status: "done", endedAt: NOW })])]);
  expect(calls).toEqual([]);
});

test("no notification while this window has focus and shows that session's jobs", () => {
  const { w, calls } = setup("srv/a");
  w.update("srv", "/home/u", [s("a", [j("x")]), s("b", [j("y")])]);
  w.update("srv", "/home/u", [s("a", [j("x", { status: "done", endedAt: NOW })]), s("b", [j("y", { status: "done", endedAt: NOW })])]);
  expect(calls.map((c) => c.id.wait)).toEqual([`srv/b/y/${NOW}`]);
});

test("with two windows, a job whose list is open in the focused one notifies from neither", () => {
  // claim_notice (windows.rs): no if a focused window's list has id.session, else once per id.wait.
  const viewing = new Map<string, string[]>();
  const noticed = new Set<string>();
  const shown: string[] = [];
  const claim = (id: { session: string; wait: string }) =>
    ![...viewing.values()].some((v) => v.includes(id.session)) && !noticed.has(id.wait) && !!noticed.add(id.wait);
  // Window A has focus, shows srv/a and has its jobs open; window B shows nothing (no focus).
  viewing.set("A", viewingList(["srv/a"], "srv/a"));
  const a = new JobWatcher((title, _b, id) => claim(id) && shown.push(title), (session) => session === "srv/a");
  const b = new JobWatcher((title, _b, id) => claim(id) && shown.push(title), () => false);
  const both = (sessions: Session[]) => [a, b].forEach((w) => w.update("srv", "/home/u", sessions));
  both([s("a", [j("x"), j("y")])]);
  both([s("a", [j("x", { status: "done", endedAt: NOW }), j("y")])]);
  expect(shown).toEqual([]);
  // A closes the jobs list: the next one that ends is announced, once.
  viewing.set("A", viewingList(["srv/a"], null));
  both([s("a", [j("x", { status: "done", endedAt: NOW }), j("y", { status: "done", endedAt: NOW })])]);
  expect(shown).toEqual(["Job y finished"]);
});
