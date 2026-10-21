// The return card ("where was I?"): a Claude session that comes on screen after an hour or more away
// (or never shown on this Mac) gets a card at the top of its split, from blimpd's recap. Here blimpd's
// answer is a stand-in (the test blimpd has no model to ask).

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { fixtureDir, frontTab, killSession, openApp, sessionRow, startSession, zmxEnv } from "./helpers";

const name = `blimpe2e-recap-${process.pid}`;
const bare = `blimpe2e-recapb-${process.pid}`;

test.afterAll(() => (killSession(name), killSession(bare)));

// A session that looks like Claude to blimpd, with 3 prompts and replies.
function fakeClaude(session: string, dir: string) {
  const claude = process.env.BLIMP_E2E_CLAUDE!;
  startSession(session, dir);
  const pid = execFileSync("zmx", ["list"], { env: zmxEnv(), encoding: "utf8" }).match(new RegExp(`name=${session}\\tpid=(\\d+)`))![1];
  const sid = crypto.randomUUID();
  mkdirSync(join(claude, "sessions"), { recursive: true });
  mkdirSync(join(claude, "projects", "fake"), { recursive: true });
  writeFileSync(join(claude, "sessions", `${pid}.json`), JSON.stringify({ sessionId: sid, status: "idle" }));
  const line = (type: string, text: string) => JSON.stringify({ type, timestamp: new Date().toISOString(), message: { role: type, content: type === "user" ? text : [{ type: "text", text }] } });
  const lines = ["fix the login", "Fixed.", "add tests", "Added.", "ship it", "Shipped."].map((t, i) => line(i % 2 ? "assistant" : "user", t));
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

const card = (page: Page, session: string) => frontTab(page).locator(`.tsplit[data-split="${session}"] .recap-card`);

test("a session not on screen for an hour gets a card; dismissed, it stays away; right-click Recap brings it back", async ({ page }) => {
  const dir = fixtureDir("recap");
  fakeClaude(name, dir);
  const asked = await stubRecap(page, name, CARD);
  await openApp(page, { dir, session: name });
  await page.bringToFront();

  const c = card(page, name);
  await expect(c).toBeVisible({ timeout: 10_000 });
  await expect(c.locator(".recap-goal")).toHaveText(CARD.goal);
  await expect(c.getByRole("list", { name: "Done" }).locator("li")).toHaveText(CARD.done);
  await expect(c.getByRole("list", { name: "Open" }).locator("li")).toHaveText(CARD.open);
  expect(asked).toEqual(["3"]); // asked on its own: only with 3 prompts or more

  await c.getByRole("button", { name: "Dismiss recap" }).click();
  await expect(c).toHaveCount(0);

  // Back within the hour: no card.
  await page.reload();
  await expect(frontTab(page).locator(`.tsplit[data-split="${name}"] .xterm`)).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(card(page, name)).toHaveCount(0);
  expect(asked).toEqual(["3"]);

  await sessionRow(page, name).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Recap" }).click();
  await expect(card(page, name).locator(".recap-goal")).toHaveText(CARD.goal);
  expect(asked).toEqual(["3", ""]);
});

test("nothing shows when blimpd has no card for the session", async ({ page }) => {
  const dir = fixtureDir("recapb");
  fakeClaude(bare, dir);
  const asked = await stubRecap(page, bare, null);
  await openApp(page, { dir, session: bare });
  await page.bringToFront();
  await expect.poll(() => asked.length, { timeout: 10_000 }).toBe(1);
  await page.waitForTimeout(800);
  await expect(card(page, bare)).toHaveCount(0);
});
