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
