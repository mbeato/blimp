// Shared by the specs: zmx sessions named blimpe2e-*, and the app opened against the test blimpd.

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";

// Every session a test makes starts with this, and only those are ever killed.
export const PREFIX = "blimpe2e-";

export const e2e = () => ({
  base: process.env.BLIMP_E2E_BASE!,
  token: process.env.BLIMP_E2E_TOKEN!,
  statusDir: process.env.BLIMP_E2E_STATUS!,
  fixtures: process.env.BLIMP_E2E_FIXTURES!, // the test blimpd's home
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

const sh = (a: string) => `'${a.replace(/'/g, `'\\''`)}'`;

// Like startSession, but from a PTY of 120x36 (as blimpd's POST /sessions does), so the session
// has a real size from the start and what it prints before anyone attaches is on its screen.
// The PTY's client is killed once the session is listed and has had a moment to print.
export async function startSessionPty(name: string, dir: string, cmd: string[] = ["cat"]) {
  if (!name.startsWith(PREFIX)) throw new Error(`test sessions must be named ${PREFIX}*`);
  const line = `stty cols 120 rows 36; exec zmx attach ${[name, ...cmd].map(sh).join(" ")}`;
  const client = spawn("script", ["-qfec", line, "/dev/null"], { cwd: dir, env: zmxEnv(), stdio: ["pipe", "ignore", "ignore"] });
  try {
    for (const end = Date.now() + 10_000; ; await new Promise((r) => setTimeout(r, 100))) {
      const list = execFileSync("zmx", ["list", "--short"], { env: zmxEnv(), encoding: "utf8", timeout: 10_000 });
      if (list.split("\n").includes(name)) break;
      if (Date.now() > end) throw new Error(`zmx session ${name} didn't start`);
    }
    await new Promise((r) => setTimeout(r, 300));
  } finally {
    client.kill();
  }
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

// Records what the app hands the web Notification API (the browser build's notify()), and every
// content security policy violation (window.__csp).
// place: open on that folder (and session) instead of Home, as a reload or a new window would.
export async function openApp(page: Page, place: { dir?: string; session?: string } = {}) {
  await page.addInitScript(() => {
    const csp: string[] = [];
    (window as any).__csp = csp;
    document.addEventListener("securitypolicyviolation", (e) => csp.push(`${e.effectiveDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}:${e.columnNumber}`));
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
  const q = new URLSearchParams({ blimpd: base, token, ...(place.dir && { server: "localhost", dir: place.dir }), ...(place.session && { session: place.session }) });
  await page.goto(`/?${q}`);
}

export const cspViolations = (page: Page) => page.evaluate(() => (window as any).__csp as string[]);

export const notifications = (page: Page) => page.evaluate(() => (window as any).__notifications as { title: string; body?: string }[]);

// A running session's row in the front tab's session list.
export const sessionRow = (page: Page, name: string) => page.locator(`.wb:not([hidden]) .srow[data-session="${name}"]`);

// Opens the folder as the window's project; the terminal pane shows the session (or the folder's
// only one).
export async function openSessionTab(page: Page, dir: string, session?: string) {
  await openApp(page, { dir, session });
  const term = frontTerm(page);
  await expect(term.locator(".xterm")).toBeVisible();
  return term;
}

// The tab in front's workbench (other tabs stay mounted, hidden), and its focused split's terminal
// (or its only one).
export const frontTab = (page: Page) => page.locator(".wb:not([hidden])");
export const frontTerm = (page: Page) => frontTab(page).locator(".tpane-terms .term:not([hidden])").first();

// A split's terminal, by session.
export const splitTerm = (page: Page, name: string) => frontTab(page).locator(`.tsplit[data-split="${name}"] .term`);

// The project tabs along the top.
export const projectTab = (page: Page, name: string) => page.locator(".ptabs").getByRole("tab", { name, exact: true });

// The terminal's text, from xterm's DOM renderer (the config turns WebGL off, so xterm uses it).
export const screenText = (term: ReturnType<Page["locator"]>) =>
  term.locator(".xterm-rows").innerText().then((t) => t.replace(/ /g, " "));
