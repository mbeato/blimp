// Kinds of session from the chevron next to +, and Settings > Models. The test blimpd has a fake
// codex first on its PATH (setup.ts) and its own home, so no real key or ~/.codex is touched.

import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { e2e, fixtureDir, frontTab, killSession, openSessionTab, PREFIX, screenText, splitTerm, startSession, zmxEnv } from "./helpers";

const pid = process.pid;
const seed = `${PREFIX}kinds-${pid}`;
const zmxNames = () =>
  execFileSync("zmx", ["list", "--short"], { env: zmxEnv(), encoding: "utf8", timeout: 10_000 }).split("\n").filter(Boolean);
// Sessions blimpd starts here are named after the folder, blimpe2e-kinds-<pid>-<time>.
test.afterAll(() => {
  for (const n of zmxNames()) if (n.startsWith(seed)) killSession(n);
});

const chevron = (page: any) => frontTab(page).getByRole("button", { name: "More kinds of session" });
// A click outside the menu closes it.
const closeMenu = (page: any) => frontTab(page).locator(".menu-scrim").click();

test("the chevron lists the server's kinds; Codex starts a session labelled Codex; GLM is greyed without a key", async ({ page }) => {
  const dir = fixtureDir(seed);
  startSession(seed, dir);
  await openSessionTab(page, dir, seed);

  await chevron(page).click();
  const menu = frontTab(page).locator(".kinds-menu");
  await expect(menu.getByRole("menuitem")).toHaveText([/^Claude Code⌘N$/, /^Claude Code on GLMAdd a Z.ai key in Settings$/, /^Codexnot signed in$/, "Shell", "Models and keys…"]);
  await expect(menu.getByRole("menuitem", { name: /Claude Code on GLM/ })).toBeDisabled();

  const before = zmxNames();
  await menu.getByRole("menuitem", { name: /^Codex/ }).click();
  await expect.poll(() => zmxNames().filter((n) => !before.includes(n)).length).toBe(1);
  const name = zmxNames().find((n) => !before.includes(n))!;
  expect(name.startsWith(`${seed}-`)).toBe(true);
  const row = frontTab(page).locator(`.srow[data-session="${name}"]`);
  await expect(row.locator(".kind-label")).toHaveText("Codex");
  await expect(row.locator(".srow-title")).toHaveText(name);
  await expect.poll(() => screenText(splitTerm(page, name))).toContain("fake codex []");
});

test("Settings > Models: a pasted key makes GLM available, Remove takes it away; Codex sign-in starts its session", async ({ page }) => {
  const dir = fixtureDir(seed);
  if (!zmxNames().includes(seed)) startSession(seed, dir);
  await openSessionTab(page, dir, seed);
  const keyFile = join(e2e().fixtures, ".config", "zai", "key");

  // The chevron's "Models and keys…" opens Settings at Models.
  await chevron(page).click();
  await page.getByRole("menuitem", { name: "Models and keys…" }).click();
  const models = page.locator(".dialog.settings").getByRole("region", { name: "Models" });
  await expect(models).toBeInViewport();
  await expect(models).toContainText("Not set");
  await expect(models).toContainText("Not signed in");

  const field = models.getByLabel("Z.ai key");
  await field.fill("zai-e2e-key.0123456789");
  await models.getByRole("button", { name: "Save" }).click();
  await expect(models).toContainText("Set");
  await expect(field).toHaveValue("");
  expect(statSync(keyFile).mode & 0o777).toBe(0o600);
  // The app keeps no copy of it.
  expect(JSON.stringify(await page.evaluate(() => ({ ...localStorage })))).not.toContain("zai-e2e-key");
  await page.keyboard.press("Escape");

  await chevron(page).click();
  await expect(frontTab(page).getByRole("menuitem", { name: /Claude Code on GLM/ })).toBeEnabled();
  await closeMenu(page);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await models.getByRole("button", { name: "Remove" }).click();
  await expect(models).toContainText("Not set");
  expect(existsSync(keyFile)).toBe(false);
  await page.keyboard.press("Escape");
  await chevron(page).click();
  await expect(frontTab(page).getByRole("menuitem", { name: /Claude Code on GLM/ })).toBeDisabled();
  await closeMenu(page);

  // Sign in: Settings closes, and `codex login --device-auth` runs in a session in this folder.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const before = zmxNames();
  await models.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator(".dialog.settings")).toHaveCount(0);
  await expect.poll(() => zmxNames().filter((n) => !before.includes(n)).length).toBe(1);
  const name = zmxNames().find((n) => !before.includes(n))!;
  await expect(frontTab(page).locator(`.srow[data-session="${name}"] .kind-label`)).toHaveText("Codex sign-in");
  await expect.poll(() => screenText(splitTerm(page, name))).toContain("fake codex [login --device-auth]");
});
