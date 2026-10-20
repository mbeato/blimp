// The session list's order: rows dragged within the list drop between rows and stay there (over
// a reload too); a row of a split group takes its whole group; a drag onto the terminal still
// splits.

import { expect, test, type Page } from "@playwright/test";
import { fixtureDir, frontTab, killSession, openApp, sessionRow, splitTerm, startSession } from "./helpers";

const pid = process.pid;
const a = `blimpe2e-ordera-${pid}`;
const b = `blimpe2e-orderb-${pid}`;
const c = `blimpe2e-orderc-${pid}`;

test.afterAll(() => [a, b, c].forEach(killSession));

const layoutOf = (page: Page) => JSON.parse(new URL(page.url()).searchParams.get("layout")!);

// The list's rows top to bottom: a session's name, or a split group's names.
const rows = (page: Page) =>
  frontTab(page)
    .locator(".slist-scroll > [data-item]")
    .evaluateAll((els) => els.map((el) => (el.classList.contains("sgroup") ? [...el.querySelectorAll(".srow")].map((r) => r.getAttribute("data-session")) : el.getAttribute("data-session"))));

// Drags a session's row to just above (or below) another row of the list, and lets go.
async function dragInList(page: Page, name: string, onto: string, where: "above" | "below") {
  const from = (await sessionRow(page, name).boundingBox())!;
  // The row, or the group it's in.
  const item = `.slist-scroll > [data-item][data-session="${onto}"], .slist-scroll > [data-item]:has(.srow[data-session="${onto}"])`;
  const to = (await frontTab(page).locator(item).boundingBox())!;
  await page.mouse.move(from.x + 40, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + 40, where === "above" ? to.y + 4 : to.y + to.height - 4, { steps: 10 });
  await expect(frontTab(page).locator(".slist-drop")).toHaveCount(1);
  // Not a split: nothing on the terminal says where it would land.
  await expect(frontTab(page).locator(".drop-zone")).toHaveCount(0);
  await page.mouse.up();
  await expect(frontTab(page).locator(".slist-drop")).toHaveCount(0);
}

test.beforeAll(async () => {
  const dir = fixtureDir("order");
  // zmx counts start times in seconds: a second apart, so newest first is c, b, a.
  startSession(a, dir);
  await new Promise((r) => setTimeout(r, 1100));
  startSession(b, dir);
  await new Promise((r) => setTimeout(r, 1100));
  startSession(c, dir);
});

test("a row dragged above another stays there, over a reload; a new order doesn't change what's shown", async ({ page }) => {
  const dir = fixtureDir("order");
  await openApp(page, { dir, session: c });
  await expect(splitTerm(page, c).locator(".xterm")).toBeVisible();
  await expect.poll(() => rows(page)).toEqual([c, b, a]);

  await dragInList(page, a, c, "above");
  await expect.poll(() => rows(page)).toEqual([a, c, b]);
  await expect.poll(() => layoutOf(page).tabs[1].order).toEqual([a, c, b]);
  // The drag wasn't a click: the terminal still shows c.
  expect(layoutOf(page).tabs[1].panes).toEqual([c]);

  // Down, below the last row.
  await dragInList(page, c, b, "below");
  await expect.poll(() => rows(page)).toEqual([a, b, c]);

  await page.reload();
  await expect(sessionRow(page, a)).toBeVisible();
  await expect.poll(() => rows(page)).toEqual([a, b, c]);
});

test("a row of a split group drags its whole group; a kept group too; and a drag onto the terminal still splits", async ({ page }) => {
  const dir = fixtureDir("order");
  await openApp(page, { dir, session: a });
  await expect(splitTerm(page, a).locator(".xterm")).toBeVisible();
  const terms = frontTab(page).locator(".tpane-terms");
  // Onto the terminal's right half: a split, as before.
  const row = (await sessionRow(page, c).boundingBox())!;
  const box = (await terms.boundingBox())!;
  await page.mouse.move(row.x + 40, row.y + row.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2, { steps: 10 });
  await expect(terms.locator(".drop-zone")).toBeVisible();
  await expect(frontTab(page).locator(".slist-drop")).toHaveCount(0);
  await page.mouse.up();
  await expect.poll(() => layoutOf(page).tabs[1].panes).toEqual([a, c]);
  await expect(splitTerm(page, c).locator(".xterm")).toBeVisible();
  // A new window, no order yet: newest first, the pair where c is.
  await expect.poll(() => rows(page)).toEqual([[a, c], b]);

  // c's row takes the pair below b, in its split order.
  await dragInList(page, c, b, "below");
  await expect.poll(() => rows(page)).toEqual([b, [a, c]]);
  await expect.poll(() => layoutOf(page).tabs[1].order).toEqual([b, a, c]);
  await expect.poll(() => layoutOf(page).tabs[1].panes).toEqual([a, c]);

  // b on its own: the pair is kept, and still drags as one, from either row.
  await sessionRow(page, b).locator(".srow-main").click();
  await expect.poll(() => layoutOf(page).tabs[1].groups).toEqual([[a, c]]);
  await expect(frontTab(page).locator(".sgroup.kept")).toHaveCount(1);
  await dragInList(page, a, b, "above");
  await expect.poll(() => rows(page)).toEqual([[a, c], b]);
  // Never inside the group: b let go between a and c goes above the pair or below it.
  const pair = (await frontTab(page).locator(".sgroup").boundingBox())!;
  const from = (await sessionRow(page, b).boundingBox())!;
  await page.mouse.move(from.x + 40, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(pair.x + 40, pair.y + pair.height / 2 - 2, { steps: 10 });
  await page.mouse.up();
  await expect.poll(() => rows(page)).toEqual([b, [a, c]]);
  expect(layoutOf(page).tabs[1].panes).toEqual([b]);
});
