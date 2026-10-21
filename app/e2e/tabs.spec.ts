// Project tabs along the top, the show/hide buttons at the top right, and terminal splits made by
// dragging a session from the list onto the terminal.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { e2e, fixtureDir, frontTab, frontTerm, killSession, openApp, openSessionTab, projectTab, screenText, sessionRow, splitTerm, startSession } from "./helpers";

const pid = process.pid;
const tabA = `blimpe2e-taba-${pid}`;
const tabB = `blimpe2e-tabb-${pid}`;
const left = `blimpe2e-splitl-${pid}`;
const right = `blimpe2e-splitr-${pid}`;
const toggled = `blimpe2e-toggle-${pid}`;
const ordered = `blimpe2e-order-${pid}`;

test.afterAll(() => [tabA, tabB, left, right, toggled, ...[0, 1, 2].map((i) => `${ordered}-${i}`)].forEach(killSession));

const jump = async (page: Page, name: string) => {
  await page.keyboard.press("Meta+k");
  await page.getByPlaceholder("Jump to a session").fill(name);
  await page.keyboard.press("Enter");
};

const layoutOf = (page: Page) => JSON.parse(new URL(page.url()).searchParams.get("layout")!);

test("each project tab keeps its files and terminal; tabs close, and come back after a reload and a new start", async ({ page }) => {
  const a = fixtureDir("tabs-a");
  const b = fixtureDir("tabs-b");
  writeFileSync(join(a, "a.txt"), "file in a\n");
  writeFileSync(join(b, "b.txt"), "file in b\n");
  startSession(tabA, a);
  startSession(tabB, b);

  const termA = await openSessionTab(page, a);
  await termA.locator(".xterm").click();
  await page.keyboard.type("typed-in-a\n");
  await expect.poll(() => screenText(termA)).toContain("typed-in-a");
  await frontTab(page).locator(".tree").getByText("a.txt").click();
  await expect(frontTab(page).locator(".ftabs .tab.active")).toHaveText(/a\.txt/);

  await jump(page, tabB);
  await expect(projectTab(page, "tabs-b")).toHaveAttribute("aria-selected", "true");
  await expect(frontTab(page).locator(".tree").getByText("b.txt")).toBeVisible();
  await expect(frontTab(page).locator(".ftabs")).toHaveCount(0);

  // Back to a: its open file and its terminal, as they were.
  await projectTab(page, "tabs-a").click();
  await expect(frontTab(page).locator(".ftabs .tab.active")).toHaveText(/a\.txt/);
  await expect.poll(() => screenText(frontTerm(page))).toContain("typed-in-a");

  // A reload keeps the tabs and the one in front.
  await page.reload();
  await expect(page.locator(".ptab")).toHaveCount(3);
  await expect(projectTab(page, "tabs-a")).toHaveAttribute("aria-selected", "true");
  await expect(sessionRow(page, tabA)).toHaveClass(/selected/);

  // So does a new start (no tabs in the URL): the last window's tabs reopen.
  const { base, token } = e2e();
  await page.goto(`/?${new URLSearchParams({ blimpd: base, token })}`);
  await expect(page.locator(".ptab")).toHaveCount(3);
  await expect(projectTab(page, "tabs-a")).toHaveAttribute("aria-selected", "true");

  // Closing the tab in front brings the next one forward. Home has no close button.
  await projectTab(page, "tabs-a").getByRole("button", { name: "Close tabs-a" }).click();
  await expect(page.locator(".ptab")).toHaveCount(2);
  await expect(projectTab(page, "tabs-b")).toHaveAttribute("aria-selected", "true");
  await expect(projectTab(page, "Home").getByRole("button")).toHaveCount(0);
  await expect.poll(() => layoutOf(page).tabs.map((t: { dir: string | null }) => t.dir)).toEqual([null, b]);
});

test("the buttons at the top right (and ⌘B, ⌘J, ⌘⌥B) show and hide files, terminal and sessions", async ({ page }) => {
  const dir = fixtureDir("tabs-toggle");
  startSession(toggled, dir);
  await openSessionTab(page, dir);
  const ws = frontTab(page);
  const files = page.getByRole("button", { name: "Files", exact: true });
  const terminal = page.getByRole("button", { name: "Terminal", exact: true });
  const sessions = page.getByRole("button", { name: "Sessions", exact: true });

  await expect(files).toHaveAttribute("aria-pressed", "true");
  await files.click();
  await expect(files).toHaveAttribute("aria-pressed", "false");
  await expect(ws.locator(".wb-tree")).toBeHidden();
  await page.keyboard.press("Meta+b");
  await expect(ws.locator(".wb-tree")).toBeVisible();

  // With no file open, hiding the terminal leaves the editor area saying how to open one.
  await terminal.click();
  await expect(ws.locator(".wb-term")).toBeHidden();
  await expect(ws.locator(".wb-editor")).toContainText("No file open");
  await page.keyboard.press("Meta+j");
  await expect(ws.locator(".wb-term")).toBeVisible();
  await expect(ws.locator(".wb-editor")).toBeHidden();

  await sessions.click();
  await expect(ws.locator(".slist")).toBeHidden();
  await expect(sessions).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("Meta+Alt+b");
  await expect(ws.locator(".slist")).toBeVisible();

  // They're the window's: kept over a reload.
  await files.click();
  await page.reload();
  await expect(frontTab(page).locator(".wb-tree")).toBeHidden();
  await expect(files).toHaveAttribute("aria-pressed", "false");
});

