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
