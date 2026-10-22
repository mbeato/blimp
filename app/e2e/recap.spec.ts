// The return card ("where was I?"): a Claude session that comes on screen after an hour or more away
// (or never shown on this Mac) gets a card at the bottom of the session list, from blimpd's recap, or
// over the top of its split while the list is hidden. Here blimpd's answer is a stand-in (the test
// blimpd has no model to ask).

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { fixtureDir, frontTab, killSession, openApp, sessionRow, splitTerm, startSession, zmxEnv } from "./helpers";

const name = `blimpe2e-recap-${process.pid}`;
const bare = `blimpe2e-recapb-${process.pid}`;
const failing = `blimpe2e-recapf-${process.pid}`;
const withRun = `blimpe2e-recapr-${process.pid}`;
const old = `blimpe2e-recapo-${process.pid}`;
const kept = `blimpe2e-recapk-${process.pid}`;
const other = `blimpe2e-recaps-${process.pid}`;
const left = `blimpe2e-recapl-${process.pid}`;
const right = `blimpe2e-recapt-${process.pid}`;

test.afterAll(() => [name, bare, failing, withRun, old, kept, other, left, right].forEach(killSession));

// A session that looks like Claude to blimpd, with 3 prompts and replies.
function fakeClaude(session: string, dir: string, last = "Shipped.") {
  const claude = process.env.BLIMP_E2E_CLAUDE!;
  startSession(session, dir);
  const pid = execFileSync("zmx", ["list"], { env: zmxEnv(), encoding: "utf8" }).match(new RegExp(`name=${session}\\tpid=(\\d+)`))![1];
  const sid = crypto.randomUUID();
  mkdirSync(join(claude, "sessions"), { recursive: true });
  mkdirSync(join(claude, "projects", "fake"), { recursive: true });
  writeFileSync(join(claude, "sessions", `${pid}.json`), JSON.stringify({ sessionId: sid, status: "idle" }));
  const line = (type: string, text: string) => JSON.stringify({ type, timestamp: new Date().toISOString(), message: { role: type, content: type === "user" ? text : [{ type: "text", text }] } });
  const lines = ["fix the login", "Fixed.", "add tests", "Added.", "ship it", last].map((t, i) => line(i % 2 ? "assistant" : "user", t));
  writeFileSync(join(claude, "projects", "fake", `${sid}.jsonl`), lines.join("\n") + "\n");
}

const CARD = { goal: "Make the phone's login work again", done: ["Token refresh fixed", "Tests added"], open: ["Release v0.2.20"], at: Date.now() };

// blimpd's recap for `session`: the card, or a 404. Returns the queries the app asked with.
async function stubRecap(page: Page, session: string, card: object | null) {
  const asked: string[] = [];
  await page.route(`**/sessions/${session}/recap*`, (route) => {
    asked.push(new URL(route.request().url()).searchParams.get("min") ?? "");
    const headers = { "Access-Control-Allow-Origin": "*" };
    return card ? route.fulfill({ json: card, headers }) : route.fulfill({ status: 404, json: { error: "Not enough to recap yet" }, headers });
  });
  return asked;
}

// The card in the session list, and one over a session's terminal (only while the list is hidden).
const card = (page: Page) => frontTab(page).locator(".slist .recap-card");
const over = (page: Page, session: string) => frontTab(page).locator(`.tsplit[data-split="${session}"] .recap-card`);
const titleOf = (page: Page, session: string) => sessionRow(page, session).locator(".srow-title").innerText();
// Where each row of the list is.
const rowBoxes = (page: Page) => frontTab(page).locator(".slist-scroll > [data-item]").evaluateAll((els) => els.map((el) => JSON.stringify(el.getBoundingClientRect())));