test("dragging a session onto the terminal splits it; splits move, close, and Esc cancels a drag", async ({ page }) => {
  const dir = fixtureDir("tabs-split");
  startSession(left, dir);
  startSession(right, dir);
  await openApp(page, { dir, session: left });
  await expect(splitTerm(page, left).locator(".xterm")).toBeVisible();
  await expect(sessionRow(page, right)).toBeVisible();

  const terms = frontTab(page).locator(".tpane-terms");
  // Drags a session's row to a point across the terminal (0..1 of its width).
  const drag = async (name: string, at: number, opts: { cancel?: boolean } = {}) => {
    const row = (await sessionRow(page, name).boundingBox())!;
    const box = (await terms.boundingBox())!;
    await page.mouse.move(row.x + 40, row.y + row.height / 2);
    await page.mouse.down();
    const to = { x: box.x + box.width * at, y: box.y + box.height / 2 };
    await page.mouse.move(to.x, to.y, { steps: 12 });
    await expect(terms.locator(".drop-zone")).toBeVisible();
    // The row itself moves with the pointer, held where it was grabbed (40 px in, mid-height),
    // and leaves an empty slot in the list.
    const ghost = page.locator(".drag-ghost");
    await expect(ghost).toBeVisible();
    await expect(ghost).toContainText(name);
    const g = (await ghost.boundingBox())!;
    expect(Math.abs(g.x + 40 - to.x)).toBeLessThanOrEqual(3);
    expect(Math.abs(g.y + g.height / 2 - to.y)).toBeLessThanOrEqual(3);
    expect(Math.abs(g.width - row.width)).toBeLessThanOrEqual(2);
    await expect(sessionRow(page, name)).toHaveClass(/dragging/);
    if (opts.cancel) await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect(terms.locator(".drop-zone")).toHaveCount(0);
  };
  const xOf = async (name: string) => (await frontTab(page).locator(`.tsplit[data-split="${name}"]`).boundingBox())!.x;

  // Onto the right half: a second split on the right, with the keyboard.
  await drag(right, 0.8);
  await expect(splitTerm(page, left)).toBeVisible();
  await expect(splitTerm(page, right).locator(".xterm")).toBeVisible();
  expect(await xOf(right)).toBeGreaterThan(await xOf(left));
  await expect.poll(() => layoutOf(page).tabs[1].panes).toEqual([left, right]);
  await page.keyboard.type("to-the-right\n");
  await expect.poll(() => screenText(splitTerm(page, right))).toContain("to-the-right");
  expect(await screenText(splitTerm(page, left))).not.toContain("to-the-right");
  await expect(sessionRow(page, right)).toHaveClass(/selected/);
  await expect(sessionRow(page, left)).toHaveClass(/shown/);

  // Onto the left half of the left split: it moves there, scrollback and all.
  await drag(right, 0.1);
  await expect.poll(() => layoutOf(page).tabs[1].panes).toEqual([right, left]);
  expect(await xOf(right)).toBeLessThan(await xOf(left));
  await expect.poll(() => screenText(splitTerm(page, right))).toContain("to-the-right");

  // Esc during a drag: nothing changes.
  await drag(left, 0.1, { cancel: true });
  await expect.poll(() => layoutOf(page).tabs[1].panes).toEqual([right, left]);

  // A split's × closes the split; the session keeps running and stays in the list.
  await frontTab(page).getByRole("button", { name: `Close split: ${right}` }).click();
  await expect(splitTerm(page, right)).toBeHidden();
  await expect(frontTab(page).locator(".tsplit-head")).toHaveCount(0);
  await expect(sessionRow(page, right)).toBeVisible();
  await expect.poll(() => layoutOf(page).tabs[1].panes).toEqual([left]);
  // A click in the list shows it in the (one) split instead.
  await sessionRow(page, right).locator(".srow-main").click();
  await expect.poll(() => layoutOf(page).tabs[1].panes).toEqual([right]);
  await expect.poll(() => screenText(splitTerm(page, right))).toContain("to-the-right");
});

