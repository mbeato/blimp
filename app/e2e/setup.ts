// Starts a test blimpd on a temp socket and an SSH tunnel to it, the same tunnel the Rust shell
// builds. The specs read where to find them from the environment (workers inherit it).
// Max's own blimpd (~/.blimp) and Claude settings are never touched: the socket, token, hook
// status files and CLAUDE_CONFIG_DIR all live in the temp folder.

import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync } from "node:fs";
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

  const tmp = mkdtempSync(join(tmpdir(), "blimpe2e-"));
  chmodSync(tmp, 0o700);
  const sock = join(tmp, "blimpd.sock");
  mkdirSync(join(tmp, "claude"));
  // Fixture folders must be inside home: blimpd serves nothing outside it.
  const fixtures = realpathSync(mkdtempSync(join(homedir(), "blimpe2e-")));

  const log = openSync(join(tmp, "blimpd.log"), "a");
  const children: ChildProcess[] = [];
  // No pipes to children: a zmx daemon started under them would inherit and hold them open.
  const blimpd = spawn("bun", [join(repo, "src/main.ts"), "serve"], {
    env: { ...process.env, BLIMPD_SOCKET: sock, CLAUDE_CONFIG_DIR: join(tmp, "claude") },
    stdio: ["ignore", log, log],
  });
  children.push(blimpd);

  const teardown = async () => {
    await killTestSessions().catch(() => {});
    for (const c of children) c.kill();
    rmSync(fixtures, { recursive: true, force: true });
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
  } catch (e) {
    const logText = readFileSync(join(tmp, "blimpd.log"), "utf8").slice(-2000);
    await teardown();
    throw new Error(`${(e as Error).message}\nblimpd/ssh log:\n${logText}`, { cause: e });
  }
  return teardown;
}
