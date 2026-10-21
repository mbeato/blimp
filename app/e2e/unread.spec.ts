// A reply you haven't seen: a blue dot on its row, until the session is on screen in a focused window
// (the same unread the phone shows, kept by blimpd).

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { fixtureDir, killSession, openApp, sessionRow, startSession, zmxEnv } from "./helpers";

const name = `blimpe2e-unread-${process.pid}`;
const other = `blimpe2e-unreadb-${process.pid}`;

test.afterAll(() => (killSession(name), killSession(other)));

test("a new reply shows a blue dot until its session is on screen", async ({ page }) => {
  const claude = process.env.BLIMP_E2E_CLAUDE!;
  const dir = fixtureDir("unread");
  startSession(name, dir);
  startSession(other, dir);
  // name looks like Claude to blimpd, with a reply after blimpd started
  const pid = execFileSync("zmx", ["list"], { env: zmxEnv(), encoding: "utf8" }).match(new RegExp(`name=${name}\\tpid=(\\d+)`))![1];
  const sid = crypto.randomUUID();
  mkdirSync(join(claude, "sessions"), { recursive: true });
  mkdirSync(join(claude, "projects", "fake"), { recursive: true });
  writeFileSync(join(claude, "sessions", `${pid}.json`), JSON.stringify({ sessionId: sid, status: "idle" }));
  const reply = { type: "assistant", timestamp: new Date(Date.now() + 1000).toISOString(), message: { content: [{ type: "text", text: "Done." }] } };
  writeFileSync(join(claude, "projects", "fake", `${sid}.jsonl`), JSON.stringify(reply) + "\n");

  await openApp(page, { dir, session: other });
  await page.bringToFront();
  const row = sessionRow(page, name);
  await expect(row.locator(".unread-dot")).toBeVisible({ timeout: 5000 });
  await row.locator(".srow-main").click();
  await expect(row.locator(".unread-dot")).toHaveCount(0, { timeout: 5000 });
});
