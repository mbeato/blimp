// `blimpd push-key` and `blimpd push-test` (src/push/cli.ts), in temp folders, against a stand-in for Apple.

import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http2 from "node:http2";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPushKey, runPushTest } from "../src/push/cli";
import { addDevice, devicesFile, type PushEnv, readCreds, readDevices, saveCreds } from "../src/push/store";

const root = mkdtempSync(join(tmpdir(), "blimp-push-cli-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = () => {
  const d = join(root, String(n++));
  mkdirSync(d);
  return d;
};
const p8 = () => generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;

// What a command printed, and its exit code.
async function printed(f: () => number | Promise<number>) {
  const out: string[] = [];
  const err: string[] = [];
  const l = spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  const e = spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.join(" ")));
  try {
    const code = await f();
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    l.mockRestore();
    e.mockRestore();
  }
}

// Apple's stand-in: 410 for the phone whose token is all b's, 200 for the rest.
const apple = http2.createServer();
apple.on("stream", (stream, headers) => {
  stream.on("data", () => {});
  stream.on("end", () => {
    const gone = String(headers[":path"]).endsWith("b".repeat(64));
    stream.respond({ ":status": gone ? 410 : 200 });
    stream.end(gone ? JSON.stringify({ reason: "Unregistered" }) : undefined);
  });
});
let hosts: Record<PushEnv, string>;
beforeAll(async () => {
  await new Promise<void>((r) => apple.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(apple.address() as { port: number }).port}`;
  hosts = { production: url, development: url };
});
afterAll(() => apple.close());

test("push-key: the key file and both ids, or the usage", async () => {
  const dir = fresh();
  const file = join(dir, "AuthKey_ABC123DEFG.p8");
  writeFileSync(file, p8());
  expect((await printed(() => runPushKey([], dir))).err).toContain("usage: blimpd push-key");
  expect((await printed(() => runPushKey([file, "--key-id", "ABC123DEFG"], dir))).code).toBe(1);
  expect((await printed(() => runPushKey([join(dir, "nope.p8"), "--key-id", "ABC123DEFG", "--team-id", "1A2B3C4D5E"], dir))).err).toContain("can't read");
  const r = await printed(() => runPushKey([file, "--key-id", "ABC123DEFG", "--team-id", "1A2B3C4D5E"], dir));
  expect(r.code).toBe(0);
  expect(r.out).toContain("Push key saved");
  expect(readCreds(dir)?.keyId).toBe("ABC123DEFG");
});

test("push-key: a file that isn't a key says so, and saves nothing", async () => {
  const dir = fresh();
  const file = join(dir, "x.p8");
  writeFileSync(file, "hello");
  const r = await printed(() => runPushKey([file, "--team-id", "1A2B3C4D5E", "--key-id", "ABC123DEFG"], dir));
  expect(r.code).toBe(1);
  expect(r.err).toContain("isn't a private key");
  expect(readCreds(dir)).toBeUndefined();
});

test("push-test: says what's missing first, the key, then a phone", async () => {
  const dir = fresh();
  expect((await printed(() => runPushTest(dir, hosts))).err).toContain("no push key yet");
  saveCreds(p8(), "ABC123DEFG", "1A2B3C4D5E", dir);
  expect((await printed(() => runPushTest(dir, hosts))).err).toContain("no phone has asked");
});

test("push-test: Apple's answer for each phone, and one Apple says is gone is removed", async () => {
  const dir = fresh();
  saveCreds(p8(), "ABC123DEFG", "1A2B3C4D5E", dir);
  addDevice("a".repeat(64), "production", 1, devicesFile(dir));
  addDevice("b".repeat(64), "development", 2, devicesFile(dir));
  const r = await printed(() => runPushTest(dir, hosts));
  expect(r.code).toBe(0);
  expect(r.out).toContain("aaaaaaaa… (production): sent");
  expect(r.out).toContain("bbbbbbbb… (development): Apple said 410 (Unregistered); removed it");
  expect(readDevices(devicesFile(dir)).map((d) => d.token[0])).toEqual(["a"]);
});

test("blimpd push-key and push-test are commands", () => {
  const run = (...a: string[]) =>
    Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "src", "main.ts"), ...a], {
      env: { HOME: root, PATH: process.env.PATH, BLIMPD_SOCKET: join(fresh(), "blimpd.sock") },
      stdout: "pipe",
      stderr: "pipe",
    });
  expect(run("push-key").stderr.toString()).toContain("usage: blimpd push-key");
  expect(run("push-test").stderr.toString()).toContain("no push key yet");
});
