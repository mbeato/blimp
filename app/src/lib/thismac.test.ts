import { expect, test } from "bun:test";
import { setUpThisMac, type Step } from "./thismac";

// The errors as the Rust shell words them (Local::connect and wait_healthy in src-tauri/src).
const notSetUp = "blimpd isn't set up on this Mac: No such file or directory (os error 2)";
const noAnswer = "blimpd on this Mac didn't answer within 10 seconds";

// connect answers each call in turn from `replies` (an Error rejects); install answers `installed`.
function stubs(replies: (Error | "ok")[], installed: boolean | Error = true) {
  const steps: Step[] = [];
  let connects = 0;
  let installs = 0;
  const run = setUpThisMac({
    connect: async () => {
      const r = replies[connects++];
      if (r instanceof Error) throw r;
      return {};
    },
    install: async () => {
      installs++;
      if (installed instanceof Error) throw installed;
      return installed;
    },
    step: (s) => steps.push(s),
  });
  return { run, steps, connects: () => connects, installs: () => installs };
}

test("already set up: connects, nothing installed", async () => {
  const s = stubs(["ok"]);
  expect(await s.run).toBe(true);
  expect(s.steps).toEqual(["connect"]);
  expect(s.installs()).toBe(0);
});

test("not set up: installs, then connects", async () => {
  const s = stubs([new Error(notSetUp), "ok"]);
  expect(await s.run).toBe(true);
  expect(s.steps).toEqual(["connect", "install", "connect"]);
  expect(s.installs()).toBe(1);
});

test("doesn't answer: installs (which starts it again), then connects", async () => {
  const s = stubs([new Error(noAnswer), "ok"]);
  expect(await s.run).toBe(true);
  expect(s.steps).toEqual(["connect", "install", "connect"]);
});

test("Cancel in the Mac's dialog: false, and no second connect", async () => {
  const s = stubs([new Error(notSetUp)], false);
  expect(await s.run).toBe(false);
  expect(s.connects()).toBe(1);
});

test("another error on the first connect: thrown, nothing installed", async () => {
  const s = stubs([new Error("Couldn't open a local port: x")]);
  await expect(s.run).rejects.toThrow("Couldn't open a local port: x");
  expect(s.installs()).toBe(0);
});

test("the install fails: its error", async () => {
  const s = stubs([new Error(notSetUp)], new Error("Installing blimpd on this Mac failed: curl: (6) Could not resolve host: github.com"));
  await expect(s.run).rejects.toThrow("Installing blimpd on this Mac failed: curl: (6) Could not resolve host: github.com");
});

test("the connect after the install fails: its error", async () => {
  const s = stubs([new Error(notSetUp), new Error(noAnswer)]);
  await expect(s.run).rejects.toThrow(noAnswer);
  expect(s.steps).toEqual(["connect", "install", "connect"]);
});
