// relay/install.sh (run by hand on the Mac): it parses, and writes the LaunchAgent the relay depends on.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "../package.json";

const script = join(import.meta.dir, "..", "relay", "install.sh");

test("install.sh parses, and sets up the relay as a LaunchAgent that keeps it running", () => {
  expect(Bun.spawnSync(["bash", "-n", script]).exitCode).toBe(0);
  const s = readFileSync(script, "utf8");
  for (const want of ["dev.blimp.relay", "<key>KeepAlive</key><true/>", "<key>RunAtLoad</key><true/>", "codesign --force --sign -", 'chmod 600 "$app/relay.json"', "Privacy_AllFiles", "launchctl bootstrap"]) expect(s).toContain(want);
});

test("bun run relay builds the Mac binary", () => {
  expect((pkg.scripts as Record<string, string>).relay).toBe("bun build relay/main.ts --compile --target=bun-darwin-arm64 --outfile dist/blimp-relay");
});
