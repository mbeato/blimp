// M2: blimp and a second zmx client (what `claude1 -a` is) on one session; typing in either
// shows in both.

import { spawn, type ChildProcess } from "node:child_process";
import { expect, test } from "@playwright/test";
import { fixtureDir, killSession, openApp, openSessionTab, screenText, startSession, startSessionPty, zmxEnv } from "./helpers";

const name = `blimpe2e-m2-${process.pid}`;
const early = `blimpe2e-m2early-${process.pid}`;
let other: ChildProcess | undefined;

test.afterAll(() => {
  other?.kill();
  killSession(name);
  killSession(early);
});

test("the first open shows what the session printed before anyone attached", async ({ page }) => {
  const dir = fixtureDir("m2early");
  await startSessionPty(early, dir, ["sh", "-c", "printf 'printed-before-attach\\n'; exec cat"]);
  await openApp(page);
  const term = await openSessionTab(page, dir);
  await expect.poll(() => screenText(term)).toContain("printed-before-attach");
  // Still there once the tab has settled (fit, focus): nothing clears it after data arrived.
  await page.waitForTimeout(500);
  expect(await screenText(term)).toContain("printed-before-attach");
});

// Escape sequences out, so the text can be searched.
const plain = (s: string) => s.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-Z\\-_]/g, "");

test("typing in blimp and in a second client shows in both", async ({ page }) => {
  const dir = fixtureDir("m2");
  // The session runs cat, so the terminal echoes whatever either client types.
  startSession(name, dir);
  await openApp(page);
  const term = await openSessionTab(page, dir);

  // The second client gets a real PTY from script(1), like a terminal running `zmx attach`.
  let seen = "";
  other = spawn("script", ["-qfec", `stty cols 100 rows 30; exec zmx attach ${name}`, "/dev/null"], {
    env: zmxEnv(),
    stdio: ["pipe", "pipe", "ignore"],
  });
  other.stdout!.on("data", (d: Buffer) => (seen += d.toString("utf8")));
  await expect.poll(() => seen.length, { message: "second client attached" }).toBeGreaterThan(0);

  await term.locator(".xterm").click();
  await page.keyboard.type("typed-in-blimp");
  await expect.poll(() => plain(seen), { message: "blimp's typing shows in the other client" }).toContain("typed-in-blimp");
  await expect.poll(() => screenText(term)).toContain("typed-in-blimp");

  other.stdin!.write("typed-in-pty");
  await expect.poll(() => screenText(term), { message: "the other client's typing shows in blimp" }).toContain("typed-in-pty");
});
