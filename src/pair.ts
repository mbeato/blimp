// `blimpd pair`: the phone's own token, and the blimp:// link (as a QR code and as text) that hands the
// server's address and that token to the iPhone app. `blimpd pair --revoke` deletes the token; the Mac's
// token (<socket dir>/token) is separate and keeps working.

import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readPhoneToken } from "./server";
import { blimpDir } from "./sessions";
import { qrcodegen } from "./vendor/qrcodegen";

// <dir>/phone-token, made if it's missing or empty: 32 random bytes as hex, readable only by you.
export function phoneToken(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = join(dir, "phone-token");
  let token = readPhoneToken(dir);
  if (!token) writeFileSync(file, (token = randomBytes(32).toString("hex")), { mode: 0o600 });
  chmodSync(file, 0o600);
  return token;
}

// https://<this machine's tailnet name>, from `tailscale status --json` (its DNSName ends in a dot).
export function tailscaleUrl(statusJson: string): string | undefined {
  try {
    const name = JSON.parse(statusJson)?.Self?.DNSName;
    if (typeof name === "string" && name.replace(/\.$/, "")) return `https://${name.replace(/\.$/, "")}`;
  } catch {}
}

function tailscaleStatus(): string | undefined {
  try {
    const p = Bun.spawnSync(["tailscale", "status", "--json"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    return p.success ? p.stdout.toString() : undefined;
  } catch {
    return undefined; // not installed
  }
}

// The same format the app's ServerLink.parse reads.
export const pairLink = (url: string, token: string) => `blimp://pair?url=${encodeURIComponent(url)}&token=${token}`;

export const QUIET = 4; // modules of light border around the code, as the QR standard asks

// The QR code as terminal lines, two modules per character (Unicode half blocks). The colours are set
// (white on black), not left to the terminal, so phones read it from a dark terminal and a light one alike:
// dark modules are spaces on the black background, light modules and the border are white blocks.
export function qrLines(text: string): string[] {
  const qr = qrcodegen.QrCode.encodeText(text, qrcodegen.QrCode.Ecc.LOW);
  const n = qr.size + 2 * QUIET;
  const light = (x: number, y: number) => !qr.getModule(x - QUIET, y - QUIET); // outside the code: light
  const lines: string[] = [];
  for (let y = 0; y < n; y += 2) {
    let line = "\x1b[97;40m";
    for (let x = 0; x < n; x++) {
      const top = light(x, y);
      const bottom = y + 1 < n && light(x, y + 1);
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(line + "\x1b[0m");
  }
  return lines;
}

const USAGE = "usage: blimpd pair [--url <url>] | pair --revoke";

export function runPair(args: string[], dir = blimpDir()): number {
  if (args.length === 1 && args[0] === "--revoke") {
    const had = !!readPhoneToken(dir);
    rmSync(join(dir, "phone-token"), { force: true });
    console.log(had ? "Phone token deleted. The phone can't connect any more; the Mac still can." : "There was no phone token.");
    return 0;
  }
  let url: string | undefined;
  if (args.length === 2 && args[0] === "--url") {
    url = args[1].replace(/\/+$/, "");
    let ok = false;
    try {
      const u = new URL(url);
      ok = (u.protocol === "https:" || u.protocol === "http:") && !!u.hostname;
    } catch {}
    if (!ok) {
      console.error(`blimpd: --url needs a web address, like https://claude1.example.ts.net (got ${args[1]})`);
      return 1;
    }
  } else if (args.length) {
    console.error(USAGE);
    return 1;
  }
  url ??= tailscaleUrl(tailscaleStatus() ?? "");
  if (!url) {
    console.error("blimpd: can't tell this server's address. Install Tailscale and sign in (tailscale up), or pass --url <address>.");
    return 1;
  }
  const link = pairLink(url, phoneToken(dir));
  console.log(`Scan this with the blimp app on your iPhone (Pair, Scan QR code), or paste the link below it.\n`);
  console.log(qrLines(link).join("\n"));
  console.log(`\n${link}\n`);
  console.log("blimpd pair --revoke cuts the phone off. The Mac keeps working.");
  return 0;
}
