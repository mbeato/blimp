// A hostile Markdown file can't freeze or blank the window. marked is quadratic on long runs of
// emphasis and recurses on deep nesting until the stack runs out; the app parses in a worker
// with a time limit, so the file shows a note instead and the sidebar and terminals carry on.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { fixtureDir, killSession, openSessionTab, startSession } from "./helpers";

const name = `blimpe2e-mddos-${process.pid}`;

test.afterAll(() => killSession(name));

test("Markdown that is slow or too deep for marked shows a note, and the window keeps working", async ({ page }) => {
  const dir = fixtureDir("mddos");
  writeFileSync(join(dir, "slow.md"), "_a ".repeat(20000)); // 59 KB, over 20 s on the main thread
  writeFileSync(join(dir, "deep.md"), ">".repeat(10000) + " a"); // RangeError in marked
  writeFileSync(join(dir, "fine.md"), "# Fine\n\nStill renders.\n");
  startSession(name, dir);

  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await openSessionTab(page, dir);
  const ws = page.locator(".wb");
  const tree = ws.locator(".tree");

  // The longest gap between timer ticks: how long the main thread was blocked.
  await page.evaluate(() => {
    const w = window as any;
    w.__maxGap = 0;
    let last = performance.now();
    setInterval(() => {
      const now = performance.now();
      w.__maxGap = Math.max(w.__maxGap, now - last);
      last = now;
    }, 50);
  });

  await tree.getByText("slow.md").click();
  await expect(ws.locator(".view-note", { hasText: "Can't show this Markdown: it took too long" })).toBeVisible({ timeout: 15_000 });
  expect(await page.evaluate(() => (window as any).__maxGap)).toBeLessThan(1000);

  await tree.getByText("deep.md").click();
  await expect(ws.locator(".view-note", { hasText: "Can't show this Markdown: Maximum call stack" })).toBeVisible({ timeout: 15_000 });
  expect(await page.evaluate(() => (window as any).__maxGap)).toBeLessThan(1000);

  // Still the whole app: the session list, the terminal, and other files render.
  await expect(page.locator(".srow").first()).toBeVisible();
  await expect(page.locator(".term:not([hidden]) .xterm")).toBeVisible();
  await tree.getByText("fine.md").click();
  await expect(ws.locator(".md-view h1")).toHaveText("Fine");
  expect(errors).toEqual([]);
});
