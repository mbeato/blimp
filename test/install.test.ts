// Runs install.sh against a local stand-in for the GitHub release, in a throwaway HOME.
// systemctl is stubbed to say there's no user systemd, so nothing here touches a real service.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "blimp-install-"));
const stubs = join(tmp, "stubs");
const blimpd = "#!/bin/sh\necho \"fake blimpd $*\"\n";
const sha = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

// What the fake release folder serves; each test sets it.
let release: Record<string, string> = {};
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  mkdirSync(stubs);
  writeFileSync(join(stubs, "systemctl"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(stubs, "systemctl"), 0o755);
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const body = release[new URL(req.url).pathname];
      return body === undefined ? new Response("not found", { status: 404 }) : new Response(body);
    },
  });
});

afterAll(() => {
  server?.stop(true);
  rmSync(tmp, { recursive: true, force: true });
});

// A fresh HOME with zmx already there (so the script doesn't download it), then install.sh.
async function install(url: string) {
  const home = mkdtempSync(join(tmp, "home-"));
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  writeFileSync(join(home, ".local", "bin", "zmx"), "#!/bin/sh\n");
  chmodSync(join(home, ".local", "bin", "zmx"), 0o755);
  const p = Bun.spawn(["sh", join(import.meta.dir, "..", "install.sh")], {
    env: { HOME: home, PATH: `${stubs}:/usr/local/bin:/usr/bin:/bin`, BLIMPD_URL: url, XDG_CONFIG_HOME: join(home, ".config") },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = [await new Response(p.stdout).text(), await new Response(p.stderr).text(), await p.exited];
  const bin = join(home, ".local", "bin", "blimpd");
  return { code, out, err, installed: existsSync(bin) ? readFileSync(bin, "utf8") : undefined };
}

const url = () => `http://127.0.0.1:${server.port}/v1/blimpd-linux-x64`;

describe("install.sh checks the release's SHA256SUMS", () => {
  test("a matching sum installs blimpd", async () => {
    release = {
      "/v1/blimpd-linux-x64": blimpd,
      "/v1/SHA256SUMS": `${sha("other")}  blimpd-linux-arm64\n${sha(blimpd)}  blimpd-linux-x64\n`,
    };
    const r = await install(url());
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.installed).toBe(blimpd);
    expect(r.out).toContain("fake blimpd install-hooks");
    // No user systemd and no XDG_RUNTIME_DIR: zmx would keep its sockets under a guessable /tmp name.
    expect(r.out).toContain("ZMX_DIR");
  });

  test("a wrong sum stops before installing", async () => {
    release = { "/v1/blimpd-linux-x64": blimpd, "/v1/SHA256SUMS": `${sha("tampered")}  blimpd-linux-x64\n` };
    const r = await install(url());
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("blimp: blimpd download doesn't match SHA256SUMS");
    expect(r.installed).toBeUndefined();
  });

  test("no SHA256SUMS, or no line for this file, stops too", async () => {
    release = { "/v1/blimpd-linux-x64": blimpd };
    let r = await install(url());
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("blimp: couldn't download SHA256SUMS");
    expect(r.installed).toBeUndefined();

    release = { "/v1/blimpd-linux-x64": blimpd, "/v1/SHA256SUMS": `${sha(blimpd)}  blimpd-linux-arm64\n` };
    r = await install(url());
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("blimp: SHA256SUMS has no line for blimpd-linux-x64");
    expect(r.installed).toBeUndefined();
  });

  test("a file:// BLIMPD_URL (a local build) needs no sums", async () => {
    const file = join(tmp, "blimpd-local");
    writeFileSync(file, blimpd);
    const r = await install(`file://${file}`);
    expect(r.code).toBe(0);
    expect(r.installed).toBe(blimpd);
  });
});
