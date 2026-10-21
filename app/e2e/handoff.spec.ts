// Continue in New Session and the context meter. The parent is a stand-in Claude (cat, with a status
// file and a transcript); the test plays Claude's part: it writes the handoff file and the reply naming
// it. blimpd then starts the new session through the test blimpd's fake claude (setup.ts).

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { e2e, fixtureDir, frontTab, killSession, openApp, PREFIX, screenText, sessionRow, splitTerm, startSession, zmxEnv } from "./helpers";

const seed = `${PREFIX}handoff-${process.pid}`;
const zmxNames = () =>
  execFileSync("zmx", ["list", "--short"], { env: zmxEnv(), encoding: "utf8", timeout: 10_000 }).split("\n").filter(Boolean);
// The new session is named after the folder, blimpe2e-handoff-<pid>-<time>.
test.afterAll(() => {
  for (const n of zmxNames()) if (n.startsWith(seed)) killSession(n);
});

const line = (o: object) => JSON.stringify({ timestamp: new Date().toISOString(), ...o }) + "\n";

// A session blimpd takes for Claude Code, idle, with `lines` in its transcript.
function fakeClaude(name: string, dir: string, lines: string[]) {
  startSession(name, dir);
  const claude = process.env.BLIMP_E2E_CLAUDE!;
  const pid = execFileSync("zmx", ["list"], { env: zmxEnv(), encoding: "utf8" }).match(new RegExp(`name=${name}\\tpid=(\\d+)`))![1];
  const sid = crypto.randomUUID();
  mkdirSync(join(claude, "sessions"), { recursive: true });
  mkdirSync(join(claude, "projects", "fake"), { recursive: true });
  writeFileSync(join(claude, "sessions", `${pid}.json`), JSON.stringify({ sessionId: sid, cwd: dir, status: "idle" }));
  const transcript = join(claude, "projects", "fake", `${sid}.jsonl`);
  writeFileSync(transcript, lines.join(""));
  return transcript;
}

const usage = (used: number) =>
  line({ type: "assistant", message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "ok" }], usage: { input_tokens: used, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });

test("a session past half its context window has a thin bar under its row, red from 80%", async ({ page }) => {
  const dir = fixtureDir(seed);
  const half = `${seed}-a`;
  const full = `${seed}-b`;
  const low = `${seed}-c`;
  fakeClaude(half, dir, [usage(620_000)]);
  fakeClaude(full, dir, [usage(850_000)]);
  fakeClaude(low, dir, [usage(100_000)]);
  await openApp(page, { dir, session: low });
  const bar = (name: string) => sessionRow(page, name).locator(".ctx-meter");
  await expect(bar(half)).toHaveAttribute("aria-label", "Context 62% (620k of 1M tokens)");
  await expect(bar(half)).not.toHaveClass(/high/);
  await expect(bar(full)).toHaveClass(/high/);
  await expect(bar(low)).toHaveCount(0);
  // The row's tooltip says it too: the bar is too thin to point at.
  expect(await sessionRow(page, half).getAttribute("title")).toContain("Context 62% (620k of 1M tokens)");
  // The bar lies over the row's bottom edge without taking its clicks: those still open the session.
  const box = (await bar(half).boundingBox())!;
  const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest(".srow-main, .ctx-meter")?.className, { x: box.x + 5, y: box.y + 1 });
  expect(hit).toContain("srow-main");
  for (const n of [half, full, low]) killSession(n);
});

test("Continue in New Session: Claude writes the handoff, then the new session opens to its right, reading it", async ({ page }) => {
  const dir = fixtureDir(seed);
  const parent = `${seed}-p`;
  const transcript = fakeClaude(parent, dir, [line({ type: "user", message: { role: "user", content: "fix the login page" } })]);
  await openApp(page, { dir, session: parent });
  const row = sessionRow(page, parent);
  await expect(row.locator(".srow-title")).toHaveText("fix the login page");

  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Continue in New Session" }).click();
  await expect(row.locator(".srow-doing")).toHaveText("Writing handoff…");
  // The request was typed into the session (cat shows it).
  await expect.poll(() => screenText(splitTerm(page, parent))).toContain("Write a handoff so a fresh session can continue this work");

  // Claude's part: the file, then its reply naming it.
  mkdirSync(join(dir, "notes", "today"), { recursive: true });
  writeFileSync(join(dir, "notes", "today", "HANDOFF-login.md"), "# login page\n");
  appendFileSync(transcript, line({ type: "user", message: { role: "user", content: "Write a handoff so a fresh session can continue this work: …" } }));
  appendFileSync(transcript, line({ type: "assistant", cwd: dir, message: { role: "assistant", content: [{ type: "text", text: "notes/today/HANDOFF-login.md" }] } }));

  const child = frontTab(page).locator(".srow:has(.srow-parent)");
  await expect(child).toHaveCount(1, { timeout: 15_000 });
  const name = (await child.getAttribute("data-session"))!;
  expect(name.startsWith(`${seed}-`)).toBe(true);
  await expect(child.locator(".srow-parent")).toHaveAttribute("title", "Continued from fix the login page");
  await expect(row.locator(".srow-doing")).toHaveText("Handed off");
  // On screen beside the parent, on its right, started with the file to read.
  await expect(frontTab(page).locator(`.tsplit[data-split="${parent}"] .split-num`)).toHaveText("1");
  await expect(frontTab(page).locator(`.tsplit[data-split="${name}"] .split-num`)).toHaveText("2");
  // (A narrow split wraps it.)
  await expect.poll(async () => (await screenText(splitTerm(page, name))).replace(/\n/g, "")).toContain("-- Read notes/today/HANDOFF-login.md and do it]");
});

test("Continue in New Session is only for Claude sessions", async ({ page }) => {
  const dir = fixtureDir(seed);
  const shell = `${seed}-sh`;
  startSession(shell, dir);
  await openApp(page, { dir, session: shell });
  await sessionRow(page, shell).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Copy Reference" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Continue in New Session" })).toHaveCount(0);
});

test("Continue in New Session while Claude asks something says to answer it first", async ({ page }) => {
  const dir = fixtureDir(seed);
  const asking = `${seed}-q`;
  fakeClaude(asking, dir, [line({ type: "user", message: { role: "user", content: "deploy it" } })]);
  const { statusDir } = e2e();
  mkdirSync(statusDir, { recursive: true });
  writeFileSync(join(statusDir, `${asking}.json`), JSON.stringify({ state: "waiting", at: Date.now(), event: "Notification" }));
  await openApp(page, { dir, session: asking });
  await expect(sessionRow(page, asking).locator(".srow-doing")).toHaveText("Waiting for you");
  await sessionRow(page, asking).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Continue in New Session" }).click();
  await expect(page.locator(".toast")).toHaveText("Couldn't continue in a new session: Claude is asking something. Answer it first.");
  await expect(sessionRow(page, asking).locator(".srow-doing")).toHaveText("Waiting for you");
});
