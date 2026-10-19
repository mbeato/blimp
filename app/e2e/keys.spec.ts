// Shift+Enter: a new line in a Claude session (ESC CR, which Claude Code reads as one), a plain
// Enter in a shell. `cat -v` shows what the session got: ESC as ^[.

import { expect, test } from "@playwright/test";
import { fixtureDir, killSession, openSessionTab, screenText, sessionRow, startSession } from "./helpers";

const pid = process.pid;
const claude = `blimpe2e-keysc-${pid}`;
const shell = `blimpe2e-keyss-${pid}`;

test.afterAll(() => [claude, shell].forEach(killSession));

test("Shift+Enter sends a new line to Claude and a plain Enter to a shell", async ({ page }) => {
  // The word "claude" in the command is what makes blimpd call it a Claude session.
  startSession(claude, fixtureDir("keys-claude"), ["sh", "-c", "exec cat -v", "claude"]);
  startSession(shell, fixtureDir("keys-shell"), ["sh", "-c", "exec cat -v"]);

  let term = await openSessionTab(page, fixtureDir("keys-claude"), claude);
  // Listed: the app knows from the server that it's a Claude session (Shift+Enter depends on it).
  await expect(sessionRow(page, claude)).toBeVisible();
  await term.locator(".xterm").click();
  await page.keyboard.type("one");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("two\n");
  await expect.poll(() => screenText(term)).toContain("one^[");

  term = await openSessionTab(page, fixtureDir("keys-shell"), shell);
  await term.locator(".xterm").click();
  await page.keyboard.type("three");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("four\n");
  await expect.poll(() => screenText(term)).toContain("four");
  expect(await screenText(term)).not.toContain("^[");
});
