import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ActivityEvent,
  branchOf,
  contextLimit,
  fold,
  lastLine,
  lineEvents,
  newActivity,
  outputTail,
  redact,
  sessionActivity,
  shownJobs,
  transcriptActivity,
} from "../src/activity";
import real from "./fixtures/activity-lines.json";

// Real transcript lines (Claude Code 2.1.300), trimmed and anonymized: see fixtures/activity-lines.json.
const R = real as Record<string, string>;
const at = (iso: string) => Date.parse(iso);
const tsOf = (name: string) => at(JSON.parse(R[name]).timestamp);
const SID = "11111111-2222-3333-4444-555555555555";
const tasks = `/tmp/claude-1000/-Users-u-blimp/${SID}/tasks`;

const tmp = mkdtempSync(join(tmpdir(), "blimp-activity-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const run = (...names: string[]) => {
  const a = newActivity();
  for (const n of names) fold(a, lineEvents(R[n]));
  return a;
};
const job = (a: ReturnType<typeof newActivity>, id: string) => a.jobs.get(id);

describe("lineEvents", () => {
  test("a background Bash call gives its label, its usage and where Claude is", () => {
    expect(lineEvents(R.bashCall)).toEqual([
      { type: "usage", at: tsOf("bashCall"), used: 2 + 791 + 91091, model: "claude-opus-5-5" },
      { type: "where", cwd: "/Users/u/blimp" },
      { type: "call", id: "toolu_01AaG27JCpFFhiJQKMrrkAKW", name: "Bash", label: "Run isolated blimpd benchmark" },
    ]);
  });

  test("its result starts a bash job, with the output file the result names", () => {
    expect(lineEvents(R.bashStarted)).toEqual([
      { type: "where", cwd: "/Users/u/blimp" },
      { type: "start", at: tsOf("bashStarted"), id: "b1lysb74d", kind: "bash", call: "toolu_01AaG27JCpFFhiJQKMrrkAKW", outputFile: `${tasks}/b1lysb74d.output` },
    ]);
  });

  test("a notification from the queue, from a user line and from an attachment are all read", () => {
    const end = { type: "end", ids: ["a33c01bf52352f75b"], status: "done", summary: 'Agent "Implement Task 1: transcript parser" finished', outputFile: `${tasks}/a33c01bf52352f75b.output` };
    expect(lineEvents(R.agentDoneQueued)).toEqual([{ ...end, at: tsOf("agentDoneQueued") }] as ActivityEvent[]);
    expect(lineEvents(R.agentDoneAttachment).filter((e) => e.type === "end")).toEqual([{ ...end, at: tsOf("agentDoneAttachment") }] as ActivityEvent[]);
    expect(lineEvents(R.failedDone).find((e) => e.type === "end")).toMatchObject({ ids: ["b5bbkbpfm"], status: "failed", exit: 1 });
  });

  test("a Monitor event is not an end, and the ids that aren't jobs are kept out of one with many", () => {
    expect(lineEvents(R.monitorEvent).filter((e) => e.type === "end")).toEqual([]);
    expect(lineEvents(R.manyStopped)).toEqual([
      { type: "end", at: tsOf("manyStopped"), ids: ["bjnvayqae", "b3at273kr"], status: "stopped", summary: expect.stringContaining("2 background shell command tasks") },
    ]);
  });

  test("killed counts as stopped; a Monitor script's exit is read from 'script failed (exit N)'", () => {
    expect(lineEvents(R.killed)).toMatchObject([{ type: "end", status: "stopped" }]);
    expect(lineEvents(R.monitorFailed)).toMatchObject([{ type: "end", ids: ["buwontovi"], status: "failed", exit: 1 }]);
  });

  test("api-request copies, tool output that quotes a notification, and sidechain lines say nothing", () => {
    const quoted = JSON.stringify({
      type: "user", isSidechain: false, timestamp: "2026-10-21T00:00:00Z",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: JSON.parse(R.failedQueued).content }] },
      toolUseResult: { stdout: '"backgroundTaskId":"bzzz" "async_launched"' },
    });
    expect(lineEvents(quoted)).toEqual([]);
    expect(lineEvents('{"type":"api-request","messages":[' + R.bashStarted + "]}")).toEqual([]);
    const side = JSON.parse(R.bashStarted);
    side.isSidechain = true;
    expect(lineEvents(JSON.stringify(side))).toEqual([]);
    expect(lineEvents("not json {\"type\":\"assistant\"")).toEqual([]);
  });

  test("an output file is only taken from a tasks folder, named after its job", () => {
    const r = JSON.parse(R.bashStarted);
    r.message.content[0].content = "Command running in background with ID: b1lysb74d. Output is being written to: /home/u/.blimp/token. You will…";
    expect(lineEvents(JSON.stringify(r)).find((e) => e.type === "start")).not.toHaveProperty("outputFile");
  });
});