test("a session not on screen for an hour gets a card; dismissed, it stays away; right-click Recap brings it back", async ({ page }) => {
  const dir = fixtureDir("recap");
  fakeClaude(name, dir);
  const asked = await stubRecap(page, name, CARD);
  await openApp(page, { dir, session: name });
  await page.bringToFront();

  const c = card(page);
  await expect(c).toBeVisible({ timeout: 10_000 });
  await expect(c.locator(".recap-goal")).toHaveText(CARD.goal);
  await expect(c.locator(".recap-session")).toHaveText(`Recap · ${await titleOf(page, name)}`);
  await expect(c.getByRole("list", { name: "Done" }).locator("li")).toHaveText(CARD.done);
  await expect(c.getByRole("list", { name: "Open" }).locator("li")).toHaveText(CARD.open);
  expect(asked).toEqual(["3"]); // asked on its own: only with 3 prompts or more

  // At the bottom of the session list, its width, and not over the terminal.
  const [l, k] = [(await frontTab(page).locator(".slist").boundingBox())!, (await c.boundingBox())!];
  expect(Math.abs(l.y + l.height - (k.y + k.height) - 8)).toBeLessThanOrEqual(1);
  expect(k.x).toBeGreaterThanOrEqual(l.x);
  expect(k.x + k.width).toBeLessThanOrEqual(l.x + l.width);
  await expect(over(page, name)).toHaveCount(0);
  const rows = await rowBoxes(page);

  // Closing it leaves the keyboard in the terminal, so you can type your reply straight away.
  const typing = frontTab(page).locator(`.tsplit[data-split="${name}"] .xterm-helper-textarea`);
  await typing.focus();
  await c.getByRole("button", { name: "Dismiss recap" }).click();
  await expect(c).toHaveCount(0);
  await expect(typing).toBeFocused();
  // The rows above didn't move when it went.
  expect(await rowBoxes(page)).toEqual(rows);

  // Back within the hour: no card.
  await page.reload();
  await expect(frontTab(page).locator(`.tsplit[data-split="${name}"] .xterm`)).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(card(page)).toHaveCount(0);
  expect(asked).toEqual(["3"]);

  await sessionRow(page, name).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Recap" }).click();
  await expect(card(page).locator(".recap-goal")).toHaveText(CARD.goal);
  expect(asked).toEqual(["3", ""]);
});

test("the card stays while another session is on screen, and a click on its session's name shows that one", async ({ page }) => {
  const dir = fixtureDir("recaps");
  fakeClaude(kept, dir);
  startSession(other, dir);
  await stubRecap(page, kept, CARD);
  await openApp(page, { dir, session: kept });
  await page.bringToFront();
  const c = card(page);
  await expect(c.locator(".recap-goal")).toHaveText(CARD.goal, { timeout: 10_000 });

  await sessionRow(page, other).locator(".srow-main").click();
  await expect(splitTerm(page, other)).toBeVisible();
  await expect(c.locator(".recap-goal")).toHaveText(CARD.goal);
  await c.locator(".recap-session").click();
  await expect(splitTerm(page, kept)).toBeVisible();
  await expect(splitTerm(page, other)).toBeHidden();
});

