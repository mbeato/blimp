// `blimpd pair`: run as the real command, in a temp socket folder, with a stand-in `tailscale` on PATH
// (or none). No real tailscale is called.

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pairLink, QUIET, qrLines, tailscaleUrl } from "../src/pair";
import { qrcodegen } from "../src/vendor/qrcodegen";

const tmp = mkdtempSync(join(tmpdir(), "blimp-pair-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// What `tailscale status --json` prints, cut down to what pair reads.
const STATUS = JSON.stringify({
  BackendState: "Running",
  Self: { HostName: "claude1", DNSName: "claude1.tail1234.ts.net.", TailscaleIPs: ["100.101.102.103"] },
});

// A PATH with only a stand-in tailscale: it prints `status` (or fails when there's none).
function fakePath(status?: string): string {
  const bin = mkdtempSync(join(tmp, "bin-"));
  if (status !== undefined) {
    writeFileSync(join(bin, "status.json"), status);
    writeFileSync(join(bin, "tailscale"), `#!/bin/sh\n[ "$*" = "status --json" ] && exec /bin/cat "${join(bin, "status.json")}"\nexit 1\n`);
    chmodSync(join(bin, "tailscale"), 0o755);
  }
  return bin;
}

function pair(dir: string, args: string[], path = fakePath()) {
  const p = Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "src", "main.ts"), "pair", ...args], {
    env: { HOME: tmp, PATH: path, BLIMPD_SOCKET: join(dir, "blimpd.sock") },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

const linkIn = (out: string) => out.match(/^blimp:\/\/pair\?\S+$/m)?.[0];

describe("blimpd pair", () => {
  test("makes a 600 phone token in a 700 folder, prints the link with it, and reuses it next time", () => {
    const dir = join(tmp, "a");
    const r = pair(dir, [], fakePath(STATUS));
    expect(r.code).toBe(0);
    const token = readFileSync(join(dir, "phone-token"), "utf8");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(join(dir, "phone-token")).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(linkIn(r.out)).toBe(`blimp://pair?url=https%3A%2F%2Fclaude1.tail1234.ts.net&token=${token}`);
    // The Mac's token is a separate file that pair doesn't make.
    expect(existsSync(join(dir, "token"))).toBe(false);

    const again = pair(dir, [], fakePath(STATUS));
    expect(linkIn(again.out)).toBe(linkIn(r.out));
    expect(readFileSync(join(dir, "phone-token"), "utf8")).toBe(token);
  });

  test("--url wins over Tailscale, and is percent-encoded", () => {
    const dir = join(tmp, "b");
    const r = pair(dir, ["--url", "https://box.example.com:8443/"], fakePath(STATUS));
    expect(r.code).toBe(0);
    const token = readFileSync(join(dir, "phone-token"), "utf8").trim();
    expect(linkIn(r.out)).toBe(`blimp://pair?url=https%3A%2F%2Fbox.example.com%3A8443&token=${token}`);
  });

  test("an empty phone-token file gets a new token", () => {
    const dir = join(tmp, "c");
    mkdirSync(dir);
    writeFileSync(join(dir, "phone-token"), "\n");
    expect(pair(dir, ["--url", "https://x.ts.net"]).code).toBe(0);
    expect(readFileSync(join(dir, "phone-token"), "utf8")).toMatch(/^[0-9a-f]{64}$/);
  });

  test("with neither Tailscale nor --url: exit 1, a plain message, no token made", () => {
    for (const path of [fakePath(), fakePath(""), fakePath(JSON.stringify({ Self: { DNSName: "" } }))]) {
      const dir = join(tmp, "d");
      const r = pair(dir, [], path);
      expect(r.code).toBe(1);
      expect(r.err).toContain("Install Tailscale and sign in (tailscale up), or pass --url <address>.");
      expect(existsSync(join(dir, "phone-token"))).toBe(false);
    }
  });

  test("a --url that isn't a web address, or unknown arguments: exit 1", () => {
    const dir = join(tmp, "e");
    expect(pair(dir, ["--url", "claude1"]).code).toBe(1);
    expect(pair(dir, ["--url", "ftp://claude1"]).code).toBe(1);
    expect(pair(dir, ["--url"]).code).toBe(1);
    expect(pair(dir, ["--bogus"]).code).toBe(1);
    expect(existsSync(join(dir, "phone-token"))).toBe(false);
  });

  test("--revoke deletes the phone token and leaves the Mac's", () => {
    const dir = join(tmp, "f");
    mkdirSync(dir);
    writeFileSync(join(dir, "token"), "mac");
    expect(pair(dir, ["--url", "https://x.ts.net"]).code).toBe(0);
    const r = pair(dir, ["--revoke"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Phone token deleted");
    expect(existsSync(join(dir, "phone-token"))).toBe(false);
    expect(readFileSync(join(dir, "token"), "utf8")).toBe("mac");
    expect(pair(dir, ["--revoke"]).out).toContain("There was no phone token.");
  });
});

describe("pair's parts", () => {
  test("the DNS name from tailscale status --json, without its trailing dot", () => {
    expect(tailscaleUrl(STATUS)).toBe("https://claude1.tail1234.ts.net");
    expect(tailscaleUrl(JSON.stringify({ Self: { DNSName: "claude1.tail1234.ts.net" } }))).toBe("https://claude1.tail1234.ts.net");
    expect(tailscaleUrl(JSON.stringify({ Self: { DNSName: "" } }))).toBeUndefined();
    expect(tailscaleUrl(JSON.stringify({ Self: { DNSName: "." } }))).toBeUndefined();
    expect(tailscaleUrl(JSON.stringify({ BackendState: "NeedsLogin" }))).toBeUndefined();
    expect(tailscaleUrl("not json")).toBeUndefined();
    expect(tailscaleUrl("")).toBeUndefined();
  });

  test("the link", () => {
    expect(pairLink("http://127.0.0.1:7425", "ab")).toBe("blimp://pair?url=http%3A%2F%2F127.0.0.1%3A7425&token=ab");
  });

  test("the QR code is as wide as its modules plus the border, two rows per line, set in white on black", () => {
    const link = pairLink("https://claude1.tail1234.ts.net", "ab".repeat(32));
    const size = qrcodegen.QrCode.encodeText(link, qrcodegen.QrCode.Ecc.LOW).size;
    const lines = qrLines(link);
    const plain = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
    expect(lines.length).toBe(Math.ceil((size + 2 * QUIET) / 2));
    for (const l of plain) expect([...l].length).toBe(size + 2 * QUIET);
    for (const l of lines) expect(l.startsWith("\x1b[97;40m") && l.endsWith("\x1b[0m")).toBe(true);
    for (const l of plain) expect(l).toMatch(/^[ █▀▄]+$/);
    // The border: whole light lines on top, light columns at the sides.
    expect(plain[0]).toBe("█".repeat(size + 2 * QUIET));
    // The last line's lower half is past the code (it has an odd number of rows) and stays black.
    for (const l of plain.slice(0, -1)) expect(l.startsWith("████") && l.endsWith("████")).toBe(true);
    expect(plain.at(-1)).toBe("▀".repeat(size + 2 * QUIET));
    // The top-left finder pattern starts right after the border: line 2 is its first two rows (all dark, then dark,
    // five light, dark).
    expect([...plain[2]].slice(QUIET, QUIET + 7).join("")).toBe(" ▄▄▄▄▄ ");
  });
});