describe("fold", () => {
  test("a background command runs, then fails with its exit code, ended when it was first queued", () => {
    const a = run("failedCall", "failedStarted");
    expect(job(a, "b5bbkbpfm")).toMatchObject({ kind: "bash", label: "Watch the phone run for the fix", status: "running", startedAt: tsOf("failedStarted") });
    for (const n of ["failedQueued", "failedDone"]) fold(a, lineEvents(R[n]));
    expect(job(a, "b5bbkbpfm")).toMatchObject({ status: "failed", exit: 1, endedAt: tsOf("failedQueued"), outputFile: `${tasks}/b5bbkbpfm.output` });
  });

  test("a command moved to the background after its timeout is a job, and TaskStop stops it", () => {
    const a = run("timeoutCall", "timeoutStarted");
    expect(job(a, "bsmc3jnal")).toMatchObject({ kind: "bash", status: "running" });
    fold(a, lineEvents(R.taskStop));
    expect(job(a, "bsmc3jnal")).toMatchObject({ status: "stopped", endedAt: tsOf("taskStop") });
  });

  test("a Monitor is a job labelled by its description; its events leave it running", () => {
    const a = run("monitorCall", "monitorStarted", "monitorEvent");
    expect(job(a, "boa2j2nz1")).toMatchObject({ kind: "monitor", label: "iPhone build and test jobs on phone-swipe", status: "running", startedAt: tsOf("monitorStarted") });
  });

  test("an async agent is a job with its description and output file; its notifications count once", () => {
    const a = run("agentStarted");
    expect(job(a, "a33c01bf52352f75b")).toMatchObject({ kind: "agent", label: "Implement Task 1: transcript parser", status: "running", outputFile: `${tasks}/a33c01bf52352f75b.output` });
    fold(a, lineEvents(R.agentDoneQueued));
    fold(a, lineEvents(R.agentDoneAttachment));
    expect(job(a, "a33c01bf52352f75b")).toMatchObject({ status: "done", endedAt: tsOf("agentDoneQueued") });
  });

  test("a workflow is a job labelled by its summary, done when it notifies", () => {
    const a = run("workflowCall", "workflowStarted");
    expect(job(a, "wl4m1of3b")).toMatchObject({ kind: "workflow", label: "Adversarially verify the /fs secret-file block fix in blimp", status: "running" });
    fold(a, lineEvents(R.workflowDone));
    expect(job(a, "wl4m1of3b")).toMatchObject({ status: "done", outputFile: `${tasks}/wl4m1of3b.output` });
  });

  test("the same id notifying again with something new: the latest wins", () => {
    const a = newActivity();
    fold(a, [{ type: "start", at: 1000, id: "a1", kind: "agent", label: "Review" }]);
    fold(a, [{ type: "end", at: 2000, ids: ["a1"], status: "done", summary: 'Agent "Review" finished' }]);
    fold(a, [{ type: "end", at: 2500, ids: ["a1"], status: "done", summary: 'Agent "Review" finished' }]);
    expect(job(a, "a1")).toMatchObject({ status: "done", endedAt: 2000 });
    fold(a, [{ type: "end", at: 3000, ids: ["a1"], status: "failed", summary: 'Agent "Review" failed' }]);
    expect(job(a, "a1")).toMatchObject({ status: "failed", endedAt: 3000 });
  });

  test("an agent waiting on its own background work is still running; done when it finishes; a late copy changes nothing", () => {
    const id = "a053cf9c336268644";
    const a = newActivity();
    fold(a, [{ type: "start", at: 1, id, kind: "agent", label: "Run Haiku researcher A/B wave" }]);
    fold(a, lineEvents(R.agentWaitingQueued));
    expect(job(a, id)).toMatchObject({ status: "running" });
    expect(job(a, id)).not.toHaveProperty("endedAt");
    fold(a, lineEvents(R.agentWaitingFinished));
    expect(job(a, id)).toMatchObject({ status: "done", endedAt: tsOf("agentWaitingFinished") });
    // Both come again as attachments once Claude is free, in the order they were queued.
    const attached = (n: string) => JSON.stringify({ type: "attachment", attachment: { type: "queued_command", prompt: JSON.parse(R[n]).content }, timestamp: JSON.parse(R[n]).timestamp });
    fold(a, lineEvents(attached("agentWaitingQueued")));
    fold(a, lineEvents(attached("agentWaitingFinished")));
    expect(job(a, id)).toMatchObject({ status: "done", endedAt: tsOf("agentWaitingFinished") });
    // Sent another message, it starts background work again: running, until it finishes again.
    const again = JSON.parse(R.agentWaitingQueued);
    again.content = again.content.replace(/<result>[\s\S]*<\/result>/, "<result>Re-running the low arm.</result>");
    fold(a, lineEvents(JSON.stringify(again)));
    expect(job(a, id)).toMatchObject({ status: "running" });
    expect(job(a, id)).not.toHaveProperty("endedAt");
  });

  test("one notification can end several jobs; ids that never started are ignored", () => {
    const a = newActivity();
    fold(a, [{ type: "start", at: 1, id: "bjnvayqae", kind: "bash", label: "x" }, { type: "start", at: 2, id: "b3at273kr", kind: "bash", label: "y" }]);
    fold(a, lineEvents(R.manyStopped));
    fold(a, lineEvents(R.agentWaiting));
    expect([...a.jobs.values()].map((j) => [j.id, j.status])).toEqual([["bjnvayqae", "stopped"], ["b3at273kr", "stopped"]]);
  });

  test("TaskStop after a job ended leaves it as it ended", () => {
    const a = newActivity();
    fold(a, [{ type: "start", at: 1, id: "b1", kind: "bash", label: "x" }, { type: "end", at: 2, ids: ["b1"], status: "done", summary: "s", exit: 0 }, { type: "stop", at: 3, id: "b1" }]);
    expect(job(a, "b1")).toMatchObject({ status: "done", endedAt: 2, exit: 0 });
  });

  test("a label and a last output line have what looks like a secret taken out", () => {
    const call = JSON.parse(R.bashCall);
    delete call.message.content[0].input.description;
    call.message.content[0].input.command = 'API_KEY=sk-live-abcdefghijklmnop123 curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc" https://bob:hunter22@example.com/x --token s3cr3tvalue';
    const l = (lineEvents(JSON.stringify(call)).find((e) => e.type === "call") as any).label as string;
    for (const secret of ["sk-live", "eyJhbGci", "hunter22", "s3cr3tvalue"]) expect(l).not.toContain(secret);
    expect(l).toStartWith("API_KEY=… curl");
    expect(lastLine("export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123\n")).toBe("export GITHUB_TOKEN=…");
    expect(lastLine("aws AKIAABCDEFGHIJKLMNOP ok\n")).toBe("aws … ok");
    for (const plain of ["12 tests passed, key lookups fine", "Query production run-token totals"]) expect(redact(plain)).toBe(plain);
  });

  test("a label is one line of at most 120 characters, the command when there's no description", () => {
    const a = newActivity();
    fold(a, [{ type: "call", id: "t1", name: "Bash", label: "x".repeat(200) }, { type: "start", at: 1, id: "b1", kind: "bash", call: "t1" }]);
    expect(job(a, "b1")!.label).toHaveLength(120);
    const call = JSON.parse(R.bashCall);
    delete call.message.content[0].input.description;
    call.message.content[0].input.command = "bun test\n  ./test";
    expect(lineEvents(JSON.stringify(call)).find((e) => e.type === "call")).toMatchObject({ label: "bun test ./test" });
  });

  test("context: the latest main-thread usage; a compaction resets it to what was kept", () => {
    const a = run("bashCall");
    expect(a.context).toEqual({ used: 2 + 791 + 91091, model: "claude-opus-5-5" });
    fold(a, lineEvents(R.compact));
    expect(a.context).toEqual({ used: 17285, model: "claude-opus-5-5" });
    fold(a, [{ type: "compact", at: 5 }]);
    expect(a.context!.used).toBe(0); // no postTokens: nothing known until the next reply
    const synthetic = JSON.parse(R.bashCall);
    synthetic.message.model = "<synthetic>";
    fold(a, lineEvents(JSON.stringify(synthetic)));
    expect(a.context!.used).toBe(0);
  });

  test("cwd: the latest line's folder", () => {
    const a = run("bashCall", "edit");
    expect(a.cwd).toBe("/Users/u/blimp/app");
    fold(a, [{ type: "where", cwd: "/w" }]);
    expect(a.cwd).toBe("/w");
  });
});

