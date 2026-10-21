// Feature 1: Claude's background jobs on the session's row ("1 job"), a popover with each job, and a
// notification when one finishes, also while its session is on screen.

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { e2e, fixtureDir, killSession, notifications, openApp, sessionRow, startSession, zmxEnv } from "./helpers";

const name = `blimpe2e-jobs-${process.pid}`;

test.afterAll(() => killSession(name));

// Transcript lines as Claude Code writes them (test/fixtures/activity-lines.json has real ones).
const at = (ms = 0) => new Date(Date.now() + ms).toISOString();
const call = (id: string, description: string) => ({
  type: "assistant",
  isSidechain: false,
  timestamp: at(),
  message: { model: "claude-opus-5-5", content: [{ type: "tool_use", id, name: "Bash", input: { command: "bun run build", description, run_in_background: true } }] },
});
const started = (call: string, task: string, output: string) => ({
  type: "user",
  isSidechain: false,
  timestamp: at(),
  message: { role: "user", content: [{ tool_use_id: call, type: "tool_result", content: `Command running in background with ID: ${task}. Output is being written to: ${output}. You will be notified when it completes.` }] },
  toolUseResult: { stdout: "", stderr: "", backgroundTaskId: task },
});
const finished = (task: string, output: string) => ({
  type: "user",
  isSidechain: false,
  timestamp: at(1000),
  message: { role: "user", content: `<task-notification>\n<task-id>${task}</task-id>\n<output-file>${output}</output-file>\n<status>completed</status>\n<summary>Background command "Run the build" completed (exit code 0)</summary>\n</task-notification>` },
  origin: { kind: "task-notification" },
});

test("a background job shows on its row and in its popover, and notifies when it finishes", async ({ page }) => {
  const claude = process.env.BLIMP_E2E_CLAUDE!;
  const dir = fixtureDir("jobs");
  startSession(name, dir);
  const pid = execFileSync("zmx", ["list"], { env: zmxEnv(), encoding: "utf8" }).match(new RegExp(`name=${name}\\tpid=(\\d+)`))![1];
  const sid = crypto.randomUUID();
  mkdirSync(join(claude, "sessions"), { recursive: true });
  mkdirSync(join(claude, "projects", "jobs"), { recursive: true });
  writeFileSync(join(claude, "sessions", `${pid}.json`), JSON.stringify({ sessionId: sid, status: "busy" }));
  // The job's output, where Claude Code says it writes it: the popover shows its last line.
  const tasks = fixtureDir("jobs-out/tasks");
  const output = join(tasks, "b1lysb74d.output");
  writeFileSync(output, "compiling…\n\x1b[32mbuilt 12 files\x1b[0m\n");
  const transcript = join(claude, "projects", "jobs", `${sid}.jsonl`);
  writeFileSync(transcript, [call("toolu_1", "Run the build"), started("toolu_1", "b1lysb74d", output)].map((l) => JSON.stringify(l) + "\n").join(""));

  // On screen in a focused window: a wait wouldn't notify, a finished job still does.
  await openApp(page, { dir, session: name });
  await page.bringToFront();
  const row = sessionRow(page, name);
  const jobs = row.locator(".srow-jobs");
  await expect(jobs).toHaveText("1 job", { timeout: 5000 });

  await jobs.click();
  const pop = page.locator(".jobs-pop");
  await expect(pop).toBeVisible();
  await expect(pop.locator(".job-label")).toHaveText("Run the build");
  await expect(pop.locator(".job-kind")).toHaveText("Command");
  await expect(pop.locator(".job-state")).toHaveText("<1m");
  await expect(pop.locator(".job-line")).toHaveText("built 12 files", { timeout: 15_000 });
  await page.keyboard.press("Escape");
  await expect(pop).toHaveCount(0);

  appendFileSync(transcript, JSON.stringify(finished("b1lysb74d", output)) + "\n");
  await expect(jobs).toHaveText("job done", { timeout: 5000 });
  const folder = "~" + dir.slice(e2e().fixtures.length);
  await expect.poll(() => notifications(page), { timeout: 5000 }).toContainEqual({ title: "Run the build finished", body: `(new session) · ${folder}` });

  await jobs.click();
  await expect(pop.locator(".job-state")).toHaveText("done · exit 0");
});
