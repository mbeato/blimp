// M4: a save in blimp reaches the file on the server (git diff shows it), and a server-side
// change to an open file with unsaved edits brings up the reload bar.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { fixtureDir, killSession, openApp, openSessionTab, startSession } from "./helpers";

const name = `blimpe2e-m4-${process.pid}`;
const del = `blimpe2e-m4del-${process.pid}`;

test.afterAll(() => {
  killSession(name);
  killSession(del);
});

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

test("a file deleted on the server shows a bar, and only Save brings it back; ⌘K in Monaco is Monaco's", async ({ page }) => {
  const dir = fixtureDir("m4del");
  const file = join(dir, "gone.txt");
  writeFileSync(file, "still here\n");
  startSession(del, dir);

  await openApp(page);
  const term = await openSessionTab(page, dir);
  const ws = page.locator(".workspace:not([hidden])");
  await ws.locator(".tree").getByText("gone.txt").click();
  const editor = ws.locator(".monaco-editor .view-lines");
  await expect(editor).toContainText("still here");

  // Inside Monaco ⌘K starts a Monaco chord; elsewhere it opens the palette.
  await editor.click();
  await page.keyboard.press("Meta+k");
  await page.keyboard.press("Escape");
  await expect(page.locator(".dialog.palette")).toHaveCount(0);
  await term.locator(".xterm").click();
  await page.keyboard.press("Meta+k");
  await expect(page.locator(".dialog.palette")).toBeVisible();
  await page.keyboard.press("Escape");

  rmSync(file);
  const bar = ws.locator(".fbar", { hasText: "Deleted on the server" });
  await expect(bar).toBeVisible({ timeout: 5000 });
  await expect(editor).toContainText("still here");
  await page.waitForTimeout(500);
  expect(existsSync(file)).toBe(false);

  await bar.getByRole("button", { name: "Save" }).click();
  await expect.poll(() => existsSync(file)).toBe(true);
  expect(readFileSync(file, "utf8")).toBe("still here\n");
  await expect(bar).toHaveCount(0);

  // Watched again: a later change on the server still reaches the editor.
  writeFileSync(file, "changed again\n");
  await expect(editor).toContainText("changed again", { timeout: 5000 });
});