describe("branchOf", () => {
  test("the branch checked out in a folder, read from git's files: a repo, a folder in it, a worktree; detached or none is no branch", () => {
    const repo = join(tmp, "repo");
    mkdirSync(join(repo, ".git", "worktrees", "wt-549"), { recursive: true });
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(repo, ".git", "worktrees", "wt-549", "HEAD"), "ref: refs/heads/eng-549-portal-css\n");
    const wt = join(tmp, "wt-549");
    mkdirSync(join(wt, "app"), { recursive: true });
    writeFileSync(join(wt, ".git"), `gitdir: ${join(repo, ".git", "worktrees", "wt-549")}\n`);
    const plain = join(tmp, "plain");
    mkdirSync(plain);
    expect(branchOf(repo, 0)).toBe("main");
    expect(branchOf(join(repo, "src"), 0)).toBe("main");
    expect(branchOf(join(wt, "app"), 0)).toBe("eng-549-portal-css");
    expect(branchOf(plain, 0)).toBeUndefined();
    expect(branchOf(join(tmp, "gone"), 0)).toBeUndefined();
    // Read again at most every 10 s.
    writeFileSync(join(repo, ".git", "HEAD"), "4f1c9e0d2b7a6c5e8f3a1b0c9d8e7f6a5b4c3d2e\n");
    expect(branchOf(repo, 9_000)).toBe("main");
    expect(branchOf(repo, 10_000)).toBeUndefined();
  });
});

