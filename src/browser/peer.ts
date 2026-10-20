// Who is on the other end of a local TCP connection: the gate (gate.ts) listens on 127.0.0.1,
// which every account on the server can reach, so it lets in only connections whose socket
// belongs to blimpd's own uid. The kernel's connection tables say so: the row whose local address
// is the peer's, and its uid column.

import { readFileSync } from "node:fs";

// An address as /proc/net/tcp(6) writes it: the bytes of each 32-bit word in host (little-endian)
// order, in hex. null: not an address.
export function hexAddress(address: string): string | null {
  const word = (bytes: number[]) => bytes.slice().reverse().map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  const v4 = (s: string) => {
    const b = s.split(".").map(Number);
    return b.length === 4 && b.every((n) => Number.isInteger(n) && n >= 0 && n < 256) ? b : null;
  };
  const four = v4(address);
  if (four) return word(four);
  if (!address.includes(":")) return null;
  // IPv6: expand ::, and a trailing a.b.c.d (as in ::ffff:127.0.0.1).
  let s = address;
  const tail = s.match(/:(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const b = v4(tail[1]);
    if (!b) return null;
    s = s.slice(0, -tail[1].length) + ((b[0] << 8) | b[1]).toString(16) + ":" + ((b[2] << 8) | b[3]).toString(16);
  }
  const [head, rest] = s.split("::");
  const parts = (x: string | undefined) => (x ? x.split(":") : []);
  const h = parts(head);
  const r = parts(rest);
  const groups = rest === undefined ? h : [...h, ...Array(8 - h.length - r.length).fill("0"), ...r];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return null;
  const bytes = groups.flatMap((g) => [parseInt(g, 16) >> 8, parseInt(g, 16) & 255]);
  return [0, 4, 8, 12].map((i) => word(bytes.slice(i, i + 4))).join("");
}

// The uid of the connected socket at address:port in a /proc/net/tcp(6) table, else null.
export function tcpOwner(table: string, address: string, port: number): number | null {
  const hex = hexAddress(address);
  if (!hex) return null;
  const want = `${hex}:${port.toString(16).toUpperCase().padStart(4, "0")}`;
  for (const line of table.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    // 01: established. A socket that's closing may already be the kernel's (uid 0).
    if (f.length > 7 && f[1] === want && f[3] === "01") return Number(f[7]);
  }
  return null;
}

const read = (p: string) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
};

export const peerUid = (address: string, port: number): number | null =>
  tcpOwner(read("/proc/net/tcp"), address, port) ?? tcpOwner(read("/proc/net/tcp6"), address, port);
