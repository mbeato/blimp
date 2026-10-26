// The assistant (docs/superpowers/specs/2026-10-26-assistant-design.md, section 4): pinned at the top of every tab's
// session list while its session runs, with its jobs under it. Here a stand-in session named assistant in its folder
// under the test blimpd's socket folder, and a job of its: a waiting session in another folder, listed in
// assistant-jobs.json. The group shows both and folds to its counts; a job's row opens that session in its folder's
// tab; the assistant's row opens it without its folder joining the recent projects; Settings has the switch, and
// turning it off asks first, then ends the assistant.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "@playwright/test";
import { e2e, fixtureDir, frontTab, killSession, openApp, sessionRow, startSession, zmxEnv } from "./helpers";

const job = `blimpe2e-asstjob-${process.pid}`;
const other = `blimpe2e-asstother-${process.pid}`;
// The test blimpd's socket folder: its config.json, assistant-jobs.json and the assistant's folder.
const blimpDir = () => dirname(e2e().statusDir);
const config = () => join(blimpDir(), "config.json");
let saved: string | null = null;

// The assistant's name must be exactly assistant, which helpers.ts's startSession and killSession refuse (they keep
// to blimpe2e-*). The test blimpd has its own zmx folder (setup.ts's ZMX_DIR), so the name touches nothing else.
const zmx = (args: string[], cwd?: string) => execFileSync("zmx", args, { cwd, env: zmxEnv(), stdio: "ignore", timeout: 10_000 });

test.afterAll(() => {
  // The switch back first, so blimpd doesn't start an assistant of its own once the stand-in is gone.
  if (saved === null) rmSync(config(), { force: true });
  else writeFileSync(config(), saved);
  try {
    zmx(["kill", "assistant"]);
  } catch {}
  killSession(job);
  killSession(other);
});

test("the pinned Assistant group shows the assistant and its job, folds, and opens each; Settings turns it off after asking", async ({ page }) => {
  const home = fixtureDir("asst-home");
  const work = fixtureDir("asst-work");
  const mine = join(blimpDir(), "assistant");
  mkdirSync(mine, { recursive: true });
  mkdirSync(e2e().statusDir, { recursive: true });
  startSession(other, home);
  startSession(job, work);
  zmx(["attach", "assistant", "cat"], mine);
  writeFileSync(join(e2e().statusDir, `${job}.json`), JSON.stringify({ state: "waiting", at: Date.now() }));
  writeFileSync(join(blimpDir(), "assistant-jobs.json"), JSON.stringify({ [job]: { reason: "fix the tests", at: Date.now() } }));
  saved = existsSync(config()) ? readFileSync(config(), "utf8") : null;
  writeFileSync(config(), JSON.stringify({ ...(saved ? JSON.parse(saved) : {}), assistant: true }));

  await openApp(page, { dir: home, session: other });
  const group = frontTab(page).locator("section.assistant");
  const mineRow = group.locator('.assistant-line[data-session="assistant"]');
  const jobRow = group.locator(`.assistant-job[data-session="${job}"]`);
  await expect(mineRow).toBeVisible({ timeout: 5000 });
  await expect(jobRow).toContainText("asst-work · fix the tests");

  // Folded: one line with its counts, kept on this computer.
  const fold = group.locator(".slist-fold");
  await fold.click();
  await expect(fold).toHaveText(/Assistant · 1 needs you/);
  await expect(jobRow).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("blimp.assistantOpen"))).toBe("closed");
  await fold.click();

  // A job's row opens it in its own folder's tab.
  await jobRow.click();
  await expect(sessionRow(page, job)).toHaveClass(/selected/);

  // The assistant's row opens it; its folder never joins the recent projects (blimp.recent's projects: its layout
  // keeps the open tabs, the assistant's among them).
  await mineRow.click();
  await expect(sessionRow(page, "assistant")).toHaveClass(/selected/);
  expect(await page.evaluate(() => JSON.stringify(JSON.parse(localStorage.getItem("blimp.recent") ?? "{}").projects ?? {}))).not.toContain(mine);

  // Settings: on; Turn Off asks first; Cancel keeps it; Turn Off ends it, and the group goes.
  await page.keyboard.press("Meta+,");
  const dialog = page.locator(".dialog.settings");
  const box = dialog.getByRole("checkbox", { name: "Assistant" });
  await expect(box).toBeChecked();
  const ask = dialog.locator(".settings-confirm");
  await box.click();
  await expect(ask).toContainText("Turn off the assistant? Its chat ends.");
  await expect(box).toBeChecked();
  await ask.getByRole("button", { name: "Cancel" }).click();
  await expect(ask).toHaveCount(0);
  await box.click();
  await ask.getByRole("button", { name: "Turn Off" }).click();
  await expect(box).not.toBeChecked();
  await page.keyboard.press("Escape");
  await expect(page.locator("section.assistant")).toHaveCount(0, { timeout: 5000 });
});
