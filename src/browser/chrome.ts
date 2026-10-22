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
// servers too; Chrome for Testing doesn't), where Playwright keeps them: PLAYWRIGHT_BROWSERS_PATH,
// else ~/.cache/ms-playwright. null: none.
export function findChrome(home = homedir(), which: (n: string) => string | null = (n) => Bun.which(n), browsers = process.env.PLAYWRIGHT_BROWSERS_PATH): string | null {
  for (const n of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    const p = which(n);
    if (p) return p;
  }
  // macOS: Google Chrome's app (the iPhone app's simulator tests run blimpd on GitHub's Mac).
  const app = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (process.platform === "darwin" && existsSync(app)) return app;
  const root = browsers || join(home, ".cache", "ms-playwright");
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
const majorOf = (versionOutput: string) => versionOutput.match(/(\d+)\.\d+\.\d+\.\d+/)?.[1] ?? "140";
export function userAgentFor(versionOutput: string): string {
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${majorOf(versionOutput)}.0.0.0 Safari/537.36`;
}

// What a phone's view (view.ts) makes the tab say instead: Chrome on Android, the same version, so
// sites send their phone pages. versionOutput: `chrome --version`, or Browser.getVersion's product.
export function phoneUserAgentFor(versionOutput: string): string {
  return `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${majorOf(versionOutput)}.0.0.0 Mobile Safari/537.36`;
}

// --password-store=basic: on a server with no desktop, Chrome otherwise waits on a keyring for the
// cookie key, and every page load hangs once its request is sent; --use-mock-keychain is the same
// for macOS's Keychain. Not --enable-automation (it
// marks the browser as automated); AutomationControlled off for the same reason.
export function chromeArgs(profileDir: string, ua: string): string[] {
  return [
    "--headless=new",
    "--remote-debugging-pipe",
    `--user-data-dir=${profileDir}`,
    "--password-store=basic",
    "--use-mock-keychain",
    "--no-first-run",
    // Drawn at 2x, so a Retina Mac's view is sharp (the screencast ignores the emulated scale); a
    // view at 1x gets frames scaled down to its size (view.ts), and screenshots come at 2x.
    "--force-device-scale-factor=2",
    "--no-default-browser-check",
    "--disable-blink-features=AutomationControlled",
    `--user-agent=${ua}`,
    "about:blank",
  ];
}

export type Chrome = {
  send(m: CdpMessage): void;
  // Every message that isn't the answer to a call(); returns the unsubscribe.
  onMessage(f: (m: CdpMessage) => void): () => void;
  // A command of blimpd's own, answered by id (from 1e9 up, apart from the gate's).
  call(method: string, params?: any, sessionId?: string): Promise<CdpMessage>;
  exited: Promise<number | null>;
  kill(): void;
};

// What `chrome --version` says, once per binary (it takes a while).
const versions = new Map<string, string>();

// Chrome reads commands on fd 3 and writes on fd 4, each a JSON message ended by a NUL byte.
export function launchChrome(path: string, profileDir: string): Chrome {
  if (!versions.has(path)) versions.set(path, Bun.spawnSync([path, "--version"], { stdout: "pipe", stderr: "ignore" }).stdout.toString());
  const p = spawn(path, chromeArgs(profileDir, userAgentFor(versions.get(path)!)), { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  const toChrome = p.stdio[3] as Writable;
  const fromChrome = p.stdio[4] as Readable;
  const listeners: ((m: CdpMessage) => void)[] = [];
  const waiting = new Map<number, (m: CdpMessage) => void>();
  let next = 1e9;
  let gone = false;
  // Decoded as a stream, so a character split between chunks stays whole. Each chunk is searched
  // for the NUL from where the last search stopped, so a big message isn't scanned again and again.
  fromChrome.setEncoding("utf8");
  let buf = "";
  let from = 0;
  fromChrome.on("data", (d: string) => {
    buf += d;
    for (let i; (i = buf.indexOf("\0", from)) >= 0; from = 0) {
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
      } else [...listeners].forEach((f) => f(m)); // a listener may unsubscribe as it runs
    }
    from = buf.length;
  });
  // A write after Chrome is gone fails; exited says so.
  toChrome.on("error", () => {});
  // Once Chrome is gone, every call waiting for an answer, and every later one, gets an error.
  const exited = new Promise<number | null>((done) =>
    p.on("exit", (code) => {
      gone = true;
      for (const w of waiting.values()) w({ error: { message: "Chrome exited" } });
      waiting.clear();
      done(code);
    }),
  );
  const send = (m: CdpMessage) => void (gone || toChrome.write(JSON.stringify(m) + "\0"));
  return {
    send,
    onMessage: (f) => {
      listeners.push(f);
      return () => {
        const i = listeners.indexOf(f);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    call: (method, params = {}, sessionId) =>
      new Promise((done) => {
        if (gone) return done({ error: { message: "Chrome exited" } });
        const id = next++;
        waiting.set(id, done);
        send({ id, method, params, ...(sessionId && { sessionId }) });
      }),
    exited,
    kill: () => void p.kill(),
  };
}
