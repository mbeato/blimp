// The assistant's job updates (src/reports.ts): which ended turns become lines, their words, and the loop that batches
// them for 10 s and types them into the assistant.

import { describe, expect, test } from "bun:test";
import type { Jobs } from "../src/jobs";
import type { ShownNote } from "../src/notes";
import { asks } from "../src/overview";
import { promptFromHook } from "../src/prompt";
import { BATCH, jobStep, NOTE_WAIT, type Pending, type ReportDeps, Reporter, reportLine } from "../src/reports";
import type { Session } from "../src/sessions";
import { Asking } from "../src/typing";

const T = 1_800_000_000_000;
const s = (name: string, o: Partial<Session> = {}): Session => ({
  name, pid: 1, clients: 0, created: (T - 3_600_000) / 1000, dir: "/u/blimp", cmd: "claude", kind: "claude",
  title: name, status: "idle", state: "working", unread: false, ...o,
});
const note = (status: ShownNote["status"], text: string, at = T): ShownNote => ({ status, text, at });
const prompt = { ...promptFromHook({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "ls" }, cwd: "/u/blimp" })!, at: T };
const JOBS: Jobs = { "blimp-1": { reason: "fix CI", at: T - 60_000 } };

describe("reportLine", () => {
  test("project, reason and session, then what it's at and the words", () => {
    const done = s("blimp-1", { state: "done" });
    expect(reportLine(done, "fix CI", note("done", "CI green, PR 41 up"))).toBe("[blimp job update] blimp · fix CI (blimp-1): done — CI green, PR 41 up");
    expect(reportLine(done, "fix CI", note("progress", "tests half fixed"))).toBe("[blimp job update] blimp · fix CI (blimp-1): still working — tests half fixed");
    expect(reportLine(done, "fix CI", note("question", "Which branch?"))).toBe("[blimp job update] blimp · fix CI (blimp-1): needs you — Which branch?");
    expect(reportLine(done, "fix CI")).toBe("[blimp job update] blimp · fix CI (blimp-1): done");
  });

  test("a wait says what it asks, whatever the note says", () => {
    expect(reportLine(s("blimp-1", { state: "waiting", prompt }), "fix CI", note("done", "old"))).toBe(`[blimp job update] blimp · fix CI (blimp-1): needs you — ${asks(prompt)}`);
    expect(reportLine(s("blimp-1", { state: "waiting" }), "fix CI")).toBe("[blimp job update] blimp · fix CI (blimp-1): needs you");
  });
});

describe("jobStep", () => {
  const step = (list: Session[], pending: Pending[] = [], now = T, jobs = JOBS) => jobStep(jobs, list, pending, now);

  test("a turn that ended before the assistant acted, or that was already told, is nothing new", () => {
    expect(step([s("blimp-1", { state: "done", stateSince: T - 90_000 })])).toEqual({ pending: [], lines: [] });
    const told: Jobs = { "blimp-1": { reason: "fix CI", at: T - 60_000, reported: T - 1000 } };
    expect(step([s("blimp-1", { state: "done", stateSince: T - 1000 })], [], T, told)).toEqual({ pending: [], lines: [] });
  });

  test("a wait is a line at once", () => {
    const w = s("blimp-1", { state: "waiting", stateSince: T - 1000, prompt: { ...prompt, at: T - 1000 } });
    expect(step([w])).toEqual({ pending: [], lines: [{ session: "blimp-1", end: T - 1000, wait: true, text: reportLine(w, "fix CI") }] });
  });

  test("one wait is told once, though its state's start moves when Claude's own status file catches up", () => {
    const at = (since: number) => s("blimp-1", { state: "waiting", stateSince: since, prompt: { ...prompt, at: T - 1000 } });
    const first = step([at(T - 1000)]);
    expect(first.lines.map((l) => l.end)).toEqual([T - 1000]);
    const told: Jobs = { "blimp-1": { reason: "fix CI", at: T - 60_000, reported: T - 1000 } };
    expect(step([at(T + 500)], first.pending, T + 2000, told).lines).toEqual([]);
  });

  test("a finished turn waits for that turn's note, then goes with it", () => {
    const old = s("blimp-1", { state: "done", stateSince: T - 1000, note: note("done", "from before", T - 5000) });
    const first = step([old]);
    expect(first).toEqual({ pending: [{ session: "blimp-1", end: T - 1000, noticed: T }], lines: [] });
    const fresh = s("blimp-1", { state: "done", stateSince: T - 1000, note: note("done", "CI green", T + 4000) });
    expect(step([fresh], first.pending, T + 5000)).toEqual({ pending: [], lines: [{ session: "blimp-1", end: T - 1000, wait: false, text: "[blimp job update] blimp · fix CI (blimp-1): done — CI green" }] });
  });

  test("with no note after 30 s it goes without one", () => {
    const done = s("blimp-1", { state: "done", stateSince: T - 1000 });
    const first = step([done]);
    expect(step([done], first.pending, T + NOTE_WAIT - 1).lines).toEqual([]);
    expect(step([done], first.pending, T + NOTE_WAIT).lines).toEqual([{ session: "blimp-1", end: T - 1000, wait: false, text: "[blimp job update] blimp · fix CI (blimp-1): done" }]);
  });

  test("a turn the job moved on from is dropped; a session that ended, too", () => {
    const pending: Pending[] = [{ session: "blimp-1", end: T - 1000, noticed: T - 2000 }];
    expect(step([s("blimp-1", { state: "working", stateSince: T - 500 })], pending)).toEqual({ pending: [], lines: [] });
    expect(step([], pending)).toEqual({ pending: [], lines: [] });
  });

  test("sessions that aren't jobs, and the assistant, are never reported", () => {
    const jobs: Jobs = { ...JOBS, assistant: { reason: "x", at: T - 60_000 } };
    expect(step([s("api-1", { state: "waiting", stateSince: T }), s("assistant", { state: "waiting", stateSince: T })], [], T, jobs)).toEqual({ pending: [], lines: [] });
  });
});

