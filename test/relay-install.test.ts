// relay/install.sh (run by hand on the Mac): it parses, writes the LaunchAgent the relay depends on, and says how
// to share a relay.json it can't read.

import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import pkg from "../package.json";

const script = join(import.meta.dir, "..", "relay", "install.sh");

test("install.sh parses, and sets up the relay as a LaunchAgent that keeps it running", () => {
  expect(Bun.spawnSync(["bash", "-n", script]).exitCode).toBe(0);
  const s = readFileSync(script, "utf8");
  for (const want of ["dev.blimp.relay", "<key>KeepAlive</key><true/>", "<key>RunAtLoad</key><true/>", "codesign --force --sign -", 'chmod 600 "$app/relay.json"', "Privacy_AllFiles", "launchctl bootstrap"]) expect(s).toContain(want);
});

// root reads any file, so the unreadable one can't be made.
test.skipIf(process.getuid?.() === 0)("install.sh stops at a relay.json it can't read, saying how its owner shares it", () => {
  const d = mkdtempSync(join(tmpdir(), "blimp-install-"));
  try {
    const [shared, bin, home] = ["shared", "bin", "home"].map((x) => join(d, x));
    for (const x of [shared, bin, home]) mkdirSync(x);
    copyFileSync(script, join(shared, "install.sh"));
    writeFileSync(join(shared, "blimp-relay"), "");
    writeFileSync(join(shared, "relay.json"), "{}", { mode: 0o000 });
    for (const c of ["codesign", "launchctl"]) writeFileSync(join(bin, c), "#!/bin/sh\n", { mode: 0o755 });
    const r = Bun.spawnSync(["bash", join(shared, "install.sh")], { env: { HOME: home, PATH: `${bin}:${process.env.PATH}` } });
    expect(r.exitCode).toBe(1);
    expect(r.stdout.toString()).toContain(`chmod 600 '${shared}/relay.json' && chmod +a '${userInfo().username} allow read,delete' '${shared}/relay.json'`);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("bun run relay builds the Mac binary", () => {
  expect((pkg.scripts as Record<string, string>).relay).toBe("bun build relay/main.ts --compile --target=bun-darwin-arm64 --outfile dist/blimp-relay");
});
