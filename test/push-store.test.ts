// Phone notifications' files (src/push/store.ts), in temp folders.

import { afterAll, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addDevice, addWidget, clearDevices, credsFile, devicesFile, isDeviceToken, isWidgetToken, keyFile, readCreds, readDevices, readWidgets, removeDevice, removeWidget, saveCreds } from "../src/push/store";

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

test("widget push tokens are kept beside the devices, and each list leaves the other as it was", () => {
  const file = join(mkdtempSync(join(tmpdir(), "blimp-push-")), "push.json");
  addDevice("a".repeat(64), "production", 1, file);
  addWidget("AB".repeat(50), "development", 2, file);
  expect(readDevices(file).map((d) => d.token)).toEqual(["a".repeat(64)]);
  expect(readWidgets(file)).toEqual([{ token: "ab".repeat(50), env: "development", at: 2 }]);
  addDevice("b".repeat(64), "production", 3, file);
  expect(readWidgets(file).length).toBe(1);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  removeWidget("ab".repeat(50), file);
  expect(readWidgets(file)).toEqual([]);
  expect(readDevices(file).map((d) => d.token[0])).toEqual(["b", "a"]);
  // no widgets: push.json is as it was before widgets
  expect(Object.keys(JSON.parse(readFileSync(file, "utf8")))).toEqual(["devices"]);
});

test("a widget push token is hex, 64 to 400 characters", () => {
  expect(isWidgetToken("ab".repeat(32))).toBe(true);
  expect(isWidgetToken("ab".repeat(200))).toBe(true);
  expect(isWidgetToken("ab".repeat(201))).toBe(false);
  expect(isWidgetToken("xyz")).toBe(false);
  expect(isWidgetToken(5)).toBe(false);
});