describe("contextLimit", () => {
  test("GLM's window is CLAUDE_CODE_MAX_CONTEXT_TOKENS; [1m] and Claude 5+ are 1M; Claude 3 and 4 are 200k", () => {
    expect(contextLimit("GLM-5.3")).toBe(1048576);
    expect(contextLimit("claude-sonnet-4-5", "claude-glm")).toBe(1048576);
    expect(contextLimit("claude-sonnet-4-5[1m]")).toBe(1_000_000);
    expect(contextLimit("claude-opus-5-5")).toBe(1_000_000);
    expect(contextLimit("claude-fable-6")).toBe(1_000_000);
    expect(contextLimit("claude-sonnet-4-5-20250929")).toBe(200_000);
    expect(contextLimit("claude-3-5-sonnet-20241022")).toBe(200_000);
    expect(contextLimit("claude-haiku-4-5")).toBe(200_000);
    expect(contextLimit("something-new")).toBe(1_000_000);
    expect(contextLimit(undefined)).toBe(1_000_000);
  });
});

describe("lastLine", () => {
  test("the last non-empty line, without colors or the progress a \\r overwrote, at most 160 characters", () => {
    expect(lastLine("one\ntwo\n\n  \n")).toBe("two");
    expect(lastLine("\x1b[32m✓ passed\x1b[0m 12 tests\n")).toBe("✓ passed 12 tests");
    expect(lastLine("building 10%\rbuilding 55%\rbuilding 90%")).toBe("building 90%");
    expect(lastLine("y".repeat(300))).toHaveLength(160);
    expect(lastLine("")).toBeUndefined();
    expect(lastLine("\n\n")).toBeUndefined();
  });

  test("outputTail reads the file's tail in the background, again at most every 10 s", async () => {
    const f = join(tmp, "b1.output");
    writeFileSync(f, "x".repeat(10_000) + "\nfirst\n");
    expect(outputTail(f, 1000)).toBeUndefined(); // the read just started
    await Bun.sleep(30);
    expect(outputTail(f, 1000)).toBe("first");
    appendFileSync(f, "second\n");
    expect(outputTail(f, 9000)).toBe("first");
    await Bun.sleep(30);
    expect(outputTail(f, 9000)).toBe("first");
    outputTail(f, 11_001);
    await Bun.sleep(30);
    expect(outputTail(f, 11_001)).toBe("second");
    expect(outputTail(join(tmp, "missing.output"), 1)).toBeUndefined();
    await Bun.sleep(30);
    expect(outputTail(join(tmp, "missing.output"), 1)).toBeUndefined();
  });
});

