// Starts a test blimpd on a temp socket and an SSH tunnel to it, the same tunnel the Rust shell
// builds. The specs read where to find them from the environment (workers inherit it).
// Max's own blimpd (~/.blimp), Claude settings and home folder are never touched: the socket,
// token, hook status files, CLAUDE_CONFIG_DIR and the test blimpd's home all live in the temp folder.

import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { killTestSessions } from "./helpers";

const repo = join(import.meta.dirname, "../..");

async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 15_000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) {
    if (await Promise.resolve().then(ok).catch(() => false)) return;
  }
  throw new Error(`e2e setup: timed out waiting for ${what}`);
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });

export default async function setup() {
  process.env.PATH = `${join(homedir(), ".local/bin")}:${join(homedir(), ".bun/bin")}:${process.env.PATH}`;
  // Inside a zmx session, `zmx attach` would switch sessions instead of creating one.
  delete process.env.ZMX_SESSION;

  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "blimpe2e-")));
  chmodSync(tmp, 0o700);
  const sock = join(tmp, "blimpd.sock");
  mkdirSync(join(tmp, "claude"));
  // The test blimpd's home, where the fixture folders go: blimpd serves nothing outside home.
  // The app shows them as ~/<name>, as a real user's folders would look in the screenshots.
  const fixtures = join(tmp, "home");
  mkdirSync(fixtures);

  // Stand-ins for claude and codex, for the test blimpd's login shell to find: they print what they
  // were started with and echo input. Max's real ones, his keys and ~/.codex are never used.
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  for (const cmd of ["claude", "codex"]) writeFileSync(join(bin, cmd), `#!/bin/sh\necho "fake ${cmd} [$*]"\nexec cat\n`, { mode: 0o755 });
  // The login shell's profile puts it on PATH, as nvm does for the real one (/etc/profile resets PATH).
  writeFileSync(join(fixtures, ".profile"), `PATH="${bin}:$PATH"\n`);

  const log = openSync(join(tmp, "blimpd.log"), "a");
  const children: ChildProcess[] = [];
  // No pipes to children: a zmx daemon started under them would inherit and hold them open.
  const blimpd = spawn("bun", [join(repo, "src/main.ts"), "serve"], {
    // SHELL: New shell starts a login shell in the empty home, where zsh would open its
    // first-run menu (and take the test's typing) for want of a .zshrc.
    env: { ...process.env, HOME: fixtures, SHELL: "/bin/bash", BLIMPD_SOCKET: sock, CLAUDE_CONFIG_DIR: join(tmp, "claude"), PATH: `${bin}:${process.env.PATH}`, CODEX_HOME: "" },
    stdio: ["ignore", log, log],
  });
  children.push(blimpd);

  const teardown = async () => {
    await killTestSessions().catch(() => {});
    for (const c of children) c.kill();
    rmSync(tmp, { recursive: true, force: true });
  };

  try {
    await until("blimpd's socket", () => existsSync(sock) && existsSync(join(tmp, "token")));
    const token = readFileSync(join(tmp, "token"), "utf8").trim();
    const port = await freePort();
    const host = process.env.BLIMP_E2E_HOST || "localhost";
    const ssh = spawn(
      "ssh",
      [
        "-N",
        ...["-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ControlMaster=no", "-o", "ControlPath=none"],
        ...["-L", `127.0.0.1:${port}:${sock}`, host],
      ],
      { stdio: ["ignore", log, log] },
    );
    children.push(ssh);
    const base = `http://127.0.0.1:${port}`;
    await until("the SSH tunnel", async () => (await fetch(`${base}/health`, { headers: { Authorization: `Bearer ${token}` } })).ok);

    process.env.BLIMP_E2E_BASE = base;
    process.env.BLIMP_E2E_TOKEN = token;
    process.env.BLIMP_E2E_STATUS = join(tmp, "status");
    process.env.BLIMP_E2E_FIXTURES = fixtures;
    process.env.BLIMP_E2E_CLAUDE = join(tmp, "claude");
  } catch (e) {
    const logText = readFileSync(join(tmp, "blimpd.log"), "utf8").slice(-2000);
    await teardown();
    throw new Error(`${(e as Error).message}\nblimpd/ssh log:\n${logText}`, { cause: e });
  }
  return teardown;
}
