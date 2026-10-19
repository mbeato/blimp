// M4: an edit in blimp saves itself and reaches the file on the server (git diff shows it); a
// server-side change (Claude editing) reloads an open file, or brings up the reload bar when it
// would clash with edits not saved yet.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { fixtureDir, killSession, openSessionTab, startSession } from "./helpers";

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

test("edits autosave to git diff; Claude's edit reloads the file; a clash shows the reload bar", async ({ page }) => {
  const dir = fixtureDir("m4");
  writeFileSync(join(dir, "notes.txt"), "first line\n");
  git(dir, "init", "-q");
  git(dir, "add", "notes.txt");
  git(dir, "commit", "-qm", "notes");
  startSession(name, dir);

  await openSessionTab(page, dir);
  const ws = page.locator(".wb");
  await ws.locator(".tree").getByText("notes.txt").click();
  const editor = ws.locator(".monaco-editor .view-lines");
  await expect(editor).toContainText("first line");

  // No ⌘S: the edit saves itself about a second after the last key.
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\nsaved from blimp");
  await expect(ws.locator(".tab.active .tab-close.dirty")).toHaveCount(1);
  await expect.poll(() => git(dir, "diff"), { timeout: 5000 }).toContain("+saved from blimp");
  await expect(ws.locator(".tab.active .tab-close.dirty")).toHaveCount(0);

  // Claude edits the open file: no edits pending here, so it just reloads.
  writeFileSync(join(dir, "notes.txt"), "claude rewrote this\n");
  await expect(editor).toContainText("claude rewrote this", { timeout: 5000 });
  await expect(ws.locator(".fbar")).toHaveCount(0);

  // An edit not saved yet, and the file changes on the server before the autosave: the bar asks,
  // and the autosave doesn't write over Claude's change.
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("mine");
  writeFileSync(join(dir, "notes.txt"), "changed on the server\n");
  await expect(ws.locator(".fbar", { hasText: "Changed on the server" })).toBeVisible({ timeout: 5000 });
  await page.waitForTimeout(1500);
  expect(readFileSync(join(dir, "notes.txt"), "utf8")).toBe("changed on the server\n");

  // Keep mine writes the editor's text over it.
  await ws.locator(".fbar").getByRole("button", { name: "Keep mine" }).click();
  await expect.poll(() => readFileSync(join(dir, "notes.txt"), "utf8")).toContain("mine");
});

test("a file deleted on the server shows a bar, and only Save brings it back; ⌘K in Monaco is Monaco's", async ({ page }) => {
  const dir = fixtureDir("m4del");
  const file = join(dir, "gone.txt");
  writeFileSync(file, "still here\n");
  startSession(del, dir);

  const term = await openSessionTab(page, dir);
  const ws = page.locator(".wb");
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

test("⌘W closes the open file from anywhere in the window, saving it first", async ({ page }) => {
  const dir = fixtureDir("m4w");
  writeFileSync(join(dir, "readme.md"), "# Read me\n");
  writeFileSync(join(dir, "code.txt"), "some code\n");
  startSession(closeW, dir);

  const term = await openSessionTab(page, dir);
  const ws = page.locator(".wb");
  const fileTabs = ws.locator(".ftabs .tab");
  await ws.locator(".tree").getByText("readme.md").click();
  await expect(ws.locator(".md-view h1")).toHaveText("Read me");
  await ws.locator(".tree").getByText("code.txt").click();
  const editor = ws.locator(".monaco-editor .view-lines");
  await expect(editor).toContainText("some code");
  await expect(fileTabs).toHaveCount(2);

  // Edits not saved yet: ⌘W saves them, then closes. No prompt.
  await editor.click();
  await page.keyboard.type("edited ");
  await page.keyboard.press("Meta+w");
  await expect(fileTabs).toHaveCount(1);
  expect(readFileSync(join(dir, "code.txt"), "utf8")).toContain("edited ");
  await expect(ws.locator(".fbar")).toHaveCount(0);

  // ⌘W with the quick-open sheet up closes the sheet, not the file behind it.
  await page.keyboard.press("Meta+p");
  const quick = page.getByPlaceholder("Open a file by name");
  await expect(quick).toBeFocused();
  await page.keyboard.press("Meta+w");
  await expect(quick).toHaveCount(0);
  await expect(fileTabs).toHaveCount(1);

  // From the terminal too, as in VS Code. With no file left, ⌘W does nothing.
  await term.locator(".xterm").click();
  await page.keyboard.press("Meta+w");
  await expect(fileTabs).toHaveCount(0);
  await page.keyboard.press("Meta+w");
  await expect(term.locator(".xterm")).toBeVisible();
});

test("the active file tab scrolls into view, and the Markdown Edit toggle stays visible", async ({ page }) => {
  const dir = fixtureDir("m4tabs");
  const names = [
    "first-file-name.txt",
    "second-file-name.txt",
    "third-file-name.txt",
    "fourth-file-name.txt",
    "fifth-file-name.txt",
    "sixth-file-name.txt",
    "seventh-file-name.txt",
    "eighth-file-name.md",
  ];
  for (const n of names) writeFileSync(join(dir, n), n.endsWith(".md") ? "# Eighth\n" : `${n}\n`);
  startSession(tabs, dir);

  await openSessionTab(page, dir);
  const ws = page.locator(".wb");
  const strip = ws.locator(".ftabs");
  // Fully inside the strip's visible box (the strip scrolls sideways with no scrollbar).
  const shown = (el: string) =>
    ws.locator(el).evaluate((t) => {
      const box = (t.closest(".ftabs") ?? t.closest(".ftabs-bar"))!.getBoundingClientRect();
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
