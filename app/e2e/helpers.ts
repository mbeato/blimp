// Shared by the specs: zmx sessions named blimpe2e-*, and the app opened against the test blimpd.

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";

// Every session a test makes starts with this, and only those are ever killed.
export const PREFIX = "blimpe2e-";

export const e2e = () => ({
  base: process.env.BLIMP_E2E_BASE!,
  token: process.env.BLIMP_E2E_TOKEN!,
  statusDir: process.env.BLIMP_E2E_STATUS!,
  fixtures: process.env.BLIMP_E2E_FIXTURES!,
});

export function fixtureDir(name: string) {
  const dir = join(e2e().fixtures, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Inside a zmx session, ZMX_SESSION makes `zmx attach` switch sessions instead of creating one.
export function zmxEnv() {
  const env = { ...process.env };
  delete env.ZMX_SESSION;
  return env;
}

// `zmx attach NAME cmd` with stdin at /dev/null creates the session and detaches. No pipes: the
// session daemon would inherit them.
export function startSession(name: string, dir: string, cmd: string[] = ["cat"]) {
  if (!name.startsWith(PREFIX)) throw new Error(`test sessions must be named ${PREFIX}*`);
  execFileSync("zmx", ["attach", name, ...cmd], { cwd: dir, env: zmxEnv(), stdio: "ignore", timeout: 10_000 });
}

export function killSession(name: string) {
  if (!name.startsWith(PREFIX)) return;
  try {
    execFileSync("zmx", ["kill", name], { env: zmxEnv(), stdio: "ignore", timeout: 10_000 });
  } catch {}
}

// Leftovers from a failed run. Only names with our prefix.
export async function killTestSessions() {
  const out = execFileSync("zmx", ["list"], { env: zmxEnv(), encoding: "utf8", timeout: 10_000 });
  for (const m of out.matchAll(/name=(blimpe2e-[A-Za-z0-9_.-]+)/g)) killSession(m[1]);
}

// Records what the app hands the web Notification API (the browser build's notify()).
export async function openApp(page: Page) {
  await page.addInitScript(() => {
    const calls: { title: string; body?: string }[] = [];
    (window as any).__notifications = calls;
    (window as any).Notification = class {
      static permission = "granted";
      static requestPermission = async () => "granted";
      constructor(title: string, opts?: { body?: string }) {
        calls.push({ title, body: opts?.body });
      }
    };
  });
  const { base, token } = e2e();
  await page.goto(`/?blimpd=${encodeURIComponent(base)}&token=${token}`);
}

export const notifications = (page: Page) => page.evaluate(() => (window as any).__notifications as { title: string; body?: string }[]);

// A session's row in its folder group (the group header's tooltip is the folder's real path).
export const folderRow = (page: Page, dir: string) => page.locator(`.group:has(> .group-head[title="${dir}"]) .row`).first();

export async function openSessionTab(page: Page, dir: string) {
  await folderRow(page, dir).click();
  const term = page.locator(".term:not([hidden])");
  await expect(term.locator(".xterm")).toBeVisible();
  return term;
}

// The terminal's text, from xterm's DOM renderer (the config turns WebGL off, so xterm uses it).
export const screenText = (term: ReturnType<Page["locator"]>) =>
  term.locator(".xterm-rows").innerText().then((t) => t.replace(/ /g, " "));