// Splits [left, right] in the folder, by dragging right onto the right half.
async function splitTwo(page: Page, dir: string) {
  await openApp(page, { dir, session: left });
  await expect(splitTerm(page, left).locator(".xterm")).toBeVisible();
  const row = (await sessionRow(page, right).boundingBox())!;
  const box = (await frontTab(page).locator(".tpane-terms").boundingBox())!;
  await page.mouse.move(row.x + 40, row.y + row.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect.poll(() => layoutOf(page).tabs[1].panes).toEqual([left, right]);
}

test("the files, the session list and the splits can each be dragged wider and narrower", async ({ page }) => {
  const dir = fixtureDir("tabs-split");
  startSession(left, dir);
  startSession(right, dir);
  await splitTwo(page, dir);
  const ws = frontTab(page);
  const width = (css: string) => ws.locator(css).first().evaluate((e) => Math.round(e.getBoundingClientRect().width));
  const pull = async (name: string, dx: number) => {
    const b = (await ws.getByRole("separator", { name }).first().boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 + dx, b.y + b.height / 2, { steps: 8 });
    await page.mouse.up();
  };

  const tree = await width(".wb-tree");
  await pull("Resize files", 100);
  expect(Math.abs((await width(".wb-tree")) - (tree + 100))).toBeLessThanOrEqual(2);

  const list = await width(".slist");
  await pull("Resize sessions", -100);
  expect(Math.abs((await width(".slist")) - (list + 100))).toBeLessThanOrEqual(2);
  await pull("Resize sessions", 150);
  expect(Math.abs((await width(".slist")) - (list - 50))).toBeLessThanOrEqual(2);

  const before = await width(`.tsplit[data-split="${left}"]`);
  await pull("Resize split", -120);
  expect(await width(`.tsplit[data-split="${left}"]`)).toBeLessThan(before - 100);
});

test("right-click a session: Open in New Window moves it to a new window; Open All Splits moves the group", async ({ page, context }) => {
  const dir = fixtureDir("tabs-split");
  startSession(left, dir);
  startSession(right, dir);
  await splitTwo(page, dir);

  await sessionRow(page, right).click({ button: "right" });
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem")).toHaveText(["Open in New Window", "Open All Splits in New Window"]);
  const popup = context.waitForEvent("page");
  await menu.getByRole("menuitem", { name: "Open in New Window" }).click();
  const win = await popup;
  await expect(splitTerm(win, right).locator(".xterm")).toBeVisible();
  await expect(projectTab(win, "tabs-split")).toHaveAttribute("aria-selected", "true");
  // It left this window, which keeps the other split.
  await expect.poll(() => layoutOf(page).tabs[1].panes).toEqual([left]);
  await expect(menu).toHaveCount(0);
  await win.close();

  // Back as a split, then the whole group from a split's header.
  await splitTwo(page, dir);
  const popup2 = context.waitForEvent("page");
  await frontTab(page).locator(`.tsplit[data-split="${left}"] .tsplit-head`).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Open All Splits in New Window" }).click();
  const win2 = await popup2;
  await expect.poll(() => layoutOf(win2).tabs[1]?.panes).toEqual([left, right]);
  await expect(splitTerm(win2, left).locator(".xterm")).toBeVisible();
  await expect(splitTerm(win2, right).locator(".xterm")).toBeVisible();
  // This window doesn't pick one of them to fill its terminal again.
  await expect.poll(() => layoutOf(page).tabs[1].panes).toEqual([]);
  await expect(frontTab(page).locator(".tpane-terms")).toContainText("Pick a session on the right");
  await win2.close();
});

test("a session dragged out of the window opens in a new window", async ({ page, context }) => {
  const dir = fixtureDir("tabs-split");
  startSession(left, dir);
  startSession(right, dir);
  await splitTwo(page, dir);
  const head = (await frontTab(page).locator(`.tsplit[data-split="${right}"] .tsplit-head`).boundingBox())!;
  const popup = context.waitForEvent("page");
  await page.mouse.move(head.x + 60, head.y + head.height / 2);
  await page.mouse.down();
  await page.mouse.move(head.x + 200, head.y + 100, { steps: 5 });
  await page.mouse.move(-40, 300, { steps: 5 });
  await page.mouse.up();
  const win = await popup;
  await expect(splitTerm(win, right).locator(".xterm")).toBeVisible();
  await expect.poll(() => layoutOf(page).tabs[1].panes).toEqual([left]);
  await win.close();
});

test("the splits on screen show as a group: joined, numbered like their headers; the tab says how many", async ({ page }) => {
  const dir = fixtureDir("tabs-split");
  startSession(left, dir);
  startSession(right, dir);
  await openApp(page, { dir, session: left });
  await expect(frontTab(page).locator(".sgroup")).toHaveCount(0);
  await splitTwo(page, dir);
  const group = frontTab(page).locator(".sgroup");
  await expect(group.locator(".srow")).toHaveCount(2);
  await expect(group.locator(".srow").nth(0)).toHaveAttribute("data-session", left);
  await expect(group.locator(".srow").nth(1)).toHaveAttribute("data-session", right);
  await expect(group.locator(".split-num")).toHaveText(["1", "2"]);
  await expect(frontTab(page).locator(".tsplit-head .split-num")).toHaveText(["1", "2"]);
  await expect(frontTab(page).locator(`.tsplit[data-split="${right}"] .split-num`)).toHaveText("2");
  await expect(projectTab(page, "tabs-split").locator(".ptab-count")).toHaveText("2");
  // Swapped: the list follows the splits' order.
  const row = (await sessionRow(page, right).boundingBox())!;
  const box = (await frontTab(page).locator(".tpane-terms").boundingBox())!;
  await page.mouse.move(row.x + 40, row.y + row.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.1, box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect(group.locator(".srow").nth(0)).toHaveAttribute("data-session", right);
  // One split alone: no group, no count. (A split's × shows on hover, or while it's focused.)
  await frontTab(page).locator(`.tsplit[data-split="${left}"] .tsplit-head`).hover();
  await frontTab(page).getByRole("button", { name: `Close split: ${left}` }).click();
  await expect(group).toHaveCount(0);
  await expect(projectTab(page, "tabs-split").locator(".ptab-count")).toHaveCount(0);
});

test("as in VS Code: clicking another session keeps the split group; clicking either of its sessions brings both back", async ({ page }) => {
  const dir = fixtureDir("tabs-split");
  const third = `blimpe2e-splitt-${pid}`;
  startSession(left, dir);
  startSession(right, dir);
  // zmx counts start times in seconds: a second later, so it's the newest.
  await new Promise((r) => setTimeout(r, 1100));
  startSession(third, dir);
  try {
    await splitTwo(page, dir);
    await sessionRow(page, third).locator(".srow-main").click();
    await expect.poll(() => layoutOf(page).tabs[1].panes).toEqual([third]);
    expect(layoutOf(page).tabs[1].groups).toEqual([[left, right]]);
    // The kept group still shows in the list, joined and numbered.
    await expect(frontTab(page).locator(".sgroup.kept .srow")).toHaveCount(2);
    // Newest first: the session started last is above the older pair.
    const order = () => frontTab(page).locator(".slist-scroll .srow").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-session")));
    await expect.poll(order).toEqual([third, left, right]);
    await expect(splitTerm(page, left)).toBeHidden();

    await sessionRow(page, right).locator(".srow-main").click();
    await expect.poll(() => layoutOf(page).tabs[1].panes).toEqual([left, right]);
    expect(layoutOf(page).tabs[1].focus).toBe(1);
    await expect(splitTerm(page, left)).toBeVisible();
    await expect(splitTerm(page, right)).toBeVisible();
    await expect(frontTab(page).locator(".sgroup.kept")).toHaveCount(0);
    // On screen again, the pair stays below it.
    await expect.poll(order).toEqual([third, left, right]);
  } finally {
    killSession(third);
  }
});

// Project tabs drag into another order (Home stays first), kept with the window's layout.
test("project tabs drag into another order; Home stays first", async ({ page }) => {
  const dirs = ["ptab-1", "ptab-2", "ptab-3"].map(fixtureDir);
  dirs.forEach((d, i) => startSession(`${ordered}-${i}`, d));
  await openSessionTab(page, dirs[0]);
  for (const i of [1, 2]) {
    await jump(page, `${ordered}-${i}`);
    await expect(projectTab(page, `ptab-${i + 1}`)).toHaveAttribute("aria-selected", "true");
  }
  const names = () => page.locator(".ptab").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  await expect.poll(names).toEqual(["Home", "ptab-1", "ptab-2", "ptab-3"]);
  const drag = async (name: string, x: number) => {
    const b = (await projectTab(page, name).boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(x, b.y + b.height / 2, { steps: 8 });
    await page.mouse.up();
  };
  // ptab-3 to before ptab-1; it was in front, and still is.
  await drag("ptab-3", (await projectTab(page, "ptab-1").boundingBox())!.x + 2);
  await expect.poll(names).toEqual(["Home", "ptab-3", "ptab-1", "ptab-2"]);
  await expect(projectTab(page, "ptab-3")).toHaveAttribute("aria-selected", "true");
  // Onto Home: it goes after Home, never before it.
  await drag("ptab-2", 0);
  await expect.poll(names).toEqual(["Home", "ptab-2", "ptab-3", "ptab-1"]);
  await page.reload();
  await expect.poll(names).toEqual(["Home", "ptab-2", "ptab-3", "ptab-1"]);
});
