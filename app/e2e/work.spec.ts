// Which session is on what: a row's tooltip names its branch, the right-click menu opens the branch's pull
// requests, and ⌘K shows the branch beside the folder. Two sessions on one branch show no warning.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "@playwright/test";
import { e2e, fixtureDir, killSession, openApp, sessionRow, startSession, zmxEnv } from "./helpers";

const a = `blimpe2e-worka-${process.pid}`;
const b = `blimpe2e-workb-${process.pid}`;

test.afterAll(() => (killSession(a), killSession(b)));

test("two sessions on one branch that edited the same file show their branch and no warning; the PR opens from the menu", async ({ page }) => {
  const claude = process.env.BLIMP_E2E_CLAUDE!;
  // A stand-in gh, first on the test blimpd's PATH: three pull requests for the branch (gh's --limit 3).
  writeFileSync(
    join(dirname(claude), "bin", "gh"),
    `#!/bin/sh\nprintf '[{"number":42,"title":"Make %s work","state":"OPEN","url":"https://github.com/o/r/pull/42"},{"number":41,"title":"Try it","state":"CLOSED","url":"https://github.com/o/r/pull/41"},{"number":40,"title":"Start it","state":"MERGED","url":"https://github.com/o/r/pull/40"}]\\n' "$4"\n`,
    { mode: 0o755 },
  );
  const dir = fixtureDir("work");
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "feat");
  writeFileSync(join(dir, "a.ts"), "a");
  git("add", ".");
  git("commit", "-q", "-m", "a");

  startSession(a, dir);
  startSession(b, dir);
  const list = execFileSync("zmx", ["list"], { env: zmxEnv(), encoding: "utf8" });
  mkdirSync(join(claude, "sessions"), { recursive: true });
  mkdirSync(join(claude, "projects", "work"), { recursive: true });
  for (const [name, title] of [[a, "Fix the parser"], [b, "Tidy the parser"]]) {
    const pid = list.match(new RegExp(`name=${name}\\tpid=(\\d+)`))![1];
    const sid = crypto.randomUUID();
    writeFileSync(join(claude, "sessions", `${pid}.json`), JSON.stringify({ sessionId: sid, status: "idle" }));
    const at = new Date().toISOString();
    const lines = [
      { type: "custom-title", customTitle: title },
      { type: "assistant", timestamp: at, cwd: dir, message: { content: [{ type: "tool_use", id: `t-${name}`, name: "Edit", input: { file_path: join(dir, "a.ts") } }] } },
    ];
    writeFileSync(join(claude, "projects", "work", `${sid}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  }

  await page.addInitScript(() => {
    const opened: string[] = [];
    (window as any).__opened = opened;
    window.open = (url?: string | URL) => (opened.push(String(url)), null);
  });
  await openApp(page, { dir, session: b });
  const row = sessionRow(page, a);
  await expect(row).toHaveAttribute("title", /\nOn branch feat\n/, { timeout: 10_000 });
  await expect(sessionRow(page, b)).toHaveAttribute("title", /\nOn branch feat\n/);
  // No warning about the other session, in the row or its tooltips.
  for (const r of [row, sessionRow(page, b)]) await expect(r.locator('.srow-clash, [title*="Also on branch"], [title*="Both edited"]')).toHaveCount(0);
  await expect(row).not.toHaveAttribute("title", /Also on branch|Both edited/);

  // The PR is looked up after the checkout is found: it can come a tick later.
  const { base, token } = e2e();
  await expect(async () => {
    const sessions = await (await fetch(`${base}/sessions`, { headers: { Authorization: `Bearer ${token}` } })).json();
    expect(sessions.find((s: any) => s.name === a)?.work?.prs).toHaveLength(3);
  }).toPass({ timeout: 10_000 });
  // Then on the events socket's next list; a menu opened before it has no PR item yet, so close it and try again.
  await expect(async () => {
    await row.click({ button: "right" });
    const has = await page.getByRole("menuitem", { name: "Open PR #42" }).isVisible();
    if (!has) await page.keyboard.press("Escape");
    expect(has).toBe(true);
  }).toPass({ timeout: 5000 });
  await expect(page.getByRole("menuitem", { name: "Open PR #42" })).toHaveAttribute("title", "Make feat work (open)");
  await page.getByRole("menuitem", { name: "Open PR #42" }).click();
  expect(await page.evaluate(() => (window as any).__opened)).toEqual(["https://github.com/o/r/pull/42"]);

  // ⌘K: the branch beside the folder.
  await page.keyboard.press("Meta+k");
  const option = page.getByRole("option").filter({ hasText: "Fix the parser" });
  await expect(option.locator(".list-side")).toHaveText("~/work · feat");
  await page.keyboard.press("Escape");

  // Right-clicked low in the window, the menu with every item (a PR each: 9 here) still fits inside it.
  const h = page.viewportSize()!.height;
  await row.evaluate((el, y) => el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 100, clientY: y })), h - 10);
  const menu = page.locator(".context-menu");
  await expect(page.getByRole("menuitem", { name: "Open PR #40" })).toBeVisible();
  for (const name of ["Recap", "Continue in New Session", "Give a Secret…"]) await expect(page.getByRole("menuitem", { name })).toBeVisible();
  const box = (await menu.boundingBox())!;
  expect(box.height).toBeGreaterThan(200);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(h);
});
