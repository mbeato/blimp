// When usage scans run (docs/superpowers/specs/2026-11-19-usage-design.md, "Counting", When): 30 seconds
// after blimpd starts, then every 10 minutes, and when GET /usage is asked and the last one ended over a
// minute ago. One at a time. Each is a child process (`blimpd usage-scan`, scan.ts), so a long first
// scan doesn't hold up blimpd.

import type { Subprocess } from "bun";
import { selfCommand } from "../browser/mcp";

let running: Subprocess | undefined;
let endedAt = 0;

// Starts a scan unless one runs or the last ended under maxAge ms ago. What a failed scan says goes to blimpd's own log.
export function ensureScan(maxAge = 60_000): void {
  if (running || Date.now() - endedAt < maxAge) return;
  const p = (running = Bun.spawn([...selfCommand(), "usage-scan"], { stdin: "ignore", stdout: "ignore", stderr: "inherit" }));
  void p.exited.then(() => {
    running = undefined;
    endedAt = Date.now();
  });
}

export function startUsage(): void {
  setTimeout(() => ensureScan(0), 30_000);
  setInterval(() => ensureScan(0), 10 * 60_000);
}
