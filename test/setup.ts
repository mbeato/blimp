// Runs before the test files (bunfig.toml): the tests' zmx sessions go in a private socket folder, never
// the one you use. In the shared folder they showed in the live session list (the Mac's and the phone's)
// for as long as a run took, and one that a run failed to end stayed there. Short, so zmx 0.8's
// socket-path limit isn't hit. After the last test, whatever still runs there is ended and the folder goes.
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { parseZmxList, zmxPath } from "../src/sessions";

const dir = mkdtempSync("/tmp/bz-");
process.env.ZMX_DIR = dir;

afterAll(() => {
  const env = { ...process.env, ZMX_DIR: dir };
  delete env.ZMX_SESSION;
  const names = parseZmxList(Bun.spawnSync([zmxPath(), "list"], { env, stdout: "pipe", stderr: "ignore" }).stdout.toString()).map((s) => s.name);
  if (names.length) Bun.spawnSync([zmxPath(), "kill", ...names, "--force"], { env, stdout: "ignore", stderr: "ignore" });
  rmSync(dir, { recursive: true, force: true });
});
