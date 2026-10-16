// M4: a save in blimp reaches the file on the server (git diff shows it), and a server-side
// change to an open file with unsaved edits brings up the reload bar.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { fixtureDir, killSession, openApp, openSessionTab, startSession } from "./helpers";

const name = `blimpe2e-m4-${process.pid}`;
const del = `blimpe2e-m4del-${process.pid}`;
const closeW = `blimpe2e-m4w-${process.pid}`;
const tabs = `blimpe2e-m4tabs-${process.pid}`;

test.afterAll(() => {
  killSession(name);
  killSession(del);
  killSession(closeW);
  killSession(tabs);
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

test("⌘W in the files pane closes the open file (asking first if it has unsaved edits); elsewhere the session tab", async ({ page }) => {
  const dir = fixtureDir("m4w");
  writeFileSync(join(dir, "readme.md"), "# Read me\n");
  writeFileSync(join(dir, "code.txt"), "some code\n");
  startSession(closeW, dir);

  await openApp(page);
  const term = await openSessionTab(page, dir);
  const sessionTabs = page.locator(".tabbar .tab");
  await expect(sessionTabs).toHaveCount(1);
  const ws = page.locator(".workspace:not([hidden])");
  const fileTabs = ws.locator(".ftabs .tab");
  await ws.locator(".tree").getByText("readme.md").click();
  await expect(ws.locator(".md-view h1")).toHaveText("Read me");
  await ws.locator(".tree").getByText("code.txt").click();
  const editor = ws.locator(".monaco-editor .view-lines");
  await expect(editor).toContainText("some code");
  await expect(fileTabs).toHaveCount(2);

  // Unsaved edits: ⌘W asks first, and Don't save closes the file.
  await editor.click();
  await page.keyboard.type("edited ");
  await page.keyboard.press("Meta+w");
  const bar = ws.locator(".fbar", { hasText: "code.txt has unsaved changes" });
  await expect(bar).toBeVisible();
  await expect(fileTabs).toHaveCount(2);
  await bar.getByRole("button", { name: "Don't save" }).click();
  await expect(fileTabs).toHaveCount(1);
  expect(readFileSync(join(dir, "code.txt"), "utf8")).toBe("some code\n");

  // Focus stays in the pane after a close, so ⌘W again closes the next file, and with none left
  // does nothing: the session tab stays.
  await page.keyboard.press("Meta+w");
  await expect(fileTabs).toHaveCount(0);
  await page.keyboard.press("Meta+w");
  await page.waitForTimeout(300);
  await expect(sessionTabs).toHaveCount(1);

  // The same from inside the editor, pressing ⌘W twice with no click in between.
  await ws.locator(".tree").getByText("readme.md").click();
  await ws.locator(".tree").getByText("code.txt").click();
  await expect(fileTabs).toHaveCount(2);
  await editor.click();
  await page.keyboard.press("Meta+w");
  await expect(fileTabs).toHaveCount(1);
  await page.keyboard.press("Meta+w");
  await expect(fileTabs).toHaveCount(0);
  await expect(sessionTabs).toHaveCount(1);

  // ⌘W with the quick-open sheet up closes the sheet, not the file behind it.
  await ws.locator(".tree").getByText("readme.md").click();
  await expect(fileTabs).toHaveCount(1);
  await page.keyboard.press("Meta+p");
  const quick = page.getByPlaceholder("Open a file by name");
  await expect(quick).toBeFocused();
  await page.keyboard.press("Meta+w");
  await expect(quick).toHaveCount(0);
  await expect(fileTabs).toHaveCount(1);
  await expect(sessionTabs).toHaveCount(1);

  // Focus in the Markdown preview: ⌘W closes that file, and the session tab stays.
  await ws.locator(".md-view").click();
  await page.keyboard.press("Meta+w");
  await expect(fileTabs).toHaveCount(0);
  await expect(sessionTabs).toHaveCount(1);

  // Focus in the terminal: ⌘W closes the session tab.
  await term.locator(".xterm").click();
  await page.keyboard.press("Meta+w");
  await expect(sessionTabs).toHaveCount(0);
});

test("the active file tab scrolls into view, and the Markdown Edit toggle stays visible", async ({ page }) => {
  const dir = fixtureDir("m4tabs");
  const names = ["first-file-name.txt", "second-file-name.txt", "third-file-name.txt", "fourth-file-name.txt", "fifth-file-name.md"];
  for (const n of names) writeFileSync(join(dir, n), n.endsWith(".md") ? "# Fifth\n" : `${n}\n`);
  startSession(tabs, dir);

  await openApp(page);
  await openSessionTab(page, dir);
  const ws = page.locator(".workspace:not([hidden])");
  const strip = ws.locator(".ftabs");
  // Fully inside the strip's visible box (the strip scrolls sideways with no scrollbar).
  const shown = (el: string) =>
    ws.locator(el).evaluate((t) => {
      const box = (t.closest(".ftabs") ?? t.closest(".files-top"))!.getBoundingClientRect();
      const r = t.getBoundingClientRect();
      return r.width > 0 && r.left >= box.left - 1 && r.right <= box.right + 1;
    });

  for (const n of names) {
    await ws.locator(".tree").getByText(n).click();
    await expect(ws.locator(".ftabs .tab.active")).toHaveText(new RegExp(n));
    await expect.poll(() => shown(".ftabs .tab.active")).toBe(true);
  }
  // More tabs than fit, so the strip really scrolled.
  expect(await strip.evaluate((s) => s.scrollWidth > s.clientWidth && s.scrollLeft > 0)).toBe(true);
  await expect.poll(() => shown(".ftabs-toggle")).toBe(true);

  // Back to the first file, which is off the left edge now.
  await ws.locator(".tree").getByText(names[0]).click();
  await expect(ws.locator(".ftabs .tab.active")).toHaveText(new RegExp(names[0]));
  await expect.poll(() => shown(".ftabs .tab.active")).toBe(true);
});