describe("shownJobs", () => {
  test("running jobs and those that ended in the last 30 minutes, oldest first, without bookkeeping", () => {
    const a = newActivity();
    const m = 60_000;
    fold(a, [
      { type: "start", at: 3 * m, id: "b2", kind: "bash", label: "new" },
      { type: "start", at: 1 * m, id: "b1", kind: "bash", label: "old" },
      { type: "start", at: 2 * m, id: "a1", kind: "agent", label: "agent" },
      { type: "end", at: 4 * m, ids: ["a1"], status: "done", summary: "s" },
      { type: "start", at: 0, id: "w1", kind: "workflow", label: "gone" },
      { type: "end", at: 1, ids: ["w1"], status: "done", summary: "s" },
    ]);
    const now = 33 * m;
    expect(shownJobs(a, now).map((j) => j.id)).toEqual(["b1", "a1", "b2"]);
    expect(shownJobs(a, now + 2 * m).map((j) => j.id)).toEqual(["b1", "b2"]);
    expect(Object.keys(shownJobs(a, now)[1]).sort()).toEqual(["endedAt", "id", "kind", "label", "startedAt", "status"]);
  });

  test("a running Monitor's output file is found in the tasks folder its transcript's jobs use", () => {
    const a = run("failedCall", "failedStarted", "monitorCall", "monitorStarted");
    const jobs = shownJobs(a, tsOf("monitorStarted"));
    expect(jobs.find((j) => j.id === "boa2j2nz1")).toMatchObject({ outputFile: `${tasks}/boa2j2nz1.output` });
  });

  test("a running bash job gets its output's last line", async () => {
    const dir = join(tmp, "-p", SID, "tasks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "b9.output"), "compiling\n12 tests passed\n");
    const a = newActivity();
    fold(a, [{ type: "start", at: 1, id: "b9", kind: "bash", label: "x", outputFile: join(dir, "b9.output") }]);
    shownJobs(a, 1);
    await Bun.sleep(30);
    expect(shownJobs(a, 1)[0].lastLine).toBe("12 tests passed");
  });
});

describe("sessionActivity", () => {
  test("the branch comes from the folder Claude is in, not the one its session started in", () => {
    const repo = join(tmp, "repo2");
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/feat-x\n");
    const line = JSON.parse(R.bashCall);
    line.cwd = repo; // gitBranch still says "main", the start folder's branch
    const f = join(tmp, "where.jsonl");
    writeFileSync(f, JSON.stringify(line) + "\n");
    expect(sessionActivity(f, "claude").git).toEqual({ cwd: repo, branch: "feat-x" });
  });

  test("a job still running from before Claude's process started is stopped: it ended with that process", () => {
    const f = join(tmp, "resumed.jsonl");
    writeFileSync(f, R.failedCall + "\n" + R.failedStarted + "\n");
    const started = tsOf("failedStarted");
    expect(sessionActivity(f, "claude", started + 1000, started - 1).jobs).toMatchObject([{ id: "b5bbkbpfm", status: "running" }]);
    expect(sessionActivity(f, "claude", started + 1000, started + 500).jobs).toMatchObject([{ id: "b5bbkbpfm", status: "stopped", endedAt: started + 500 }]);
  });
});

describe("transcriptActivity", () => {
  test("reads a transcript once, then only the complete lines added since", () => {
    const f = join(tmp, `${SID}.jsonl`);
    writeFileSync(f, R.failedCall + "\n" + R.failedStarted + "\n" + R.failedQueued.slice(0, 50));
    expect(transcriptActivity(f)!.jobs.get("b5bbkbpfm")).toMatchObject({ status: "running" });
    appendFileSync(f, R.failedQueued.slice(50) + "\n");
    expect(transcriptActivity(f)!.jobs.get("b5bbkbpfm")).toMatchObject({ status: "failed", exit: 1 });
    // Rewritten shorter: read again from the start.
    writeFileSync(f, R.bashCall + "\n");
    const a = transcriptActivity(f)!;
    expect([...a.jobs.keys()]).toEqual([]);
    expect(a.context?.used).toBe(2 + 791 + 91091);
    expect(transcriptActivity(join(tmp, "nope.jsonl"))).toBeUndefined();
  });

  test("a line longer than a chunk is skipped, and the lines after it are read", () => {
    const f = join(tmp, "long.jsonl");
    writeFileSync(f, JSON.stringify({ type: "user", pad: "z".repeat(5000) }) + "\n" + R.agentStarted + "\n");
    expect(transcriptActivity(f, 2048)!.jobs.has("a33c01bf52352f75b")).toBe(true);
  });
});
