// Visuals: a page a session showed (blimpd's show tool: POST /visuals) opens in a tab of its project, in a frame that
// runs its own scripts with blimp's kit and can make no request; the tab comes to the front and the terminal keeps
// the keyboard. Showing the same file again moves its tab to the new copy; another project's visual isn't shown here.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { cspViolations, e2e, fixtureDir, frontTab, frontTerm, killSession, openSessionTab, startSession } from "./helpers";

const here = `blimpe2e-visual-${process.pid}`;
const there = `blimpe2e-visual2-${process.pid}`;
test.afterAll(() => {
  killSession(here);
  killSession(there);
});

const PAGE = readFileSync(join(import.meta.dirname, "../../test/fixtures/visual.html"), "utf8");

// What the show tool does for a session (visuals/mcp.ts): POST /visuals with the Mac's token.
async function show(session: string, path: string, title: string) {
  const { base, token } = e2e();
  const r = await fetch(`${base}/visuals`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ session, path, title }),
  });
  expect(r.status).toBe(201);
  return ((await r.json()) as { id: string }).id;
}

test("a session's visual opens in its project's tab, locked down, with the kit; the terminal keeps the keyboard", async ({ page }) => {
  const dir = fixtureDir("visuals");
  const other = fixtureDir("visuals-other");
  writeFileSync(join(dir, "chart.html"), PAGE);
  writeFileSync(join(other, "theirs.html"), PAGE);
  startSession(here, dir);
  startSession(there, other);

  const term = await openSessionTab(page, dir);
  await term.click();
  const keys = term.locator(".xterm-helper-textarea");
  await expect(keys).toBeFocused();

  const id = await show(here, join(dir, "chart.html"), "Test results");
  const wb = frontTab(page);
  const tab = wb.locator(".visual-tab");
  await expect(tab).toHaveCount(1);
  await expect(tab).toHaveText(/Test results/);
  await expect(tab).toHaveAttribute("aria-selected", "true");

  const frame = wb.locator("iframe.visual-view");
  await expect(frame).toBeVisible();
  // Scripts, but no allow-same-origin: the page isn't the app's origin, nor blimpd's.
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  await expect(frame).toHaveAttribute("src", new RegExp(`/visuals/[0-9a-f]{64}/${id}$`));
  const doc = frame.contentFrame();
  await expect(doc.locator("h1")).toHaveText("Visual fixture");
  // The kit drew the chart and the diagram; both of the page's requests failed.
  await expect(doc.locator("pre.mermaid svg")).toBeVisible();
  await expect(doc.locator("#out")).toHaveText('{"chart":"drawn","requests":"rejected,rejected"}');
  await expect(keys).toBeFocused();

  // The same file again: the same tab, on the new copy.
  writeFileSync(join(dir, "chart.html"), PAGE.replace("<h1>Visual fixture</h1>", "<h1>Visual fixture, again</h1>"));
  const id2 = await show(here, join(dir, "chart.html"), "Test results, again");
  await expect(tab).toHaveCount(1);
  await expect(tab).toHaveText(/Test results, again/);
  await expect(frame).toHaveAttribute("src", new RegExp(`/visuals/[0-9a-f]{64}/${id2}$`));
  await expect(doc.locator("h1")).toHaveText("Visual fixture, again");

  // Another folder's session: not in this project.
  await show(there, join(other, "theirs.html"), "Theirs");
  await page.waitForTimeout(1000);
  await expect(tab).toHaveCount(1);

  // A link goes nowhere: the kit stops it (and the app's frame-src would refuse a website).
  await doc.locator("#away").click();
  await page.waitForTimeout(500);
  await expect(doc.locator("h1")).toHaveText("Visual fixture, again");

  // Closing it.
  await tab.getByRole("button", { name: /Close visual/ }).click();
  await expect(tab).toHaveCount(0);
  expect(await cspViolations(page)).toEqual([]);
});
