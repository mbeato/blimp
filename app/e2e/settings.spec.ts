// Settings (⌘,): changes apply at once and are kept.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { fixtureDir, frontTab, frontTerm, killSession, openSessionTab, startSession } from "./helpers";

const session = `blimpe2e-settings-${process.pid}`;
test.afterAll(() => killSession(session));

test("theme, terminal text size and autosave apply at once and are kept over a reload", async ({ page }) => {
  const dir = fixtureDir("settings");
  writeFileSync(join(dir, "a.txt"), "one\n");
  startSession(session, dir);
  const term = await openSessionTab(page, dir);
  const rowHeight = () => term.locator(".xterm-rows > div").first().evaluate((e) => e.getBoundingClientRect().height);
  const before = await rowHeight();

  await page.keyboard.press("Meta+,");
  const dialog = page.locator(".dialog.settings");
  await expect(dialog.getByRole("heading", { name: "Settings" })).toBeVisible();
  await dialog.getByLabel("Theme").selectOption("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await dialog.getByLabel("Terminal text size").fill("20");
  await expect.poll(rowHeight).toBeGreaterThan(before + 4);
  await dialog.getByLabel("Autosave").uncheck();
  await page.keyboard.press("Escape");

  // Autosave off: an edit waits for ⌘S.
  await frontTab(page).locator(".tree").getByText("a.txt").click();
  await frontTab(page).locator(".monaco-editor .view-lines").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" two");
  await page.waitForTimeout(1800);
  expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("one\n");
  await page.keyboard.press("Meta+s");
  await expect.poll(() => readFileSync(join(dir, "a.txt"), "utf8")).toContain("two");

  await page.reload();
  await expect(frontTerm(page).locator(".xterm")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.locator(".dialog.settings").getByLabel("Terminal text size")).toHaveValue("20");
  await expect(page.locator(".dialog.settings").getByLabel("Autosave")).not.toBeChecked();
  await page.locator(".dialog.settings").getByRole("button", { name: "Reset all" }).click();
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", /./);
});
