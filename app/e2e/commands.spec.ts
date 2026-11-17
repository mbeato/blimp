// The commands added with the table in src/lib/commands.ts: moving through the project tabs by
// key, text size keys, and the Keyboard Shortcuts dialog. (The shortcuts that were there before
// keep their own specs: tabs, settings, m4-files, workbench, browser, tree.)

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { e2e, fixtureDir, frontTab, killSession, openApp, openSessionTab, projectTab, startSession } from "./helpers";

const session = `blimpe2e-commands-${process.pid}`;
// A session of its own: a name already running keeps the folder it was started in.
const late = `blimpe2e-commands-late-${process.pid}`;
test.afterAll(() => {
  killSession(session);
  killSession(late);
});

const tab = (dir: string | null) => ({ server: "localhost", dir, panes: [], focus: 0, groups: [] });

test("⇧⌘] and ⇧⌘[ move through the project tabs and wrap around", async ({ page }) => {
  const a = fixtureDir("cmd-tabs-a");
  const b = fixtureDir("cmd-tabs-b");
  const layout = { tabs: [tab(null), tab(a), tab(b)], active: 1, show: { files: true, term: true, sessions: true, browsers: true } };
  const { base, token } = e2e();
  await page.goto(`/?${new URLSearchParams({ blimpd: base, token, layout: JSON.stringify(layout) })}`);
  await expect(projectTab(page, "cmd-tabs-a")).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("Meta+Shift+BracketRight");
  await expect(projectTab(page, "cmd-tabs-b")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Meta+Shift+BracketRight");
  await expect(projectTab(page, "Home")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Meta+Shift+BracketLeft");
  await expect(projectTab(page, "cmd-tabs-b")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Meta+Shift+BracketLeft");
  await expect(projectTab(page, "cmd-tabs-a")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".ptab")).toHaveCount(3);
});

test("⌘+, ⌘- and ⌘0 change the terminal and editor text size settings", async ({ page }) => {
  await openApp(page);
  await expect(page.locator(".welcome-page h1")).toHaveText("blimp");
  const sizes = () =>
    page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem("blimp.settings") ?? "null");
      return s && [s.terminalFontSize, s.editorFontSize];
    });

  await page.keyboard.press("Meta+Equal");
  await expect.poll(sizes).toEqual([14, 14]);
  await page.keyboard.press("Meta+Minus");
  await page.keyboard.press("Meta+Minus");
  await expect.poll(sizes).toEqual([12, 12]);
  await page.keyboard.press("Meta+Digit0");
  await expect.poll(sizes).toEqual([13, 13]);

  await page.keyboard.press("Meta+Equal");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.locator(".dialog.settings").getByLabel("Terminal text size")).toHaveValue("14");
});

test("in the editor, a key after ⌘K is Monaco's chord (⌘K ⌘0 folds), not a text size; ⌘0 alone still is", async ({ page }) => {
  const dir = fixtureDir("cmd-chord");
  writeFileSync(join(dir, "a.txt"), "one\n");
  startSession(session, dir);
  await openSessionTab(page, dir);
  const sizes = () =>
    page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem("blimp.settings") ?? "null");
      return s && [s.terminalFontSize, s.editorFontSize];
    });
  await frontTab(page).locator(".tree").getByText("a.txt").click();
  const editor = frontTab(page).locator(".monaco-editor .view-lines");
  await expect(editor).toContainText("one");
  await editor.click();

  await page.keyboard.press("Meta+Equal");
  await expect.poll(sizes).toEqual([14, 14]);
  await page.keyboard.press("Meta+k");
  await page.keyboard.press("Meta+Digit0");
  await page.keyboard.press("Meta+k");
  await page.keyboard.press("Meta+Equal");
  await page.waitForTimeout(300);
  expect(await sizes()).toEqual([14, 14]);
  await expect(page.locator(".dialog.palette")).toHaveCount(0);
  await page.keyboard.press("Meta+Digit0");
  await expect.poll(sizes).toEqual([13, 13]);
});

test("in the editor, ⌘K is let go after 5 s, as Monaco lets its chord go: ⌘0 is then the text size", async ({ page }) => {
  // The page's clock, moved on by hand instead of waiting 5 s.
  await page.clock.install();
  const dir = fixtureDir("cmd-chord-late");
  writeFileSync(join(dir, "a.txt"), "one\n");
  startSession(late, dir);
  await openSessionTab(page, dir);
  const sizes = () =>
    page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem("blimp.settings") ?? "null");
      return s && [s.terminalFontSize, s.editorFontSize];
    });
  await frontTab(page).locator(".tree").getByText("a.txt").click();
  const editor = frontTab(page).locator(".monaco-editor .view-lines");
  await expect(editor).toContainText("one");
  await editor.click();

  await page.keyboard.press("Meta+Equal");
  await expect.poll(sizes).toEqual([14, 14]);
  await page.keyboard.press("Meta+k");
  await page.clock.fastForward(6000);
  await page.keyboard.press("Meta+Digit0");
  await expect.poll(sizes).toEqual([13, 13]);
});

test("All shortcuts on Welcome opens the Keyboard Shortcuts dialog, made from the commands", async ({ page }) => {
  await openApp(page);
  await page.locator(".welcome-page").getByRole("button", { name: "All shortcuts" }).click();
  const dialog = page.locator(".dialog.shortcuts");
  await expect(dialog.getByRole("heading", { name: "Keyboard shortcuts" })).toBeVisible();
  const file = dialog.getByRole("region", { name: "File", exact: true });
  await expect(file.locator("dt", { hasText: /^⌘O$/ })).toBeVisible();
  await expect(file).toContainText("Open Folder…");
  await expect(dialog.getByRole("region", { name: "Window" })).toContainText("⇧⌘]");
  await expect(dialog.getByRole("region", { name: "Terminal" })).toContainText("New line in Claude");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("with no server saved, ⌘, opens Settings over the Add server form and ⌘K does nothing", async ({ page }) => {
  // No ?blimpd: a browser has no server to default to, so this is the first run.
  await page.goto("/");
  await expect(page.locator(".addserver")).toBeVisible();
  await page.keyboard.press("Meta+k");
  await page.keyboard.press("Meta+,");
  const settings = page.locator(".dialog.settings");
  await expect(settings.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(settings).toContainText("Connect to a server to set its keys.");
  await expect(page.locator(".dialog.palette")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
  await expect(page.locator(".addserver")).toBeVisible();
});
