// The server browser's Chrome (docs/superpowers/specs/2026-10-20-server-browser-design.md): which
// one, its flags, and a launch that talks over the debugging pipe, so Chrome opens no port that
// another user on the server could reach. Only blimpd holds the pipe; sessions come in through the
// gate (gate.ts).

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

export type CdpMessage = { id?: number; method?: string; params?: any; result?: any; error?: any; sessionId?: string };

// Chrome or Chromium on PATH, else the newest Playwright Chromium (Playwright builds for arm64
// servers too; Chrome for Testing doesn't). null: none.
export function findChrome(home = homedir(), which: (n: string) => string | null = (n) => Bun.which(n)): string | null {
  for (const n of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    const p = which(n);
    if (p) return p;
  }
  const root = join(home, ".cache", "ms-playwright");
  let dirs: string[] = [];
  try {
    dirs = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d));
  } catch {}
  dirs.sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
  for (const d of dirs)
    for (const sub of ["chrome-linux64", "chrome-linux"]) {
      const p = join(root, d, sub, "chrome");
      if (existsSync(p)) return p;
    }
  return null;
}

// Chrome's own user agent says "HeadlessChrome", which sites like Google answer with robot
// checks. This is the one a normal Chrome of that version sends (minor version zeroed, as Chrome
// does). versionOutput: what `chrome --version` prints.
export function userAgentFor(versionOutput: string): string {
  const major = versionOutput.match(/(\d+)\.\d+\.\d+\.\d+/)?.[1] ?? "140";
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

// --password-store=basic: on a server with no desktop, Chrome otherwise waits on a keyring for the
// cookie key, and every page load hangs once its request is sent. Not --enable-automation (it
// marks the browser as automated); AutomationControlled off for the same reason.
export function chromeArgs(profileDir: string, ua: string): string[] {
  return [
    "--headless=new",
    "--remote-debugging-pipe",
    `--user-data-dir=${profileDir}`,
    "--password-store=basic",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-blink-features=AutomationControlled",
    `--user-agent=${ua}`,
    "about:blank",
  ];
}

export type Chrome = {
  send(m: CdpMessage): void;
  onMessage(f: (m: CdpMessage) => void): void;
  // A command of blimpd's own, answered by id (from 1e9 up, apart from the gate's).
  call(method: string, params?: any, sessionId?: string): Promise<CdpMessage>;
  exited: Promise<number | null>;
  kill(): void;
};

// Chrome reads commands on fd 3 and writes on fd 4, each a JSON message ended by a NUL byte.
export function launchChrome(path: string, profileDir: string): Chrome {
  const version = Bun.spawnSync([path, "--version"], { stdout: "pipe", stderr: "ignore" }).stdout.toString();
  const p = spawn(path, chromeArgs(profileDir, userAgentFor(version)), { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  const toChrome = p.stdio[3] as Writable;
  const fromChrome = p.stdio[4] as Readable;
  const listeners: ((m: CdpMessage) => void)[] = [];
  const waiting = new Map<number, (m: CdpMessage) => void>();
  let next = 1e9;
  let buf = "";
  fromChrome.on("data", (d: Buffer) => {
    buf += d.toString();
    for (let i; (i = buf.indexOf("\0")) >= 0; ) {
      let m: CdpMessage;
      try {
        m = JSON.parse(buf.slice(0, i));
      } catch {
        m = {};
      }
      buf = buf.slice(i + 1);
      const w = m.id !== undefined ? waiting.get(m.id) : undefined;
      if (w) {
        waiting.delete(m.id!);
        w(m);
      } else listeners.forEach((f) => f(m));
    }
  });
  // A write after Chrome is gone fails; exited says so.
  toChrome.on("error", () => {});
  const exited = new Promise<number | null>((done) => p.on("exit", (code) => done(code)));
  const send = (m: CdpMessage) => void toChrome.write(JSON.stringify(m) + "\0");
  return {
    send,
    onMessage: (f) => void listeners.push(f),
    call: (method, params = {}, sessionId) =>
      new Promise((done) => {
        const id = next++;
        waiting.set(id, done);
        send({ id, method, params, ...(sessionId && { sessionId }) });
      }),
    exited,
    kill: () => void p.kill(),
  };
}
