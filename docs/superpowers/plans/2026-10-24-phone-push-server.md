# Phone notifications, step 1: the server — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** blimpd tells Max's iPhone through Apple's push service when a session starts waiting on him or a Claude turn of 30 s or more ends, even with both apps closed.

**Architecture:** A new `src/push/` folder: `store.ts` (the key and the phones, files beside the socket), `apns.ts` (the JWT and one HTTP/2 connection per Apple service), `rule.ts` (a pure function from the session list each second to "ask" and "finish" events), `payload.ts` (what each notification says), `watch.ts` (the loop that runs every second and sends), `cli.ts` (`blimpd push-key`, `blimpd push-test`). `server.ts` gets `POST`/`DELETE /push/device` and starts the watcher; `events.ts` records the Mac's `{ "type": "active" }`.

**Tech Stack:** Bun 1.4.3 (TypeScript, `bun:test`), `node:http2`, `node:crypto`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-20-phone-push-design.md` (sections 1, 2's server parts, 3, 5, and the server rows of Tests and Security). Steps 2–4 of its "Order of work" (the app, answers from the notification, the Mac's `active`) get their own plans.

## Global Constraints

- Only Max's phone: blimpd sends straight to Apple with Max's own `.p8` key. No relay server.
- `apns-topic: dev.blimp.phone`, `apns-push-type: alert`, `apns-priority: 10`.
- Hosts: `https://api.push.apple.com` for `production` devices, `https://api.sandbox.push.apple.com` for `development` ones.
- JWT: ES256, signed with the `.p8` key, `iss` = Team ID, `kid` = Key ID, made again every 40 minutes.
- Files beside the socket (`blimpDir()`), all mode 600, written through `<file>.tmp` and a rename: `apns.p8`, `apns.json` `{ keyId, teamId }`, `push.json` `{ devices: [{ token, env, at }] }`. At most 5 devices, newest kept.
- Apple's answer `410`, or reason `BadDeviceToken` or `Unregistered`, removes that device.
- A failed send is logged with Apple's reason and not retried, except after a dropped connection: one retry on a fresh one.
- Asks: a session becomes `waiting` with a new `prompt.at` (or `stateSince` when there's no prompt). Finishes: a Claude session (`CLAUDE_KINDS`) goes from `working` to `done` after 30 s or more. Each once. The first list blimpd sees counts as already notified.
- Mac in use: if the last `{ "type": "active" }` is less than 2 minutes old, hold until 2 minutes after it, then send only if still the same wait, or still `done` from the same turn.
- Codex and shell sessions: asks only.
- Without a key, blimpd sends nothing and says so once in its log.
- Tests never contact Apple: a local HTTP/2 server stands in for it.
- Comments and messages: plain English, short sentences, saying why (match the files around them). Commit subjects start with `blimpd: ` and say what changed in plain words. **Never add a `Co-Authored-By` line or any Claude attribution to a commit.**
- Run tests with Bun on PATH: `PATH=$HOME/.bun/bin:$PATH bun test <file>` from `/Users/mbeato/blimp-push`.

## Rulings made while planning (the spec is silent or the code moved)

- **A wait is told 3 s after it starts, not at once.** A permission's options are read from the screen up to 2 s after the hook (`promptFor` in `src/sessions.ts`). Yes and No must carry the final options' picks and labels, or blimpd refuses them as "the question changed". A wait answered within 3 s isn't told at all. Cost if wrong: 3 s later than it could be.
- **A turn's 30 s counts from its start, through any waits in it.** "A turn that ran 30 s or more" is from the prompt to the end. A turn starts when a session goes to `working` from anything but `working` or `waiting`.
- **An empty session list after a non-empty one is skipped.** It is more likely a failed `zmx list` (it gives `""` after 5 s) than every session gone, and forgetting them would tell their waits again.
- **`apns.p8` joins blimp's key files** in `secretPaths` (`src/files.ts`), so no file route serves or replaces it, as for the tokens.
- **Folder trust waits use the "Other wait" row** (body: the folder name, no buttons).
- **For step 3 (not this plan):** the app can answer from the notification with `POST /sessions/<name>/answer` (`src/answer.ts`, added after the spec), one HTTP request, instead of opening the chat socket. It takes the same `{ at, pick, label }` and the same checks.

## File structure

- Create `src/push/store.ts`: key, ids and devices on disk. Pure file I/O with a `dir`/`file` parameter for tests.
- Create `src/push/apns.ts`: `makeJwt`, `goneDevice`, class `Apns` (connections, send, one retry).
- Create `src/push/rule.ts`: `pushChanges`, `stillDue`, `dueAt` and their constants. No I/O.
- Create `src/push/payload.ts`: `plainText`, `pushPayload`. No I/O.
- Create `src/push/watch.ts`: class `PushWatcher` (its I/O through `PushDeps`), `markActive`, `lastActiveAt`, `startPush`.
- Create `src/push/cli.ts`: `runPushKey`, `runPushTest`.
- Modify `src/files.ts` (secretPaths), `src/pair.ts` (revoke empties push.json), `src/events.ts` (`active`), `src/server.ts` (routes, startPush), `src/main.ts` (commands).
- Tests: `test/push-store.test.ts`, `test/push-apns.test.ts`, `test/push-rule.test.ts`, `test/push-payload.test.ts`, `test/push-watch.test.ts`, `test/push-cli.test.ts`; additions to `test/files.test.ts`, `test/pair.test.ts`, `test/server.test.ts`.
- Docs: `docs/DESIGN.md`, `docs/SECURITY.md`.

---

### Task 1: The key and the phones on disk

**Files:**
- Create: `src/push/store.ts`
- Modify: `src/files.ts:85-97` (secretPaths), `src/pair.ts:67-73` (revoke)
- Test: `test/push-store.test.ts` (new), `test/files.test.ts` (guardFile describe), `test/pair.test.ts` (revoke test)

**Interfaces:**
- Produces: `type PushEnv = "development" | "production"`, `type Device = { token: string; env: PushEnv; at: number }`, `type Creds = { key: string; keyId: string; teamId: string }`, `keyFile(dir?)`, `credsFile(dir?)`, `devicesFile(dir?)`, `isDeviceToken(t: unknown): t is string`, `isPushEnv(e: unknown): e is PushEnv`, `readCreds(dir?): Creds | undefined`, `saveCreds(p8: string, keyId: string, teamId: string, dir?): void` (throws an Error whose message says why), `readDevices(file?): Device[]`, `addDevice(token, env, now?, file?): Device[]`, `removeDevice(token, file?): Device[]`, `clearDevices(file?): void`.

- [ ] **Step 1: Write the failing tests** in `test/push-store.test.ts`:

```ts
// Phone notifications' files (src/push/store.ts), in temp folders.

import { afterAll, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addDevice, clearDevices, credsFile, devicesFile, isDeviceToken, keyFile, readCreds, readDevices, removeDevice, saveCreds } from "../src/push/store";

const root = mkdtempSync(join(tmpdir(), "blimp-push-store-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = () => {
  const d = join(root, String(n++));
  mkdirSync(d);
  return d;
};
// A key like the .p8 Apple's developer site gives: an EC private key, PKCS #8, PEM.
const p8 = (curve = "prime256v1") => generateKeyPairSync("ec", { namedCurve: curve }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const mode = (f: string) => statSync(f).mode & 0o777;
const tok = (c: string) => c.repeat(64);

test("with no key, there are no credentials", () => {
  expect(readCreds(fresh())).toBeUndefined();
});

test("a P-256 key and Apple-shaped ids are saved 600 and read back", () => {
  const dir = fresh();
  const key = p8();
  saveCreds(key, "ABC123DEFG", "1A2B3C4D5E", dir);
  expect(readCreds(dir)).toEqual({ key, keyId: "ABC123DEFG", teamId: "1A2B3C4D5E" });
  expect(mode(keyFile(dir))).toBe(0o600);
  expect(mode(credsFile(dir))).toBe(0o600);
});

test("a wrong id, a file that isn't a key, or a key on another curve is refused, and nothing is written", () => {
  const dir = fresh();
  expect(() => saveCreds(p8(), "abc", "1A2B3C4D5E", dir)).toThrow("Key ID");
  expect(() => saveCreds(p8(), "ABC123DEFG", "team", dir)).toThrow("Team ID");
  expect(() => saveCreds("not a key", "ABC123DEFG", "1A2B3C4D5E", dir)).toThrow("isn't a private key");
  expect(() => saveCreds(p8("secp384r1"), "ABC123DEFG", "1A2B3C4D5E", dir)).toThrow("P-256");
  expect(readCreds(dir)).toBeUndefined();
});

test("a phone is added once, moves to the front when it asks again, and only the 5 newest are kept", () => {
  const file = devicesFile(fresh());
  expect(readDevices(file)).toEqual([]);
  addDevice(tok("a"), "production", 1, file);
  addDevice(tok("b"), "development", 2, file);
  expect(addDevice(tok("a"), "development", 3, file)).toEqual([
    { token: tok("a"), env: "development", at: 3 },
    { token: tok("b"), env: "development", at: 2 },
  ]);
  for (const c of "cdef") addDevice(tok(c), "production", 10, file);
  expect(readDevices(file).map((d) => d.token[0])).toEqual(["f", "e", "d", "c", "a"]);
  expect(mode(file)).toBe(0o600);
});

test("a token in capitals is the same phone; removing one leaves the rest; clearing removes them all", () => {
  const file = devicesFile(fresh());
  addDevice(tok("A"), "production", 1, file);
  addDevice(tok("a"), "production", 2, file);
  expect(readDevices(file)).toEqual([{ token: tok("a"), env: "production", at: 2 }]);
  addDevice(tok("b"), "production", 3, file);
  expect(removeDevice(tok("A"), file).map((d) => d.token)).toEqual([tok("b")]);
  clearDevices(file);
  expect(readDevices(file)).toEqual([]);
});

test("a broken file, and entries that aren't phones, are ignored", () => {
  const file = devicesFile(fresh());
  writeFileSync(file, "{");
  expect(readDevices(file)).toEqual([]);
  writeFileSync(
    file,
    JSON.stringify({ devices: [{ token: "xyz", env: "production", at: 1 }, { token: tok("c"), env: "staging", at: 1 }, { token: tok("d"), env: "production", at: 1 }] }),
  );
  expect(readDevices(file)).toEqual([{ token: tok("d"), env: "production", at: 1 }]);
});

test("device tokens are hex, 64 to 200 characters", () => {
  expect(isDeviceToken(tok("0"))).toBe(true);
  expect(isDeviceToken("ab")).toBe(false);
  expect(isDeviceToken(tok("g"))).toBe(false);
  expect(isDeviceToken(5)).toBe(false);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `PATH=$HOME/.bun/bin:$PATH bun test test/push-store.test.ts`
Expected: FAIL, `Cannot find module '../src/push/store'`.

- [ ] **Step 3: Write `src/push/store.ts`**

```ts
// Phone notifications' files, beside the socket (docs/superpowers/specs/2026-10-20-phone-push-design.md):
// apns.p8, the push key from Apple's developer site, and apns.json { keyId, teamId }, both from `blimpd
// push-key`; push.json { devices: [{ token, env, at }] }, the phones that asked for notifications. All 600,
// written through a temp file and a rename, so never half written.

import { createPrivateKey } from "node:crypto";
import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { blimpDir } from "../sessions";

// development: a build from Xcode, on Apple's sandbox service; production: TestFlight and the App Store.
export type PushEnv = "development" | "production";
export type Device = { token: string; env: PushEnv; at: number };
export type Creds = { key: string; keyId: string; teamId: string };

export const keyFile = (dir = blimpDir()) => join(dir, "apns.p8");
export const credsFile = (dir = blimpDir()) => join(dir, "apns.json");
export const devicesFile = (dir = blimpDir()) => join(dir, "push.json");

const MAX_DEVICES = 5;
// Apple's Key IDs and Team IDs are 10 capital letters and digits.
const APPLE_ID = /^[A-Z0-9]{10}$/;

export const isDeviceToken = (t: unknown): t is string => typeof t === "string" && /^[0-9a-f]{64,200}$/i.test(t);
export const isPushEnv = (e: unknown): e is PushEnv => e === "development" || e === "production";

function write(file: string, text: string) {
  writeFileSync(file + ".tmp", text, { mode: 0o600 });
  chmodSync(file + ".tmp", 0o600); // mode only applies to a new file: a .tmp left from before keeps its own
  renameSync(file + ".tmp", file);
}

// The key and its ids, or undefined before push-key (or when a file is broken): then nothing is sent.
export function readCreds(dir = blimpDir()): Creds | undefined {
  try {
    const { keyId, teamId } = JSON.parse(readFileSync(credsFile(dir), "utf8")) ?? {};
    const key = readFileSync(keyFile(dir), "utf8");
    if (APPLE_ID.test(keyId) && APPLE_ID.test(teamId) && key.includes("PRIVATE KEY")) return { key, keyId, teamId };
  } catch {}
}

// `blimpd push-key`: the key must be an EC P-256 private key (what Apple's .p8 is) and the ids Apple's shape.
// Throws why not, in words for the person who ran it.
export function saveCreds(p8: string, keyId: string, teamId: string, dir = blimpDir()) {
  if (!APPLE_ID.test(keyId)) throw new Error(`the Key ID is 10 letters and digits, like ABC123DEFG (got ${keyId})`);
  if (!APPLE_ID.test(teamId)) throw new Error(`the Team ID is 10 letters and digits, like 1A2B3C4D5E (got ${teamId})`);
  let k: ReturnType<typeof createPrivateKey>;
  try {
    k = createPrivateKey(p8);
  } catch {
    throw new Error("that file isn't a private key; download the .p8 from Apple's developer site again");
  }
  if (k.asymmetricKeyType !== "ec" || k.asymmetricKeyDetails?.namedCurve !== "prime256v1")
    throw new Error("that isn't an APNs key (it should be an EC P-256 key)");
  write(keyFile(dir), p8);
  write(credsFile(dir), JSON.stringify({ keyId, teamId }));
}

// Missing or unreadable: no phones. Entries that aren't phones are left out.
export function readDevices(file = devicesFile()): Device[] {
  try {
    const d = JSON.parse(readFileSync(file, "utf8"))?.devices;
    if (Array.isArray(d)) return d.filter((x) => isDeviceToken(x?.token) && isPushEnv(x?.env) && typeof x?.at === "number");
  } catch {}
  return [];
}

// Adds a phone, or moves it to the front with its env and time; only the 5 newest are kept.
export function addDevice(token: string, env: PushEnv, now = Date.now(), file = devicesFile()): Device[] {
  const t = token.toLowerCase();
  const devices = [{ token: t, env, at: now }, ...readDevices(file).filter((d) => d.token !== t)].slice(0, MAX_DEVICES);
  write(file, JSON.stringify({ devices }));
  return devices;
}

export function removeDevice(token: string, file = devicesFile()): Device[] {
  const t = token.toLowerCase();
  const had = readDevices(file);
  const devices = had.filter((d) => d.token !== t);
  if (devices.length !== had.length) write(file, JSON.stringify({ devices }));
  return devices;
}

// `blimpd pair --revoke`: a phone that can't connect gets no notifications either.
export function clearDevices(file = devicesFile()) {
  rmSync(file, { force: true });
}
```

- [ ] **Step 4: Run them to see them pass**

Run: `PATH=$HOME/.bun/bin:$PATH bun test test/push-store.test.ts`
Expected: 7 pass, 0 fail.

- [ ] **Step 5: The push key is one of blimp's key files.** In `src/files.ts`, `secretPaths` (line ~89), add the key after the browser gate's key and say so in the comment above it:

```ts
// blimp's own key files: the daemon's token, the phone's token, the browser gate's key, the push key (all
// beside the socket), the model key, and the folder of secrets given to sessions (secrets.ts).
// No fs route may serve, replace, or archive them: a client holding one token — the phone's —
// must not read or plant another (the Mac's), so `blimpd pair --revoke` stays final.
export function secretPaths(home = realHome(), dir = socketDir()): string[] {
  return [
    join(dir, "token"),
    join(dir, "phone-token"),
    join(dir, "browser", "key"),
    join(dir, "apns.p8"),
    join(home, ".config", "zai", "key"),
    join(dir, "secrets"),
  ].map(realPath);
}
```

In `test/files.test.ts`, inside `describe("guardFile", …)`, after the test "blimp's own key files are refused", add:

```ts
  test("the push key is one of them, there or not", () => {
    expect(secretPaths(home, blimp)).toContain(join(blimp, "apns.p8"));
    expect(status(() => guardFile(join(blimp, "apns.p8"), home, blimp))).toBe(403);
  });
```

- [ ] **Step 6: `blimpd pair --revoke` empties push.json.** In `src/pair.ts`, import `clearDevices` and `devicesFile` from `./push/store`, and in `runPair`'s revoke branch:

```ts
  if (args.length === 1 && args[0] === "--revoke") {
    const had = !!readPhoneToken(dir);
    rmSync(join(dir, "phone-token"), { force: true });
    clearDevices(devicesFile(dir));
    console.log(had ? "Phone token deleted. The phone can't connect or get notifications any more; the Mac still can." : "There was no phone token.");
    return 0;
  }
```

In `test/pair.test.ts`, in the test "--revoke deletes the phone token and leaves the Mac's", write a phone into `push.json` before the revoke and check it's gone after. Change the test to:

```ts
  test("--revoke deletes the phone token, and the phones that get notifications, and leaves the Mac's token", () => {
    const dir = join(tmp, "f");
    mkdirSync(dir);
    writeFileSync(join(dir, "token"), "mac");
    expect(pair(dir, ["--url", "https://x.ts.net"]).code).toBe(0);
    writeFileSync(join(dir, "push.json"), JSON.stringify({ devices: [{ token: "a".repeat(64), env: "production", at: 1 }] }));
    const r = pair(dir, ["--revoke"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Phone token deleted");
    expect(existsSync(join(dir, "phone-token"))).toBe(false);
    expect(existsSync(join(dir, "push.json"))).toBe(false);
    expect(readFileSync(join(dir, "token"), "utf8")).toBe("mac");
    expect(pair(dir, ["--revoke"]).out).toContain("There was no phone token.");
  });
```

- [ ] **Step 7: Run the three test files**

Run: `PATH=$HOME/.bun/bin:$PATH bun test test/push-store.test.ts test/files.test.ts test/pair.test.ts`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/push/store.ts src/files.ts src/pair.ts test/push-store.test.ts test/files.test.ts test/pair.test.ts
git commit -m "blimpd: the push key and the phones that want notifications are kept beside the socket (apns.p8 and apns.json, push.json with at most 5 phones), all 600; no file route serves the key, and pair --revoke forgets the phones"
```

---

### Task 2: Sending to Apple

**Files:**
- Create: `src/push/apns.ts`
- Test: `test/push-apns.test.ts`

**Interfaces:**
- Consumes: `Creds`, `Device`, `PushEnv` from `src/push/store.ts`.
- Produces: `HOSTS: Record<PushEnv, string>`, `TOPIC = "dev.blimp.phone"`, `makeJwt(c: Creds, now?: number): string`, `type Sent = { status: number; reason?: string }` (status 0: no answer), `type PushOptions = { collapseId?: string }`, `goneDevice(r: Sent): boolean`, `class Apns { constructor(creds: Creds, hosts?: Record<PushEnv, string>, now?: () => number); send(d: Device, payload: object, o?: PushOptions): Promise<Sent>; close(): void }`. `send` never throws.

- [ ] **Step 1: Write the failing tests** in `test/push-apns.test.ts`:

```ts
// Sending to Apple (src/push/apns.ts), against a stand-in: plain HTTP/2 on a local port. Nothing here reaches Apple.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import http2 from "node:http2";
import { Apns, goneDevice, makeJwt, TOPIC } from "../src/push/apns";
import type { Device, PushEnv } from "../src/push/store";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const creds = { key: privateKey.export({ type: "pkcs8", format: "pem" }) as string, keyId: "ABC123DEFG", teamId: "1A2B3C4D5E" };
const device: Device = { token: "a".repeat(64), env: "production", at: 0 };

// What the stand-in got, and how it answers each request (200 unless a test says otherwise).
type Got = { headers: http2.IncomingHttpHeaders; body: string };
const ok = (_: Got, s: http2.ServerHttp2Stream) => {
  s.respond({ ":status": 200 });
  s.end();
};
let got: Got[] = [];
let answer = ok;
const reset = (a = ok) => {
  got = [];
  answer = a;
};
const apple = http2.createServer();
apple.on("stream", (stream, headers) => {
  let body = "";
  stream.on("data", (c) => (body += c));
  stream.on("end", () => {
    const g = { headers, body };
    got.push(g);
    answer(g, stream);
  });
});
let hosts: Record<PushEnv, string>;
beforeAll(async () => {
  await new Promise<void>((r) => apple.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(apple.address() as { port: number }).port}`;
  hosts = { production: url, development: url };
});
afterAll(() => apple.close());

const json = (b64: string) => JSON.parse(Buffer.from(b64, "base64url").toString());

test("the JWT: ES256 with the Key ID, the Team ID and the time in seconds, signed with the key", () => {
  const [h, c, s] = makeJwt(creds, 1_700_000_000_123).split(".");
  expect(json(h)).toEqual({ alg: "ES256", kid: "ABC123DEFG" });
  expect(json(c)).toEqual({ iss: "1A2B3C4D5E", iat: 1_700_000_000 });
  expect(verify("sha256", Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"))).toBe(true);
});

test("a send: the device's path, Apple's headers, the payload as JSON, and Apple's answer", async () => {
  reset();
  const a = new Apns(creds, hosts);
  try {
    expect(await a.send(device, { aps: { alert: "hi" } }, { collapseId: "s1" })).toEqual({ status: 200 });
    const [g] = got;
    expect(g.headers[":method"]).toBe("POST");
    expect(g.headers[":path"]).toBe(`/3/device/${device.token}`);
    expect(g.headers["apns-topic"]).toBe(TOPIC);
    expect(g.headers["apns-push-type"]).toBe("alert");
    expect(g.headers["apns-priority"]).toBe("10");
    expect(g.headers["apns-collapse-id"]).toBe("s1");
    expect(String(g.headers.authorization)).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(JSON.parse(g.body)).toEqual({ aps: { alert: "hi" } });
  } finally {
    a.close();
  }
});

test("Apple's reason comes back; 410, BadDeviceToken and Unregistered mean the phone is gone", async () => {
  reset((_, s) => {
    s.respond({ ":status": 410 });
    s.end(JSON.stringify({ reason: "Unregistered" }));
  });
  const a = new Apns(creds, hosts);
  try {
    const r = await a.send(device, {});
    expect(r).toEqual({ status: 410, reason: "Unregistered" });
    expect(goneDevice(r)).toBe(true);
  } finally {
    a.close();
  }
  expect(goneDevice({ status: 400, reason: "BadDeviceToken" })).toBe(true);
  expect(goneDevice({ status: 400, reason: "BadCollapseId" })).toBe(false);
  expect(goneDevice({ status: 200 })).toBe(false);
});

test("the JWT is kept for 40 minutes, then made again", async () => {
  reset();
  let now = 1_700_000_000_000;
  const a = new Apns(creds, hosts, () => now);
  try {
    await a.send(device, {});
    now += 39 * 60_000;
    await a.send(device, {});
    now += 2 * 60_000;
    await a.send(device, {});
    const auth = got.map((g) => g.headers.authorization);
    expect(auth[1]).toBe(auth[0]);
    expect(auth[2]).not.toBe(auth[0]);
  } finally {
    a.close();
  }
});

test("a connection that drops before Apple answers is tried once more, on a new one", async () => {
  let first = true;
  reset((g, s) => {
    if (first) {
      first = false;
      s.session?.destroy();
      return;
    }
    ok(g, s);
  });
  const a = new Apns(creds, hosts);
  try {
    expect(await a.send(device, {})).toEqual({ status: 200 });
    expect(got.length).toBe(2);
  } finally {
    a.close();
  }
});

test("when the second try fails too, the send says so with status 0, and doesn't throw", async () => {
  reset((_, s) => s.session?.destroy());
  const a = new Apns(creds, hosts);
  try {
    const r = await a.send(device, {});
    expect(r.status).toBe(0);
    expect(typeof r.reason).toBe("string");
    expect(got.length).toBe(2);
  } finally {
    a.close();
  }
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `PATH=$HOME/.bun/bin:$PATH bun test test/push-apns.test.ts`
Expected: FAIL, `Cannot find module '../src/push/apns'`.

- [ ] **Step 3: Write `src/push/apns.ts`**

```ts
// Sending to Apple's push service (docs/superpowers/specs/2026-10-20-phone-push-design.md, section 5): one HTTP/2
// connection per service (production for TestFlight builds, sandbox for ones from Xcode), opened when needed and
// kept while it works, and a JWT signed with the push key, made again every 40 minutes (Apple wants 20 to 60).
// Outbound HTTPS only: nothing listens.

import { sign } from "node:crypto";
import http2 from "node:http2";
import type { Creds, Device, PushEnv } from "./store";

export const HOSTS: Record<PushEnv, string> = { production: "https://api.push.apple.com", development: "https://api.sandbox.push.apple.com" };
export const TOPIC = "dev.blimp.phone";
const JWT_LIFE = 40 * 60_000;
const TIMEOUT = 10_000;

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

// ES256: the signature is r and s side by side (64 bytes), not DER.
export function makeJwt(c: Creds, now = Date.now()): string {
  const head = b64url(JSON.stringify({ alg: "ES256", kid: c.keyId }));
  const claims = b64url(JSON.stringify({ iss: c.teamId, iat: Math.floor(now / 1000) }));
  const sig = sign("sha256", Buffer.from(`${head}.${claims}`), { key: c.key, dsaEncoding: "ieee-p1363" });
  return `${head}.${claims}.${b64url(sig)}`;
}

// status 0: no answer from Apple, and reason says why.
export type Sent = { status: number; reason?: string };
export type PushOptions = { collapseId?: string };

// Apple's answers that mean the phone's token no longer works: the app was deleted, or the token is wrong.
export const goneDevice = (r: Sent) => r.status === 410 || r.reason === "BadDeviceToken" || r.reason === "Unregistered";

export class Apns {
  private jwt?: { token: string; at: number };
  private conns = new Map<PushEnv, http2.ClientHttp2Session>();

  constructor(
    private creds: Creds,
    private hosts = HOSTS,
    private now = Date.now,
  ) {}

  // Never throws. A failed send isn't tried again, except after a dropped connection: once, on a fresh one.
  async send(d: Device, payload: object, o: PushOptions = {}): Promise<Sent> {
    for (let i = 0; ; i++) {
      try {
        return await this.once(d, payload, o);
      } catch (e) {
        this.drop(d.env);
        if (i === 1) return { status: 0, reason: (e as Error).message };
      }
    }
  }

  close() {
    for (const c of this.conns.values()) c.close();
    this.conns.clear();
  }

  private bearer(): string {
    const t = this.now();
    if (!this.jwt || t - this.jwt.at >= JWT_LIFE) this.jwt = { token: makeJwt(this.creds, t), at: t };
    return this.jwt.token;
  }

  private conn(env: PushEnv): http2.ClientHttp2Session {
    const had = this.conns.get(env);
    if (had && !had.closed && !had.destroyed) return had;
    const c = http2.connect(this.hosts[env]);
    // An error or a goaway ends it, and the next send opens another. Without an error listener, one would end blimpd.
    const forget = () => {
      if (this.conns.get(env) === c) this.conns.delete(env);
    };
    c.on("error", forget);
    c.on("goaway", forget);
    c.on("close", forget);
    this.conns.set(env, c);
    return c;
  }

  private drop(env: PushEnv) {
    this.conns.get(env)?.destroy();
    this.conns.delete(env);
  }

  // Apple's answer, or a rejection when the stream closes without one (a dropped connection, a timeout).
  private once(d: Device, payload: object, o: PushOptions): Promise<Sent> {
    return new Promise((resolve, reject) => {
      const req = this.conn(d.env).request({
        ":method": "POST",
        ":path": `/3/device/${d.token}`,
        authorization: `bearer ${this.bearer()}`,
        "apns-topic": TOPIC,
        "apns-push-type": "alert",
        "apns-priority": "10",
        ...(o.collapseId && { "apns-collapse-id": o.collapseId }),
      });
      let status = 0;
      let body = "";
      req.setTimeout(TIMEOUT, () => req.close(http2.constants.NGHTTP2_CANCEL));
      req.on("response", (h) => (status = Number(h[":status"])));
      req.on("data", (c) => (body += c));
      req.on("error", reject);
      req.on("close", () => {
        if (!status) return reject(new Error("no answer from Apple"));
        let reason: unknown;
        try {
          reason = JSON.parse(body)?.reason;
        } catch {}
        resolve({ status, ...(typeof reason === "string" && { reason }) });
      });
      req.end(JSON.stringify(payload));
    });
  }
}
```

- [ ] **Step 4: Run them to see them pass**

Run: `PATH=$HOME/.bun/bin:$PATH bun test test/push-apns.test.ts`
Expected: 6 pass, 0 fail. (Checked on this box, 2026-10-24: Bun 1.4.3's HTTP/2 server serves plain `http://` to `http2.connect`, and a `stream.session.destroy()` closes the client's stream with no status within 10 ms, so the retry test runs fast. If it ever hangs on another Bun, answer the first request with `s.close(http2.constants.NGHTTP2_INTERNAL_ERROR)` instead: it also ends the stream without a status.)

- [ ] **Step 5: Commit**

```bash
git add src/push/apns.ts test/push-apns.test.ts
git commit -m "blimpd: sending to Apple's push service: one HTTP/2 connection per service, a JWT signed with the push key and made again every 40 minutes, Apple's reason back, and one retry after a dropped connection"
```

---

### Task 3: When to tell the phone

**Files:**
- Create: `src/push/rule.ts`
- Test: `test/push-rule.test.ts`

**Interfaces:**
- Consumes: `Session`, `State` from `src/sessions.ts`; `CLAUDE_KINDS` from `src/kinds.ts`.
- Produces: `type PushSession = Pick<Session, "name" | "kind" | "state" | "stateSince" | "prompt">`, `type Seen = { state: State; wait?: number; turn?: number }`, `type PushEvent = { kind: "ask" | "finish"; session: string; key: number }`, `ASK_SETTLE = 3000`, `FINISH_MIN = 30_000`, `HOLD = 120_000`, `waitKey(s: PushSession): number`, `pushChanges(before: Map<string, Seen> | undefined, list: PushSession[], now: number): { seen: Map<string, Seen>; events: PushEvent[] }`, `stillDue(e: PushEvent, list: PushSession[]): boolean`, `dueAt(now: number, lastActive: number): number`.

- [ ] **Step 1: Write the failing tests** in `test/push-rule.test.ts`:

```ts
// When blimpd tells the phone (src/push/rule.ts): lists of sessions one after another, and what each step tells.

import { expect, test } from "bun:test";
import { ASK_SETTLE, dueAt, FINISH_MIN, HOLD, type PushEvent, type PushSession, pushChanges, stillDue } from "../src/push/rule";

const T = 1_800_000_000_000;
const claude = (name: string, state: PushSession["state"], stateSince: number, prompt?: { at: number }) =>
  ({ name, kind: "claude", state, stateSince, ...(prompt && { prompt: { kind: "other", answerable: false, ...prompt } }) }) as PushSession;
const codex = (state: PushSession["state"], stateSince: number) => ({ name: "c", kind: "codex", state, stateSince }) as PushSession;

// From a blimpd that already saw `first` (at T), each step's list at its time, and the events each step gives.
function run(first: PushSession[], steps: [number, PushSession[]][]): PushEvent[][] {
  let seen = pushChanges(undefined, first, T).seen;
  return steps.map(([now, list]) => {
    const r = pushChanges(seen, list, now);
    seen = r.seen;
    return r.events;
  });
}

test("what blimpd finds first counts as seen: nothing for a wait or a finish already there", () => {
  const waiting = claude("a", "waiting", T - 60_000, { at: T - 60_000 });
  expect(pushChanges(undefined, [waiting, claude("b", "done", T - 5000)], T).events).toEqual([]);
  expect(run([waiting], [[T + 1000, [waiting]]])).toEqual([[]]);
});

test("a wait is told once, when it has lasted 3 s", () => {
  const w = claude("a", "waiting", T, { at: T });
  expect(run([claude("a", "working", T - 10_000)], [[T + 1000, [w]], [T + ASK_SETTLE, [w]], [T + ASK_SETTLE + 1000, [w]]])).toEqual([
    [],
    [{ kind: "ask", session: "a", key: T }],
    [],
  ]);
});

test("a wait answered within 3 s isn't told", () => {
  expect(
    run([claude("a", "working", T - 10_000)], [
      [T + 1000, [claude("a", "waiting", T, { at: T })]],
      [T + 2000, [claude("a", "working", T + 1500)]],
      [T + 5000, [claude("a", "working", T + 1500)]],
    ]),
  ).toEqual([[], [], []]);
});

test("a new wait in the same session is told again, and a new session that's already waiting is told too", () => {
  const old = claude("a", "waiting", T - 9000, { at: T - 9000 });
  const next = claude("a", "waiting", T - 9000, { at: T });
  expect(
    run([old], [
      [T, [old]],
      [T + 5000, [next]],
      [T + 6000, [next, claude("b", "waiting", T, { at: T })]],
    ]),
  ).toEqual([[], [{ kind: "ask", session: "a", key: T }], [{ kind: "ask", session: "b", key: T }]]);
});

test("a wait without a question (Codex) is keyed by when its state began; Codex never finishes", () => {
  expect(
    run([codex("working", T - 60_000)], [
      [T + 3000, [codex("waiting", T)]],
      [T + 4000, [codex("working", T + 3500)]],
      [T + 100_000, [codex("done", T + 99_000)]],
    ]),
  ).toEqual([[{ kind: "ask", session: "c", key: T }], [], []]);
});

test("a Claude turn of 30 s or more that ends is told once; one of 29 s isn't", () => {
  expect(run([claude("a", "done", T - 1000)], [[T, [claude("a", "working", T)]], [T + 29_000, [claude("a", "done", T + 29_000)]]])).toEqual([[], []]);
  expect(
    run([claude("a", "done", T - 1000)], [
      [T, [claude("a", "working", T)]],
      [T + FINISH_MIN, [claude("a", "done", T + FINISH_MIN)]],
      [T + FINISH_MIN + 1000, [claude("a", "done", T + FINISH_MIN)]],
    ]),
  ).toEqual([[], [{ kind: "finish", session: "a", key: T + FINISH_MIN }], []]);
});

test("a turn goes on through its waits: 10 s of work, a question, then more work to 31 s is a 31 s turn", () => {
  const q = claude("a", "waiting", T + 10_000, { at: T + 10_000 });
  expect(
    run([claude("a", "done", T - 1000)], [
      [T, [claude("a", "working", T)]],
      [T + 10_000, [q]],
      [T + 14_000, [q]],
      [T + 15_000, [claude("a", "working", T + 15_000)]],
      [T + 31_000, [claude("a", "done", T + 31_000)]],
    ]),
  ).toEqual([[], [], [{ kind: "ask", session: "a", key: T + 10_000 }], [], [{ kind: "finish", session: "a", key: T + 31_000 }]]);
});

test("a turn that starts after a finish is timed from its own start", () => {
  expect(
    run([claude("a", "working", T - 60_000)], [
      [T, [claude("a", "done", T)]],
      [T + 1000, [claude("a", "working", T + 1000)]],
      [T + 11_000, [claude("a", "done", T + 11_000)]],
    ]),
  ).toEqual([[{ kind: "finish", session: "a", key: T }], [], []]);
});

test("a held one still goes only if nothing changed: the same wait, or still done from the same turn", () => {
  const ask: PushEvent = { kind: "ask", session: "a", key: T };
  expect(stillDue(ask, [claude("a", "waiting", T, { at: T })])).toBe(true);
  expect(stillDue(ask, [claude("a", "working", T + 5000)])).toBe(false);
  expect(stillDue(ask, [claude("a", "waiting", T, { at: T + 9000 })])).toBe(false);
  expect(stillDue(ask, [])).toBe(false);
  const fin: PushEvent = { kind: "finish", session: "a", key: T };
  expect(stillDue(fin, [claude("a", "done", T)])).toBe(true);
  expect(stillDue(fin, [claude("a", "working", T + 1000)])).toBe(false);
});

test("while the Mac was in use in the last 2 minutes, a notification waits until 2 minutes after that", () => {
  expect(dueAt(T, 0)).toBe(T);
  expect(dueAt(T, T - 30_000)).toBe(T - 30_000 + HOLD);
  expect(dueAt(T, T - HOLD)).toBe(T);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `PATH=$HOME/.bun/bin:$PATH bun test test/push-rule.test.ts`
Expected: FAIL, `Cannot find module '../src/push/rule'`.

- [ ] **Step 3: Write `src/push/rule.ts`**

```ts
// When blimpd tells the phone (docs/superpowers/specs/2026-10-20-phone-push-design.md, section 3), from the session
// list each second and what it saw the second before: a session that starts waiting (an ask), and a Claude session
// whose turn of 30 s or more ends (a finish). Each wait and each finish once. The first list blimpd sees (after it
// starts, or after push is set up) counts as seen, so a restart doesn't tell them again.

import { CLAUDE_KINDS } from "../kinds";
import type { Session, State } from "../sessions";

export type PushSession = Pick<Session, "name" | "kind" | "state" | "stateSince" | "prompt">;
// What a session was doing: its state, the wait told (or seen) while waiting, and when its turn began.
export type Seen = { state: State; wait?: number; turn?: number };
export type PushEvent = { kind: "ask" | "finish"; session: string; key: number };

// A permission's options come from the screen up to 2 s after the wait starts (promptFor in sessions.ts), and Yes
// and No on the notification need the final ones. A wait answered before then isn't told at all.
export const ASK_SETTLE = 3000;
export const FINISH_MIN = 30_000;
// How long the phone waits while the Mac is in use.
export const HOLD = 2 * 60_000;

// The wait: when the hook says it began, or for one without a prompt (Codex), when the state did.
export const waitKey = (s: PushSession) => s.prompt?.at ?? s.stateSince ?? 0;

export function pushChanges(before: Map<string, Seen> | undefined, list: PushSession[], now: number): { seen: Map<string, Seen>; events: PushEvent[] } {
  const seen = new Map<string, Seen>();
  const events: PushEvent[] = [];
  for (const s of list) {
    const was = before?.get(s.name);
    if (s.state === "waiting") {
      const wait = waitKey(s);
      const known = !before || was?.wait === wait;
      const settled = now - wait >= ASK_SETTLE;
      if (!known && settled) events.push({ kind: "ask", session: s.name, key: wait });
      // Not settled yet: the wait stays untold, so a later list tells it.
      seen.set(s.name, { state: s.state, wait: known || settled ? wait : was?.wait, turn: was?.turn });
    } else if (s.state === "working") {
      // A turn goes on through its waits. One from done, unknown or a new session begins at this state.
      const going = (was?.state === "working" || was?.state === "waiting") && was.turn !== undefined;
      seen.set(s.name, { state: s.state, turn: going ? was.turn : (s.stateSince ?? now) });
    } else {
      if (s.state === "done" && was?.state === "working" && was.turn !== undefined && CLAUDE_KINDS.includes(s.kind)) {
        const end = s.stateSince ?? now;
        if (end - was.turn >= FINISH_MIN) events.push({ kind: "finish", session: s.name, key: end });
      }
      seen.set(s.name, { state: s.state });
    }
  }
  return { seen, events };
}

// A held one goes only if the session still shows what it was about.
export function stillDue(e: PushEvent, list: PushSession[]): boolean {
  const s = list.find((x) => x.name === e.session);
  if (!s) return false;
  return e.kind === "ask" ? s.state === "waiting" && waitKey(s) === e.key : s.state === "done" && s.stateSince === e.key;
}

// When to send what happened now: at once, or, while the Mac was in use in the last 2 minutes, 2 minutes after that.
export const dueAt = (now: number, lastActive: number) => (now - lastActive < HOLD ? lastActive + HOLD : now);
```

- [ ] **Step 4: Run them to see them pass**

Run: `PATH=$HOME/.bun/bin:$PATH bun test test/push-rule.test.ts`
Expected: 10 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/push/rule.ts test/push-rule.test.ts
git commit -m "blimpd: when to tell the phone, as a function of the session list: a wait once it has lasted 3 s (so a permission's Yes and No are the screen's), a Claude turn of 30 s or more when it ends, each once, nothing for what blimpd finds when it starts, and 2 minutes' wait while the Mac is in use"
```

---

### Task 4: What a notification says

**Files:**
- Create: `src/push/payload.ts`
- Test: `test/push-payload.test.ts`

**Interfaces:**
- Consumes: `PushSession`, `PushEvent` from `src/push/rule.ts`; `Session` from `src/sessions.ts`; `redact` from `src/activity.ts`.
- Produces: `type Shown = PushSession & Pick<Session, "title" | "dir">`, `type Choice = { pick: number; label: string }`, `PERMISSION_CATEGORY = "permission"`, `plainText(md: string): string`, `pushPayload(s: Shown, e: PushEvent, reply?: string): Record<string, unknown>`.

- [ ] **Step 1: Write the failing tests** in `test/push-payload.test.ts`:

```ts
// What a notification says (src/push/payload.ts), for each row of the spec's table.

import { expect, test } from "bun:test";
import { PERMISSION_CATEGORY, plainText, pushPayload, type Shown } from "../src/push/payload";
import type { PushEvent } from "../src/push/rule";

const base = { name: "blimp-1", kind: "claude", state: "waiting", stateSince: 5, title: "Fix the drawer", dir: "/home/m/blimp" } as const;
const ask: PushEvent = { kind: "ask", session: "blimp-1", key: 5 };
const finish: PushEvent = { kind: "finish", session: "blimp-1", key: 9 };
const permission = (options: string[]) =>
  ({ ...base, prompt: { kind: "permission", tool: "Bash", summary: "Run bun test", options, keys: options.map((_, i) => String(i + 1)), answerable: true, at: 5 } }) as Shown;

test("a permission: its summary, and Yes and No as the first option and the last, with the wait's at", () => {
  expect(pushPayload(permission(["Yes", "Yes, and don't ask again for bun test", "No"]), ask)).toEqual({
    aps: { alert: { title: "Fix the drawer is waiting", body: "Run bun test" }, sound: "default", "thread-id": "blimp-1", category: PERMISSION_CATEGORY },
    session: "blimp-1",
    kind: "ask",
    at: 5,
    yes: { pick: 0, label: "Yes" },
    no: { pick: 2, label: "No" },
  });
});

test("a plan's No is its last option, as the screen names it", () => {
  const p = pushPayload(permission(["Yes, and auto-accept edits", "Yes, and manually approve edits", "No, keep planning"]), ask);
  expect(p.yes).toEqual({ pick: 0, label: "Yes, and auto-accept edits" });
  expect(p.no).toEqual({ pick: 2, label: "No, keep planning" });
});

test("a question: its first question, no buttons", () => {
  const s = { ...base, prompt: { kind: "question", questions: [{ question: "Which one?", multiSelect: false, options: [{ label: "A" }] }], answerable: true, at: 5 } } as Shown;
  expect(pushPayload(s, ask)).toEqual({ aps: { alert: { title: "Fix the drawer is waiting", body: "Which one?" }, sound: "default", "thread-id": "blimp-1" }, session: "blimp-1", kind: "ask" });
});

test("another wait (Codex, folder trust): the folder's name", () => {
  expect((pushPayload(base as Shown, ask).aps as any).alert).toEqual({ title: "Fix the drawer is waiting", body: "blimp" });
  const trust = { ...base, prompt: { kind: "trust", folder: "/home/m/blimp", options: ["Yes, I trust this folder", "No, exit"], answerable: true, at: 5 } } as Shown;
  const p = pushPayload(trust, ask);
  expect((p.aps as any).alert.body).toBe("blimp");
  expect(p.yes).toBeUndefined();
});

test("a finish: Claude's last reply as plain text, at most 150 characters, with no secrets", () => {
  const done = { ...base, state: "done" } as Shown;
  expect(pushPayload(done, finish, "## Done\n\n**Shipped** it")).toEqual({
    aps: { alert: { title: "Fix the drawer finished", body: "Done Shipped it" }, sound: "default", "thread-id": "blimp-1" },
    session: "blimp-1",
    kind: "finish",
  });
  const long = (pushPayload(done, finish, "word ".repeat(100)).aps as any).alert.body;
  expect(Array.from(long).length).toBe(150);
  expect(long.endsWith("…")).toBe(true);
  expect((pushPayload(done, finish, "Set GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123 and go").aps as any).alert.body).not.toContain("ghp_");
  expect((pushPayload(done, finish).aps as any).alert.body).toBe("blimp");
});

test("Markdown's marks come out; words with underscores stay", () => {
  expect(plainText("## Done\n\n**Shipped** v0.3.8: see [the run](https://x). Use `bun test` and keep snake_case_names.\n\n- one\n- two\n```ts\nconst a = 1\n```")).toBe(
    "Done Shipped v0.3.8: see the run. Use bun test and keep snake_case_names. one two const a = 1",
  );
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `PATH=$HOME/.bun/bin:$PATH bun test test/push-payload.test.ts`
Expected: FAIL, `Cannot find module '../src/push/payload'`.

- [ ] **Step 3: Write `src/push/payload.ts`**

```ts
// What a notification says (docs/superpowers/specs/2026-10-20-phone-push-design.md, section 4), as Apple's JSON: the
// alert, the session as its thread (iOS groups them), and for the app `session`, `kind` and, for a permission, the
// wait's `at` and the pick and label that Yes and No answer with: the first option and the last, as on the phone.
// Text goes through Apple's servers, so secrets come out first (activity.ts redact).

import { basename } from "node:path";
import { redact } from "../activity";
import type { Session } from "../sessions";
import type { PushEvent, PushSession } from "./rule";

export type Shown = PushSession & Pick<Session, "title" | "dir">;
export type Choice = { pick: number; label: string };
// The category the app gives Yes and No (Yes needs Face ID).
export const PERMISSION_CATEGORY = "permission";

// At most n characters (code points, so never half an emoji), with … when cut.
const cut = (s: string, n: number) => {
  const a = Array.from(s);
  return a.length > n ? a.slice(0, n - 1).join("").trimEnd() + "…" : s;
};

// One line of plain text from Markdown: fences, links (their words stay), headings, quotes, list marks, emphasis
// and code marks out. A single underscore stays: it's more often in a name than emphasis.
export function plainText(md: string): string {
  return md
    .replace(/^\s*```.*$/gm, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/\*(\S[^*\n]*?)\*/g, "$1")
    .replace(/`([^`\n]*)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function pushPayload(s: Shown, e: PushEvent, reply?: string): Record<string, unknown> {
  const title = cut(s.title, 80);
  const folder = basename(s.dir) || s.dir;
  const p = s.prompt;
  const aps: Record<string, unknown> = { alert: {}, sound: "default", "thread-id": s.name };
  const data: Record<string, unknown> = { session: s.name, kind: e.kind };
  if (e.kind === "finish") {
    const text = reply ? cut(plainText(redact(reply)), 150) : "";
    aps.alert = { title: `${title} finished`, body: text || folder };
  } else if (p?.kind === "permission" && p.options.length >= 2) {
    const last = p.options.length - 1;
    aps.alert = { title: `${title} is waiting`, body: cut(redact(p.summary), 200) };
    aps.category = PERMISSION_CATEGORY;
    const yes: Choice = { pick: 0, label: p.options[0] };
    const no: Choice = { pick: last, label: p.options[last] };
    Object.assign(data, { at: p.at, yes, no });
  } else if (p?.kind === "question" && p.questions[0]) {
    aps.alert = { title: `${title} is waiting`, body: cut(redact(p.questions[0].question), 200) };
  } else {
    aps.alert = { title: `${title} is waiting`, body: folder };
  }
  return { aps, ...data };
}
```

- [ ] **Step 4: Run them to see them pass**

Run: `PATH=$HOME/.bun/bin:$PATH bun test test/push-payload.test.ts`
Expected: 6 pass, 0 fail. (`toEqual` ignores key order, so the `aps` field order in the expected objects doesn't matter.)

- [ ] **Step 5: Commit**

```bash
git add src/push/payload.ts test/push-payload.test.ts
git commit -m "blimpd: what a notification says: the session's title with is waiting or finished; a permission's summary with Yes and No as its first and last option, a question's first question, a folder's name otherwise, and a finish's last reply as plain text of at most 150 characters, with secrets taken out"
```

---

### Task 5: The watcher that runs all the time

**Files:**
- Create: `src/push/watch.ts`
- Modify: `src/events.ts:73-90` (eventsMessage), `src/server.ts:446-450` (serve)
- Test: `test/push-watch.test.ts`

**Interfaces:**
- Consumes: `pushChanges`, `stillDue`, `dueAt`, `Seen`, `PushEvent`, `PushSession` (rule.ts); `pushPayload` (payload.ts); `Apns`, `goneDevice`, `Sent` (apns.ts); `Creds`, `Device`, `readCreds`, `readDevices`, `removeDevice` (store.ts); `follow`, `newSummary`, `Summary` from `src/names.ts`; `claudeDir`, `listSessionsLite`, `Session`, `zmxListAsync` from `src/sessions.ts`.
- Produces: `type WatchedSession = PushSession & Pick<Session, "title" | "dir" | "transcript">`, `type PushDeps` (below), `class PushWatcher { constructor(deps: PushDeps); tick(): Promise<void> }`, `markActive(now?: number): void`, `lastActiveAt(): number`, `startPush(every?: number): void`.

- [ ] **Step 1: Write the failing tests** in `test/push-watch.test.ts`:

```ts
// The push watcher (src/push/watch.ts) on stand-ins: the session list, the clock, the Mac's last use, and Apple.

import { expect, test } from "bun:test";
import { eventsData, eventsMessage } from "../src/events";
import type { Sent } from "../src/push/apns";
import type { Creds, Device } from "../src/push/store";
import { lastActiveAt, type PushDeps, PushWatcher, type WatchedSession } from "../src/push/watch";

const T = 1_800_000_000_000;
const key: Creds = { key: "k", keyId: "ABC123DEFG", teamId: "1A2B3C4D5E" };
const phone: Device = { token: "a".repeat(64), env: "production", at: 0 };
const other: Device = { token: "b".repeat(64), env: "development", at: 0 };

function setup(o: { devices?: Device[]; creds?: Creds; answer?: Sent } = {}) {
  const t = {
    list: [] as WatchedSession[],
    clock: T,
    active: 0,
    creds: "creds" in o ? o.creds : key,
    devices: o.devices ?? [phone],
    sent: [] as { device: Device; payload: any; collapseId: string }[],
    gone: [] as Device[],
    logs: [] as string[],
    reads: 0,
    replies: [] as string[],
  };
  const deps: PushDeps = {
    sessions: async () => {
      t.reads++;
      return t.list;
    },
    creds: () => t.creds,
    devices: () => t.devices,
    send: async (_c, device, payload, collapseId) => {
      t.sent.push({ device, payload, collapseId });
      return o.answer ?? { status: 200 };
    },
    gone: (d) => void t.gone.push(d),
    reply: async (file) => {
      t.replies.push(file);
      return "All done.";
    },
    now: () => t.clock,
    active: () => t.active,
    log: (l) => void t.logs.push(l),
  };
  return { t, w: new PushWatcher(deps) };
}
const s = (state: WatchedSession["state"], since: number, extra: object = {}) =>
  ({ name: "a", kind: "claude", title: "Fix it", dir: "/w/blimp", state, stateSince: since, ...extra }) as WatchedSession;
const waiting = (at: number) => s("waiting", at, { prompt: { kind: "other", answerable: false, at } });
// The watcher, after it has seen a session working (its first list counts as seen).
async function started(o: Parameters<typeof setup>[0] = {}) {
  const r = setup(o);
  r.t.list = [s("working", T - 5000)];
  await r.w.tick();
  return r;
}

test("with no phone, the session list isn't even read", async () => {
  const { t, w } = setup({ devices: [] });
  await w.tick();
  await w.tick();
  expect(t.reads).toBe(0);
  expect(t.logs).toEqual([]);
});

test("a phone but no key: said once in the log, and nothing read", async () => {
  const { t, w } = setup({ creds: undefined });
  await w.tick();
  await w.tick();
  expect(t.reads).toBe(0);
  expect(t.logs.length).toBe(1);
  expect(t.logs[0]).toContain("blimpd push-key");
});

test("a wait reaches every phone once, collapsed by session", async () => {
  const { t, w } = await started({ devices: [phone, other] });
  t.list = [waiting(T)];
  t.clock = T + 3000;
  await w.tick();
  expect(t.sent.map((x) => x.device)).toEqual([phone, other]);
  expect(t.sent[0].collapseId).toBe("a");
  expect(t.sent[0].payload.aps.alert.title).toBe("Fix it is waiting");
  t.clock = T + 4000;
  await w.tick();
  expect(t.sent.length).toBe(2);
});

test("while the Mac is in use, it waits until 2 minutes after the Mac's last use, and goes if still waiting", async () => {
  const { t, w } = await started();
  t.active = T;
  t.list = [waiting(T + 1000)];
  t.clock = T + 4000;
  await w.tick();
  t.clock = T + 119_000;
  await w.tick();
  expect(t.sent.length).toBe(0);
  t.clock = T + 120_000;
  await w.tick();
  expect(t.sent.length).toBe(1);
});

test("one answered on the Mac while it waited doesn't go", async () => {
  const { t, w } = await started();
  t.active = T;
  t.list = [waiting(T + 1000)];
  t.clock = T + 4000;
  await w.tick();
  t.list = [s("working", T + 60_000)];
  t.clock = T + 120_000;
  await w.tick();
  expect(t.sent.length).toBe(0);
});

test("a finish carries Claude's last reply, from its transcript", async () => {
  const { t, w } = setup();
  t.list = [s("working", T - 60_000, { transcript: "/t/a.jsonl" })];
  await w.tick();
  t.list = [s("done", T, { transcript: "/t/a.jsonl" })];
  t.clock = T + 1000;
  await w.tick();
  expect(t.replies).toEqual(["/t/a.jsonl"]);
  expect(t.sent[0].payload.aps.alert).toEqual({ title: "Fix it finished", body: "All done." });
});

test("a phone Apple says is gone is removed", async () => {
  const { t, w } = await started({ answer: { status: 410, reason: "Unregistered" } });
  t.list = [waiting(T)];
  t.clock = T + 3000;
  await w.tick();
  expect(t.gone).toEqual([phone]);
  expect(t.logs.join("\n")).toContain("removed");
});

test("an empty list after sessions (a zmx list that failed) forgets nothing, so nothing is told again", async () => {
  const { t, w } = setup();
  t.list = [waiting(T - 10_000)];
  await w.tick();
  t.list = [];
  t.clock = T + 1000;
  await w.tick();
  t.list = [waiting(T - 10_000)];
  t.clock = T + 2000;
  await w.tick();
  expect(t.sent.length).toBe(0);
});

test("when the key comes back, what's there then counts as seen", async () => {
  const { t, w } = await started();
  t.creds = undefined;
  await w.tick();
  t.list = [waiting(T)];
  t.clock = T + 10_000;
  await w.tick();
  t.creds = key;
  await w.tick();
  t.clock = T + 11_000;
  await w.tick();
  expect(t.sent.length).toBe(0);
});

test("`active` on the events socket is when the Mac was last in use; other messages are still ignored", () => {
  const ws = { data: eventsData(), send() {} } as any;
  eventsMessage(ws, JSON.stringify({ type: "active" }));
  expect(Date.now() - lastActiveAt()).toBeLessThan(1000);
  expect(() => eventsMessage(ws, JSON.stringify({ type: "bogus" }))).not.toThrow();
  expect(ws.data.watches.size).toBe(0);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `PATH=$HOME/.bun/bin:$PATH bun test test/push-watch.test.ts`
Expected: FAIL, `Cannot find module '../src/push/watch'`.

- [ ] **Step 3: Write `src/push/watch.ts`**

```ts
// The push watcher (docs/superpowers/specs/2026-10-20-phone-push-design.md, section 3): every second, whether or not
// an app is connected, the session list goes through the rule (rule.ts), and what it finds goes to every phone that
// asked, at once or, while the Mac is in use, up to 2 minutes later. Without a key and a phone nothing runs, not even
// the list; once both are there, what it finds first counts as seen.

import { follow, newSummary, type Summary } from "../names";
import { claudeDir, listSessionsLite, type Session, zmxListAsync } from "../sessions";
import { Apns, goneDevice, type Sent } from "./apns";
import { pushPayload } from "./payload";
import { dueAt, type PushEvent, pushChanges, type PushSession, type Seen, stillDue } from "./rule";
import { type Creds, type Device, readCreds, readDevices, removeDevice } from "./store";

export type WatchedSession = PushSession & Pick<Session, "title" | "dir" | "transcript">;
export type PushDeps = {
  sessions: () => Promise<WatchedSession[]>;
  creds: () => Creds | undefined;
  devices: () => Device[];
  send: (c: Creds, d: Device, payload: object, collapseId: string) => Promise<Sent>;
  gone: (d: Device) => void;
  // Claude's last reply in a transcript.
  reply: (transcript: string) => Promise<string | undefined>;
  now: () => number;
  // When the Mac app last said a blimp window was in front.
  active: () => number;
  log: (line: string) => void;
};

export class PushWatcher {
  private seen?: Map<string, Seen>;
  private held: { e: PushEvent; due: number }[] = [];
  private warned = false;
  private busy = false;

  constructor(private deps: PushDeps) {}

  async tick(): Promise<void> {
    if (this.busy) return; // a slow zmx shouldn't pile up checks
    this.busy = true;
    try {
      const devices = this.deps.devices();
      const creds = devices.length ? this.deps.creds() : undefined;
      if (devices.length && !creds && !this.warned) {
        this.warned = true;
        this.deps.log("push: a phone asked for notifications, but there's no push key yet (blimpd push-key)");
      }
      if (!creds) {
        this.seen = undefined;
        this.held = [];
        return;
      }
      const list = await this.deps.sessions();
      // An empty list after sessions is more likely a zmx list that failed than every session gone, and forgetting
      // them would tell their waits again.
      if (!list.length && this.seen?.size) return;
      const now = this.deps.now();
      const { seen, events } = pushChanges(this.seen, list, now);
      this.seen = seen;
      const due = dueAt(now, this.deps.active());
      this.held.push(...events.map((e) => ({ e, due })));
      const ready = this.held.filter((h) => h.due <= now);
      this.held = this.held.filter((h) => h.due > now);
      for (const { e } of ready) {
        const s = list.find((x) => x.name === e.session);
        if (s && stillDue(e, list)) await this.notify(creds, devices, s, e);
      }
    } catch (e) {
      this.deps.log(`push: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  private async notify(creds: Creds, devices: Device[], s: WatchedSession, e: PushEvent) {
    const reply = e.kind === "finish" && s.transcript ? await this.deps.reply(s.transcript) : undefined;
    const payload = pushPayload(s, e, reply);
    for (const d of devices) {
      // A newer notification for a session replaces the older one (Apple allows 64 bytes; names are ASCII).
      const r = await this.deps.send(creds, d, payload, s.name.slice(0, 64));
      if (goneDevice(r)) {
        this.deps.gone(d);
        this.deps.log(`push: Apple says a phone's token no longer works (${r.reason ?? r.status}), so it's removed`);
      } else if (r.status !== 200) this.deps.log(`push: Apple said ${r.status || "nothing"}${r.reason ? ` (${r.reason})` : ""} to ${s.name}'s ${e.kind}`);
    }
  }
}

// When the Mac app last said a blimp window was in front ({ "type": "active" } on /events, events.ts).
let lastActive = 0;
export const markActive = (now = Date.now()) => void (lastActive = now);
export const lastActiveAt = () => lastActive;

const summaries = new Map<string, Summary>(); // by transcript: each finish reads on from where the last one stopped
let client: { id: string; apns: Apns } | undefined;

const live: PushDeps = {
  sessions: async () => listSessionsLite(claudeDir(), await zmxListAsync()),
  creds: () => readCreds(),
  devices: () => readDevices(),
  // One client while the key stays the same; push-key with a new one gets a new client.
  send: (c, d, payload, collapseId) => {
    const id = `${c.keyId}\0${c.teamId}\0${c.key}`;
    if (client?.id !== id) {
      client?.apns.close();
      client = { id, apns: new Apns(c) };
    }
    return client.apns.send(d, payload, { collapseId });
  },
  gone: (d) => void removeDevice(d.token),
  reply: async (file) => {
    if (summaries.size > 200) summaries.clear();
    let sum = summaries.get(file);
    if (!sum) summaries.set(file, (sum = newSummary()));
    await follow(file, sum);
    return sum.reply;
  },
  now: Date.now,
  active: lastActiveAt,
  log: (line) => console.log(line),
};

export function startPush(every = 1000) {
  const w = new PushWatcher(live);
  setInterval(() => void w.tick(), every);
}
```

- [ ] **Step 4: Record `active` on the events socket.** In `src/events.ts`, import `markActive` from `./push/watch`, update the top comment's last line, and handle the message before the watch check:

```ts
// The events socket: the session list whenever it changes, the ports programs in sessions listen
// on (ports.ts), the server browser's tabs (browser/service.ts), and changes to the paths the app
// watches. The Mac app also says here when a blimp window is in front, so the phone's notifications wait
// (push/watch.ts).
```

```ts
// Replaces this socket's watch set (watch), or notes that the Mac is in use (active). Each path is watched on its
// own, not recursively.
export function eventsMessage(ws: ServerWebSocket<EventsData>, msg: string | Buffer) {
  if (typeof msg !== "string") return;
  let m: any;
  try {
    m = JSON.parse(msg);
  } catch {
    return;
  }
  if (m?.type === "active") return markActive();
  if (m?.type !== "watch" || !Array.isArray(m.paths)) return;
```

(The rest of `eventsMessage` stays as it is.)

- [ ] **Step 5: Start the watcher with blimpd.** In `src/server.ts`, import `startPush` from `./push/watch`, and in `serve()` after `startHandoffs();`:

```ts
  startHandoffs();
  startPush(); // phone notifications: nothing runs until there's a push key and a phone that asked (push/watch.ts)
```

- [ ] **Step 6: Run the tests**

Run: `PATH=$HOME/.bun/bin:$PATH bun test test/push-watch.test.ts test/push-rule.test.ts test/push-payload.test.ts`
Expected: all pass (10 in push-watch).

- [ ] **Step 7: Commit**

```bash
git add src/push/watch.ts src/events.ts src/server.ts test/push-watch.test.ts
git commit -m "blimpd: a push watcher runs every second, with or without an app connected, once there's a push key and a phone that asked: what the rule finds goes to every phone (a finish with Claude's last reply), waits while the Mac said in the last 2 minutes that a blimp window is in front, and a phone Apple says is gone is removed; the Mac says so with { type: active } on /events"
```

---

### Task 6: The routes and the commands

**Files:**
- Create: `src/push/cli.ts`
- Modify: `src/server.ts` (route, before `/events`), `src/main.ts` (commands, usage, top comment)
- Test: `test/push-cli.test.ts` (new), `test/server.test.ts` (new `describe("push")` at the end)

**Interfaces:**
- Consumes: `addDevice`, `removeDevice`, `isDeviceToken`, `isPushEnv`, `readCreds`, `readDevices`, `saveCreds`, `devicesFile` (store.ts); `Apns`, `HOSTS`, `goneDevice` (apns.ts); `HttpError` (files.ts).
- Produces: `POST /push/device { token, env }` → 204; `DELETE /push/device { token }` → 204; 400 on a bad token or env. `runPushKey(args: string[], dir?: string): number`, `runPushTest(dir?: string, hosts?: Record<PushEnv, string>): Promise<number>`.

- [ ] **Step 1: Write the failing route test.** At the end of `test/server.test.ts`, add:

```ts
describe("push", () => {
  test("a phone asks for notifications with its device token, at most 5 are kept, and it can stop", async () => {
    const device = (token: unknown, env: unknown = "production", method = "POST") => api("/push/device", { method, body: JSON.stringify({ token, env }) });
    const stored = () => JSON.parse(readFileSync(join(tmp, "push.json"), "utf8")).devices.map((d: { token: string }) => d.token[0]);
    expect((await device("a".repeat(64))).status).toBe(204);
    expect(statSync(join(tmp, "push.json")).mode & 0o777).toBe(0o600);
    for (const c of "bcdef") await device(c.repeat(64), "development");
    expect(stored()).toEqual(["f", "e", "d", "c", "b"]);
    expect((await device("f".repeat(64), undefined, "DELETE")).status).toBe(204);
    expect(stored()).toEqual(["e", "d", "c", "b"]);
    expect((await device("xyz")).status).toBe(400);
    expect((await device("a".repeat(64), "staging")).status).toBe(400);
    expect((await api("/push/device", { method: "POST", body: "null" })).status).toBe(400);
  });
});
```

- [ ] **Step 2: Write the failing command tests** in `test/push-cli.test.ts`:

```ts
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
```

- [ ] **Step 3: Run them to see them fail**

Run: `PATH=$HOME/.bun/bin:$PATH bun test test/push-cli.test.ts`
Expected: FAIL, `Cannot find module '../src/push/cli'`.

Run: `PATH=$HOME/.bun/bin:$PATH bun test test/server.test.ts -t "push"`
Expected: FAIL, the first POST answers 404, not 204.

- [ ] **Step 4: Write `src/push/cli.ts`**

```ts
// `blimpd push-key <file.p8> --key-id <id> --team-id <id>`: the push key from Apple's developer site, copied beside
// the socket (store.ts); the running blimpd uses it from its next check, no restart. `blimpd push-test`: "blimp can
// reach this phone" to every phone that asked for notifications, with Apple's answer for each.

import { readFileSync } from "node:fs";
import { blimpDir } from "../sessions";
import { Apns, goneDevice, HOSTS } from "./apns";
import { devicesFile, type PushEnv, readCreds, readDevices, removeDevice, saveCreds } from "./store";

const KEY_USAGE = "usage: blimpd push-key <file.p8> --key-id <id> --team-id <id>";

export function runPushKey(args: string[], dir = blimpDir()): number {
  const [file, ...rest] = args;
  const opt = (name: string) => {
    const i = rest.indexOf(name);
    return i >= 0 && i % 2 === 0 ? rest[i + 1] : undefined;
  };
  const keyId = opt("--key-id");
  const teamId = opt("--team-id");
  if (!file || file.startsWith("--") || rest.length !== 4 || !keyId || !teamId) {
    console.error(KEY_USAGE);
    return 1;
  }
  let p8: string;
  try {
    p8 = readFileSync(file, "utf8");
  } catch {
    console.error(`blimpd: can't read ${file}`);
    return 1;
  }
  try {
    saveCreds(p8, keyId, teamId, dir);
  } catch (e) {
    console.error(`blimpd: ${(e as Error).message}`);
    return 1;
  }
  console.log(`Push key saved. You can delete ${file} now. blimpd push-test sends a test notification.`);
  return 0;
}

export async function runPushTest(dir = blimpDir(), hosts: Record<PushEnv, string> = HOSTS): Promise<number> {
  const creds = readCreds(dir);
  if (!creds) {
    console.error("blimpd: no push key yet. Run blimpd push-key first.");
    return 1;
  }
  const file = devicesFile(dir);
  const devices = readDevices(file);
  if (!devices.length) {
    console.error("blimpd: no phone has asked for notifications yet. Open blimp on the iPhone and allow them.");
    return 1;
  }
  const apns = new Apns(creds, hosts);
  let sent = 0;
  try {
    for (const d of devices) {
      const r = await apns.send(d, { aps: { alert: { title: "blimp", body: "blimp can reach this phone" }, sound: "default" } });
      const which = `${d.token.slice(0, 8)}… (${d.env})`;
      if (r.status === 200) {
        sent++;
        console.log(`${which}: sent`);
        continue;
      }
      const gone = goneDevice(r);
      if (gone) removeDevice(d.token, file);
      console.log(`${which}: Apple said ${r.status || "nothing"}${r.reason ? ` (${r.reason})` : ""}${gone ? "; removed it" : ""}`);
    }
  } finally {
    apns.close();
  }
  return sent ? 0 : 1;
}
```

- [ ] **Step 5: Add the route.** In `src/server.ts`, import `addDevice`, `isDeviceToken`, `isPushEnv`, `removeDevice` from `./push/store`, and add before `if (path === "/events" && get)`:

```ts
  // Phone notifications (push/): a phone asks for them with its device token, and says when it stops.
  if (path === "/push/device" && (req.method === "POST" || req.method === "DELETE")) {
    const { token: device, env } = ((await req.json()) ?? {}) as Record<string, unknown>;
    if (!isDeviceToken(device)) throw new HttpError(400, "token must be the phone's device token, in hex");
    if (req.method === "DELETE") removeDevice(device);
    else if (isPushEnv(env)) addDevice(device, env);
    else throw new HttpError(400, 'env must be "development" or "production"');
    return new Response(null, { status: 204 });
  }
```

- [ ] **Step 6: Add the commands.** In `src/main.ts`, import `runPushKey`, `runPushTest` from `./push/cli`; add to the top comment after the `pair --revoke` line:

```ts
//   blimpd push-key <file.p8> --key-id <id> --team-id <id>  the push key from Apple, for the phone's notifications
//   blimpd push-test           a test notification to every phone that asked for them
```

and after the `pair` branch:

```ts
} else if (cmd === "push-key") {
  process.exit(runPushKey(args));
} else if (cmd === "push-test") {
  process.exit(await runPushTest());
```

and in the usage line, after `pair [--url <url> | --revoke] | `, add `push-key <file.p8> --key-id <id> --team-id <id> | push-test | `.

- [ ] **Step 7: Run the tests**

Run: `PATH=$HOME/.bun/bin:$PATH bun test test/push-cli.test.ts`
Expected: 5 pass, 0 fail.

Run: `PATH=$HOME/.bun/bin:$PATH bun test test/server.test.ts -t "push"`
Expected: pass.

- [ ] **Step 8: Commit**

```bash
git add src/push/cli.ts src/server.ts src/main.ts test/push-cli.test.ts test/server.test.ts
git commit -m "blimpd: POST /push/device { token, env } is a phone asking for notifications and DELETE stops them; blimpd push-key saves the push key from Apple's developer site, and blimpd push-test sends a test notification to every phone and prints Apple's answer for each"
```

---

### Task 7: Docs, and the whole suite

**Files:**
- Modify: `docs/DESIGN.md` (Events: the client message; a new `### Push` section after `### Digests`), `docs/SECURITY.md` (a table row, an Accepted bullet)

- [ ] **Step 1: DESIGN.md, Events.** In `### Events`, replace the "Client → server" paragraph with:

```markdown
Client → server: `{ "type": "watch", "paths": string[] }` replaces this socket's watch set. Each path is watched non-recursively (a folder: its direct entries; a file: its content). The app sends the expanded folders of the tree plus the open files. Paths outside home are ignored. `{ "type": "active" }`: a blimp window is in front on the Mac (sent at most every 30 s), so the phone's notifications wait (see Push).
```

- [ ] **Step 2: DESIGN.md, a Push section.** After the `### Digests` section, add:

```markdown
### Push

Notifications on Max's phone when a session waits on him or a Claude turn ends, with both apps closed (`src/push/`, design in `docs/superpowers/specs/2026-10-20-phone-push-design.md`). blimpd sends straight to Apple with Max's own push key: no relay.

- **Setup:** `blimpd push-key <file.p8> --key-id <id> --team-id <id>` copies the key from Apple's developer site to `<socket dir>/apns.p8` and the ids to `apns.json` (both 600). No file route serves the key. `blimpd push-test` sends "blimp can reach this phone" to every phone and prints Apple's answer for each. Without a key, blimpd sends nothing and says so once in its log.
- **Phones:** `POST /push/device { "token": hex, "env": "development" | "production" }` → 204 adds one (`<socket dir>/push.json`, 600, at most 5, newest kept); `DELETE /push/device { "token" }` → 204 removes it; 400 for a token that isn't hex or another env. Apple's 410, `BadDeviceToken` or `Unregistered` removes a phone. `blimpd pair --revoke` removes them all.
- **When:** a watcher checks the session list every 1 s, always, once there's a key and a phone. A wait is told once it has lasted 3 s (a permission's options are read from the screen up to 2 s after it starts, and Yes and No need the final ones), once per `prompt.at` (or `stateSince` without a prompt). A Claude turn of 30 s or more is told when it ends (`working` to `done`; the turn's waits count). The list found first counts as seen, so a restart tells nothing again. While the Mac sent `active` in the last 2 minutes, a notification waits until 2 minutes after it, then goes only if the session still shows the same wait or the same finish. Codex and shell sessions: waits only.
- **What:** title "<session title> is waiting" or "… finished". A permission: its summary, category `permission` (the app's Yes and No), and `at`, `yes: { pick, label }` (the first option), `no: { pick, label }` (the last). A question: its first question. Another wait: the folder's name. A finish: the last reply as plain text, 150 characters at most. Secrets come out of all text. `apns-collapse-id` and `thread-id` are the session's name, so a newer one replaces the older.
- **Sending:** one HTTP/2 connection per Apple service, kept while it works; a JWT (ES256, `iss` Team ID, `kid` Key ID) made again every 40 minutes; `apns-topic: dev.blimp.phone`. A failed send is logged with Apple's reason and not retried, except once on a fresh connection after a dropped one.
```

- [ ] **Step 3: SECURITY.md.** In the table under "Who might attack, and what stops them", add a last row:

```markdown
| Anyone but you | Send your phone fake notifications | Only the holder of the push key can. It stays on the server in `~/.blimp/apns.p8` (600), and no file route serves, replaces or downloads it. |
```

Under "Accepted", add a last bullet:

```markdown
- **Notifications go through Apple.** Once you add a push key, blimpd makes outbound HTTPS connections to Apple's push service, and a notification's text (a session's title, a command's summary, a question, the start of a reply, with secrets taken out) passes through Apple's servers to reach the phone.
```

- [ ] **Step 4: Run the whole suite**

Run: `PATH=$HOME/.bun/bin:$PATH bun test ./test`
Expected: all pass. (It uses real zmx sessions in a private socket folder, as CI does; it takes a few minutes.)

- [ ] **Step 5: Commit**

```bash
git add docs/DESIGN.md docs/SECURITY.md
git commit -m "docs: phone notifications on the server side: the push key, the phones, when blimpd tells them and what it says, and what it means for security"
```

---

## After this plan

- Push the branch, check CI (`ci.yml` runs `bun test ./test` on main; for the branch, run the suite locally as in Task 7).
- Step 2 (the app: entitlement, permission, registration, Settings switch, a tap opens the chat) gets its own plan. Only then can `blimpd push-test` reach Max's phone; Max makes the `.p8` key then (spec section 1).
