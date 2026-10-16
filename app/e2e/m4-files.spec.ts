// M4: a save in blimp reaches the file on the server (git diff shows it), and a server-side
// change to an open file with unsaved edits brings up the reload bar.

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { fixtureDir, killSession, openApp, openSessionTab, startSession } from "./helpers";

const name = `blimpe2e-m4-${process.pid}`;

test.afterAll(() => killSession(name));

const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", ...args], { cwd: dir, encoding: "utf8" });

test("save reaches git diff; a server change to an edited file shows the reload bar", async ({ page }) => {
  const dir = fixtureDir("m4");
  writeFileSync(join(dir, "notes.txt"), "first line\n");
  git(dir, "init", "-q");
  git(dir, "add", "notes.txt");
  git(dir, "commit", "-qm", "notes");
  startSession(name, dir);

  await openApp(page);
  await openSessionTab(page, dir);
  const ws = page.locator(".workspace:not([hidden])");
  await ws.locator(".tree").getByText("notes.txt").click();
  const editor = ws.locator(".monaco-editor .view-lines");
  await expect(editor).toContainText("first line");

  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\nsaved from blimp");
  await page.keyboard.press("Meta+s");
  await expect.poll(() => git(dir, "diff")).toContain("+saved from blimp");
  await expect(ws.locator(".tab.active .tab-close.dirty")).toHaveCount(0);

  // Unsaved edits, then the file changes on the server (as when Claude edits it).
  await page.keyboard.type("\nnot saved yet");
  await expect(ws.locator(".tab.active .tab-close.dirty")).toHaveCount(1);
  writeFileSync(join(dir, "notes.txt"), "changed on the server\n");
  await expect(ws.locator(".fbar", { hasText: "Changed on the server" })).toBeVisible({ timeout: 5000 });
});
