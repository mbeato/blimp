// The Run bar: commands from Claude's latest reply over the top of its terminal. Run opens the command in a split to
// the right; once it ended, its exit code and Send result to Claude, which types the result into Claude
// (refused, with a notice, while Claude asks something).

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { e2e, fixtureDir, frontTab, killSession, openSessionTab, screenText, splitTerm, startSession, zmxEnv } from "./helpers";

const name = `blimpe2e-runs-${process.pid}`;
const runs: string[] = [];

test.afterAll(() => {
  killSession(name);
  // The runs blimpd started: named after the folder, so not blimpe2e-*; ended here by name.
  for (const r of runs) execFileSync("zmx", ["kill", r], { env: zmxEnv(), stdio: "ignore", timeout: 10_000 });
});

test("Run opens a command from Claude's reply in a split to its right; Send result to Claude types its result in", async ({ page }) => {
  const claude = process.env.BLIMP_E2E_CLAUDE!;
  const dir = fixtureDir("runs");
  startSession(name, dir);
  // It looks like Claude to blimpd, with a reply that hands over four commands.
  const pid = execFileSync("zmx", ["list"], { env: zmxEnv(), encoding: "utf8" }).match(new RegExp(`name=${name}\\tpid=(\\d+)`))![1];
  const sid = crypto.randomUUID();
  mkdirSync(join(claude, "sessions"), { recursive: true });
  mkdirSync(join(claude, "projects", "fake"), { recursive: true });
  writeFileSync(join(claude, "sessions", `${pid}.json`), JSON.stringify({ sessionId: sid, status: "idle" }));
  const at = new Date().toISOString();
  const lines = [
    { type: "user", timestamp: at, message: { role: "user", content: "how do I check it?" } },
    { type: "assistant", timestamp: at, message: { content: [{ type: "text", text: "Try `sh -c true`, `bash -c 'exit 4'` or `node -e 1`, then:\n\n```bash\necho e2e-$((6*7))\n```" }] } },
  ];
  writeFileSync(join(claude, "projects", "fake", `${sid}.jsonl`), lines.map((l) => JSON.stringify(l) + "\n").join(""));

  await openSessionTab(page, dir, name);
  const bar = frontTab(page).locator(`.tsplit[data-split="${name}"] .runbar`);
  await expect(bar.locator(".runbar-run")).toHaveText(["echo e2e-$((6*7))", "node -e 1", "bash -c 'exit 4'"], { timeout: 5000 });
  await expect(bar.locator(".runbar-run").first()).toHaveAttribute("title", "Run in a new split:\necho e2e-$((6*7))");
  await expect(bar.locator(".runbar-more")).toHaveText("+1");

  await bar.locator(".runbar-run").first().click();
  // A second split, to the right of Claude's, running the command.
  const splits = frontTab(page).locator(".tsplit:not([hidden])");
  await expect(splits).toHaveCount(2, { timeout: 10_000 });
  const run = (await splits.nth(1).getAttribute("data-split"))!;
  runs.push(run);
  expect(run).not.toBe(name);
  await expect.poll(async () => (await frontTab(page).locator(`.tsplit[data-split="${run}"] .split-num`).textContent()) ?? "").toBe("2");
  await expect.poll(() => screenText(splitTerm(page, run)), { timeout: 10_000 }).toContain("── exit 0 ──");
  expect(await screenText(splitTerm(page, run))).toContain("e2e-42");

  // Ended: its exit code, and the result can go to Claude. Not while Claude asks something.
  await expect(bar.locator(".runbar-status").first()).toHaveText("exit 0", { timeout: 5000 });
  const status = join(e2e().statusDir, `${name}.json`);
  mkdirSync(e2e().statusDir, { recursive: true });
  writeFileSync(status, JSON.stringify({ state: "waiting", at: Date.now(), event: "Notification" }));
  await expect.poll(async () => (await (await fetch(`${e2e().base}/sessions`, { headers: { Authorization: `Bearer ${e2e().token}` } })).json()).find((s: any) => s.name === name)?.state).toBe("waiting");
  await bar.locator(".runbar-send").first().click();
  await expect(page.locator(".toast")).toHaveText("Claude is asking something. Answer it first.");
  rmSync(status);
  await expect.poll(async () => (await (await fetch(`${e2e().base}/sessions`, { headers: { Authorization: `Bearer ${e2e().token}` } })).json()).find((s: any) => s.name === name)?.state).toBe("done");
  await bar.locator(".runbar-send").first().click();
  await expect.poll(() => screenText(splitTerm(page, name)), { timeout: 10_000 }).toContain("[blimp run]");
  expect(await screenText(splitTerm(page, name))).toContain("e2e-42");

  // × hides the bar for this reply. The bar lies over the terminal: coming and going, it doesn't resize
  // Claude's terminal (each resize makes Claude Code redraw).
  const body = frontTab(page).locator(`.tsplit[data-split="${name}"] .tsplit-body`);
  const height = (await body.boundingBox())!.height;
  await bar.locator(".runbar-hide").click();
  await expect(bar).toHaveCount(0);
  expect((await body.boundingBox())!.height).toBe(height);

  // With the bar gone (as at your next prompt), the run's own menu still sends its result.
  await frontTab(page).locator(`.tsplit[data-split="${run}"] .tsplit-head`).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Send Result to Claude" }).click();
  await expect.poll(async () => (await screenText(splitTerm(page, name))).split("[blimp run]").length - 1, { timeout: 10_000 }).toBe(2);
});