describe("Reporter", () => {
  function setup(o: Partial<ReportDeps> = {}) {
    const t = { now: T, list: [] as Session[], jobs: JOBS as Jobs, typed: [] as string[], reported: [] as [string, number][], dropped: [] as string[][], logs: [] as string[], reads: 0 };
    const deps: ReportDeps = {
      on: () => true,
      jobs: () => t.jobs,
      sessions: async () => (t.reads++, t.list),
      // As markReported does: the next look at the jobs sees what was told.
      reported: (name, end) => {
        t.reported.push([name, end]);
        t.jobs = { ...t.jobs, [name]: { ...t.jobs[name], reported: end } };
      },
      drop: (live) => void t.dropped.push(live),
      type: async (text) => void t.typed.push(text),
      now: () => t.now,
      log: (m) => void t.logs.push(m),
      ...o,
    };
    return { t, r: new Reporter(deps) };
  }
  const assistant = (state: Session["state"] = "done") => s("assistant", { dir: "/u/.blimp/assistant", state });
  const waits = (name: string, at: number) => s(name, { state: "waiting", stateSince: at, prompt: { ...prompt, at } });

  test("off, or no jobs and nothing waiting to go: the session list isn't even read", async () => {
    const off = setup({ on: () => false });
    await off.r.tick();
    const none = setup();
    none.t.jobs = {};
    await none.r.tick();
    expect([off.t.reads, none.t.reads]).toEqual([0, 0]);
  });

  test("lines wait 10 s from the first, then go as one message; each is marked reported when it's made", async () => {
    const { t, r } = setup();
    t.jobs = { ...JOBS, "api-1": { reason: "tests", at: T - 60_000 } };
    t.list = [assistant(), waits("blimp-1", T - 1000)];
    await r.tick();
    t.now = T + 4000;
    t.list = [assistant(), waits("blimp-1", T - 1000), waits("api-1", T + 3000)];
    await r.tick();
    t.now = T + BATCH - 1;
    await r.tick();
    expect(t.typed).toEqual([]);
    expect(t.reported).toEqual([["blimp-1", T - 1000], ["api-1", T + 3000]]);
    t.now = T + BATCH;
    await r.tick();
    expect(t.typed).toEqual([[reportLine(waits("blimp-1", T - 1000), "fix CI"), reportLine(waits("api-1", T + 3000), "tests")].join("\n")]);
    expect(r.lastTyped).toBe(T + BATCH);
    expect(t.dropped.at(-1)).toEqual(["assistant", "blimp-1", "api-1"]);
  });

  test("a wait that's over before the message goes (answered elsewhere) isn't typed; it stays reported", async () => {
    const { t, r } = setup();
    t.list = [assistant(), waits("blimp-1", T - 1000)];
    await r.tick();
    t.now = T + 4000;
    t.list = [assistant(), s("blimp-1", { state: "working", stateSince: T + 3000 })];
    await r.tick();
    t.now = T + BATCH;
    await r.tick();
    expect(t.typed).toEqual([]);
    expect(t.reported).toEqual([["blimp-1", T - 1000]]);
  });

  test("held while the assistant asks something or isn't running, and while typing says it's asking", async () => {
    const { t, r } = setup();
    t.list = [assistant("waiting"), waits("blimp-1", T - 1000)];
    await r.tick();
    t.now = T + BATCH;
    await r.tick();
    t.list = [waits("blimp-1", T - 1000)];
    await r.tick();
    expect(t.typed).toEqual([]);
    t.list = [assistant(), waits("blimp-1", T - 1000)];
    await r.tick();
    expect(t.typed).toHaveLength(1);
    expect(t.reported).toEqual([["blimp-1", T - 1000]]);
  });

  test("a failed typing keeps the lines and is logged once; Asking isn't logged", async () => {
    let fail: Error | undefined = new Asking();
    const { t, r } = setup({ type: async (text) => { if (fail) throw fail; t.typed.push(text); } });
    t.list = [assistant(), waits("blimp-1", T - 1000)];
    await r.tick();
    t.now = T + BATCH;
    await r.tick();
    fail = new Error("the session ended");
    await r.tick();
    await r.tick();
    expect(t.logs).toEqual(["assistant: couldn't type a job update into it (the session ended); trying again"]);
    fail = undefined;
    await r.tick();
    expect(t.typed).toHaveLength(1);
    expect(r.lastTyped).toBe(T + BATCH);
  });
});