test("two splits: one card, for the session that came on screen last", async ({ page }) => {
  const dir = fixtureDir("recapl");
  fakeClaude(left, dir);
  fakeClaude(right, dir);
  await stubRecap(page, left, CARD);
  await stubRecap(page, right, { ...CARD, goal: "Speed up the build" });
  await openApp(page, { dir, session: left });
  await page.bringToFront();
  const c = card(page);
  await expect(c.locator(".recap-goal")).toHaveText(CARD.goal, { timeout: 10_000 });

  // Dragged onto the right half of the terminal: side by side.
  const row = (await sessionRow(page, right).boundingBox())!;
  const box = (await frontTab(page).locator(".tpane-terms").boundingBox())!;
  await page.mouse.move(row.x + 40, row.y + row.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect(splitTerm(page, right).locator(".xterm")).toBeVisible();

  await expect(c.locator(".recap-goal")).toHaveText("Speed up the build", { timeout: 10_000 });
  await expect(c).toHaveCount(1);
  await expect(c.locator(".recap-session")).toHaveText(`Recap · ${await titleOf(page, right)}`);
  await expect(frontTab(page).locator(".tsplit .recap-card")).toHaveCount(0);
});

test("nothing shows when blimpd has no card for the session", async ({ page }) => {
  const dir = fixtureDir("recapb");
  fakeClaude(bare, dir);
  const asked = await stubRecap(page, bare, null);
  await openApp(page, { dir, session: bare });
  await page.bringToFront();
  await expect.poll(() => asked.length, { timeout: 10_000 }).toBe(1);
  await page.waitForTimeout(800);
  await expect(card(page)).toHaveCount(0);
});

test("a Recap that fails leaves the card already showing", async ({ page }) => {
  const dir = fixtureDir("recapf");
  fakeClaude(failing, dir);
  const asked: string[] = [];
  let fail = false;
  await page.route(`**/sessions/${failing}/recap*`, (route) => {
    asked.push(new URL(route.request().url()).searchParams.get("min") ?? "");
    const headers = { "Access-Control-Allow-Origin": "*" };
    return fail ? route.fulfill({ status: 429, json: { error: "Too many recaps this hour" }, headers }) : route.fulfill({ json: CARD, headers });
  });
  await openApp(page, { dir, session: failing });
  await page.bringToFront();
  await expect(card(page).locator(".recap-goal")).toHaveText(CARD.goal, { timeout: 10_000 });

  fail = true;
  await sessionRow(page, failing).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Recap" }).click();
  await expect.poll(() => asked.length).toBe(2);
  await page.waitForTimeout(500);
  await expect(card(page).locator(".recap-goal")).toHaveText(CARD.goal);
});

test("a blimpd too old for recaps: no card on its own, and the menu's Recap says to update it", async ({ page }) => {
  const dir = fixtureDir("recapo");
  fakeClaude(old, dir);
  const asked: string[] = [];
  await page.route(`**/sessions/${old}/recap*`, (route) => {
    asked.push(new URL(route.request().url()).searchParams.get("min") ?? "");
    return route.fulfill({ status: 404, json: { error: "not found" }, headers: { "Access-Control-Allow-Origin": "*" } });
  });
  await openApp(page, { dir, session: old });
  await page.bringToFront();
  await expect.poll(() => asked.length, { timeout: 10_000 }).toBe(1);
  await page.waitForTimeout(800);
  await expect(card(page)).toHaveCount(0);
  await expect(page.locator(".toast")).toHaveCount(0);

  await sessionRow(page, old).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Recap" }).click();
  await expect(page.locator(".toast")).toHaveText("This server's blimpd is too old for recaps. Update it first.");
  await expect(card(page)).toHaveCount(0);
});

test("with the session list hidden, the card shows over the terminal, under the Run bar, and its × still works", async ({ page }) => {
  const dir = fixtureDir("recapr");
  fakeClaude(withRun, dir, "Run it:\n```bash\nbun test\n```");
  await stubRecap(page, withRun, CARD);
  await openApp(page, { dir, session: withRun });
  await page.bringToFront();
  const split = frontTab(page).locator(`.tsplit[data-split="${withRun}"]`);
  const bar = split.locator(".runbar");
  await expect(bar).toBeVisible({ timeout: 10_000 });
  await expect(card(page)).toBeVisible({ timeout: 10_000 });
  await expect(over(page, withRun)).toHaveCount(0);

  const sessions = page.getByRole("button", { name: "Sessions", exact: true });
  await sessions.click();
  await expect(frontTab(page).locator(".slist")).toBeHidden();
  const c = over(page, withRun);
  await expect(c.locator(".recap-goal")).toHaveText(CARD.goal);
  // No session name over its own terminal.
  await expect(c.locator(".recap-session")).toHaveCount(0);
  const [b, k] = [(await bar.boundingBox())!, (await c.boundingBox())!];
  expect(k.y).toBeGreaterThanOrEqual(b.y + b.height);

  // Back in the list when the list comes back.
  await sessions.click();
  await expect(card(page)).toBeVisible();
  await expect(over(page, withRun)).toHaveCount(0);
  await sessions.click();
  await c.getByRole("button", { name: "Dismiss recap" }).click();
  await expect(c).toHaveCount(0);
  await sessions.click();
  await expect(card(page)).toHaveCount(0);
});
