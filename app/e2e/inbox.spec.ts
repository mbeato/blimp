// The project's inbox at the top of the session list: a session with a reply you haven't seen is under
// Done with Haiku's note, a click opens it (and so it leaves Done), and the summary folds to its counts.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "@playwright/test";
import { e2e, fixtureDir, killSession, openApp, sessionRow, startSession, zmxEnv } from "./helpers";

const name = `blimpe2e-inbox-${process.pid}`;
const other = `blimpe2e-inboxb-${process.pid}`;

test.afterAll(() => (killSession(name), killSession(other)));

test("a done session's note is in the inbox; a click opens it and it leaves; the summary folds", async ({ page }) => {
  const claude = process.env.BLIMP_E2E_CLAUDE!;
  const dir = fixtureDir("inbox");
  startSession(name, dir);
  startSession(other, dir);
  // name looks like Claude to blimpd, with a reply after blimpd started (no prompt, so blimpd never asks
  // Haiku for a note of its own) and a note on it
  const pid = execFileSync("zmx", ["list"], { env: zmxEnv(), encoding: "utf8" }).match(new RegExp(`name=${name}\\tpid=(\\d+)`))![1];
  const sid = crypto.randomUUID();
  mkdirSync(join(claude, "sessions"), { recursive: true });
  mkdirSync(join(claude, "projects", "fake"), { recursive: true });
  writeFileSync(join(claude, "sessions", `${pid}.json`), JSON.stringify({ sessionId: sid, status: "idle" }));
  const reply = { type: "assistant", timestamp: new Date(Date.now() + 1000).toISOString(), message: { content: [{ type: "text", text: "Released." }] } };
  writeFileSync(join(claude, "projects", "fake", `${sid}.jsonl`), JSON.stringify(reply) + "\n");
  const notes = join(dirname(e2e().statusDir), "notes.json");
  writeFileSync(notes, JSON.stringify({ [sid]: { status: "done", text: "released v0.2.16", at: Date.now(), turn: "1/1" } }));

  await openApp(page, { dir, session: other });
  await page.bringToFront();
  const box = page.locator(".wb:not([hidden]) .inbox");
  const line = box.getByRole("group", { name: "Done" }).locator(".inbox-line", { hasText: "released v0.2.16" });
  await expect(line).toBeVisible({ timeout: 5000 });

  await box.locator(".slist-fold").click();
  await expect(box.locator(".slist-fold")).toHaveText(/1 done/);
  await expect(line).toHaveCount(0);
  await box.locator(".slist-fold").click();

  await line.click();
  await expect(sessionRow(page, name)).toHaveClass(/selected/);
  await expect(box).toHaveCount(0, { timeout: 5000 });
});
