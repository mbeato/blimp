// Phone notifications' files, beside the socket (docs/superpowers/specs/2026-10-20-phone-push-design.md):
// apns.p8, the push key from Apple's developer site, and apns.json { keyId, teamId }, both from `blimpd
// push-key`; push.json { devices: [{ token, env, at }], widgets: [...], starts: [...], activities: [...] }, the phones
// that asked for notifications, the widgets' push tokens (iOS 26 widget push, src/push/widgets.ts), and the live
// panel's: the push-to-start token, and the token of the panel that's up (src/push/live.ts). All 600,
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
// WidgetKit's push tokens: hex, longer than a device's can be.
export const isWidgetToken = (t: unknown): t is string => typeof t === "string" && /^[0-9a-f]{64,400}$/i.test(t);
// ActivityKit's push-to-start and Live Activity tokens: hex, as long as a widget's can be.
export const isLiveToken = isWidgetToken;
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

type Lists = { devices: Device[]; widgets: Device[]; starts: Device[]; activities: Device[] };
// The live panel's lists: push-to-start tokens, and the tokens of the panel that's up.
export type LiveList = "starts" | "activities";

const valid = (list: unknown, isToken: (t: unknown) => boolean): Device[] =>
  Array.isArray(list) ? list.filter((x) => isToken(x?.token) && isPushEnv(x?.env) && typeof x?.at === "number") : [];

// Missing or unreadable: none. Entries that aren't phones (or widgets) are left out.
function readLists(file: string): Lists {
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    return {
      devices: valid(j?.devices, isDeviceToken),
      widgets: valid(j?.widgets, isWidgetToken),
      starts: valid(j?.starts, isLiveToken),
      activities: valid(j?.activities, isLiveToken),
    };
  } catch {}
  return { devices: [], widgets: [], starts: [], activities: [] };
}

// An empty list but the devices' is left out: without widgets or a live panel, the file is as it was before them.
const writeLists = (file: string, l: Lists) =>
  write(
    file,
    JSON.stringify({
      devices: l.devices,
      ...(l.widgets.length ? { widgets: l.widgets } : {}),
      ...(l.starts.length ? { starts: l.starts } : {}),
      ...(l.activities.length ? { activities: l.activities } : {}),
    }),
  );

// Adds one, or moves it to the front with its env and time; only the 5 newest are kept.
function add(key: keyof Lists, token: string, env: PushEnv, now: number, file: string): Device[] {
  const t = token.toLowerCase();
  const l = readLists(file);
  l[key] = [{ token: t, env, at: now }, ...l[key].filter((d) => d.token !== t)].slice(0, MAX_DEVICES);
  writeLists(file, l);
  return l[key];
}

function remove(key: keyof Lists, token: string, file: string): Device[] {
  const t = token.toLowerCase();
  const l = readLists(file);
  const had = l[key].length;
  l[key] = l[key].filter((d) => d.token !== t);
  if (l[key].length !== had) writeLists(file, l);
  return l[key];
}

export const readDevices = (file = devicesFile()): Device[] => readLists(file).devices;
export const addDevice = (token: string, env: PushEnv, now = Date.now(), file = devicesFile()) => add("devices", token, env, now, file);
export const removeDevice = (token: string, file = devicesFile()) => remove("devices", token, file);

export const readWidgets = (file = devicesFile()): Device[] => readLists(file).widgets;
export const addWidget = (token: string, env: PushEnv, now = Date.now(), file = devicesFile()) => add("widgets", token, env, now, file);
export const removeWidget = (token: string, file = devicesFile()) => remove("widgets", token, file);

export const readLive = (list: LiveList, file = devicesFile()): Device[] => readLists(file)[list];
export const addLive = (list: LiveList, token: string, env: PushEnv, now = Date.now(), file = devicesFile()) => add(list, token, env, now, file);
export const removeLive = (list: LiveList, token: string, file = devicesFile()) => remove(list, token, file);
// A panel ended or a new one is starting: the tokens kept are an ended panel's.
export function clearLive(list: LiveList, file = devicesFile()) {
  const l = readLists(file);
  if (!l[list].length) return;
  l[list] = [];
  writeLists(file, l);
}

// `blimpd pair --revoke`: a phone that can't connect gets no notifications, its widgets no pings, and no live panel.
export function clearDevices(file = devicesFile()) {
  rmSync(file, { force: true });
}
