// M3: a session that starts waiting shows as waiting within 5 s, and the app calls notify().

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { e2e, fixtureDir, killSession, notifications, openApp, sessionRow, startSession } from "./helpers";

const name = `blimpe2e-m3-${process.pid}`;
const shown = `blimpe2e-m3shown-${process.pid}`;

test.afterAll(() => (killSession(name), killSession(shown)));

test("waiting shows within 5 s and fires a notification", async ({ page }) => {
  const dir = fixtureDir("m3");
  startSession(name, dir);
  startSession(shown, dir);
  // The terminal shows the other session: no notification is sent for the one on screen.
  await openApp(page, { dir, session: shown });
  // Seen once first: the app doesn't announce sessions that were already waiting when it opened.
  const row = sessionRow(page, name);
  await expect(row).toBeVisible();
  await expect(row.locator(".dot")).toHaveCount(0);

  // What `blimpd hook` writes when Claude asks a question (a Notification hook).
  const { statusDir } = e2e();
  mkdirSync(statusDir, { recursive: true });
  writeFileSync(join(statusDir, `${name}.json`), JSON.stringify({ state: "waiting", at: Date.now(), event: "Notification" }));

  await expect(row.locator(".dot")).toBeVisible({ timeout: 5000 });
  // The fixtures folder is the test blimpd's home.
  const folder = "~" + dir.slice(e2e().fixtures.length);
  await expect
    .poll(() => notifications(page), { timeout: 5000 })
    .toContainEqual({ title: "(new session) is waiting for you", body: folder });
});
