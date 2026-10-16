// M3: a session that starts waiting shows as waiting within 5 s, and the app calls notify().

import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { e2e, fixtureDir, folderRow, killSession, notifications, openApp, startSession } from "./helpers";

const name = `blimpe2e-m3-${process.pid}`;

test.afterAll(() => killSession(name));

test("waiting shows within 5 s and fires a notification", async ({ page }) => {
  const dir = fixtureDir("m3");
  startSession(name, dir);
  await openApp(page);
  // Seen once first: the app doesn't announce sessions that were already waiting when it opened.
  await expect(folderRow(page, dir)).toBeVisible();

  // What `blimpd hook` writes when Claude asks a question (a Notification hook).
  const { statusDir } = e2e();
  mkdirSync(statusDir, { recursive: true });
  writeFileSync(join(statusDir, `${name}.json`), JSON.stringify({ state: "waiting", at: Date.now(), event: "Notification" }));

  // blimpd reports home and session folders with symlinks resolved.
  const folder = "~" + dir.slice(realpathSync(homedir()).length);
  const waitingRow = page.locator(".waiting-group .row", { hasText: folder });
  await expect(waitingRow).toBeVisible({ timeout: 5000 });
  await expect(folderRow(page, dir).locator(".row-state")).toHaveText("waiting for you");
  await expect
    .poll(() => notifications(page), { timeout: 5000 })
    .toContainEqual({ title: "(new session) is waiting for you", body: folder });
});
