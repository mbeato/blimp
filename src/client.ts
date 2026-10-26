// For blimpd's commands that run inside a session (overview, start, answer): the running blimpd, on its socket,
// with the Mac's token, as `blimpd send` reaches it.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { blimpDir, socketPath } from "./sessions";

export async function callBlimpd(path: string, init: RequestInit = {}): Promise<Response> {
  let token: string;
  try {
    token = readFileSync(join(blimpDir(), "token"), "utf8").trim();
  } catch {
    throw new Error("blimpd isn't set up here (no token)");
  }
  try {
    return await fetch(`http://blimpd${path}`, { ...init, unix: socketPath(), headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } } as any);
  } catch {
    throw new Error("blimpd isn't running");
  }
}

// A GET's JSON, or blimpd's error as the thrown message.
export async function getJson<T>(path: string): Promise<T> {
  const r = await callBlimpd(path);
  const body: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.error ?? `blimpd answered ${r.status}`);
  return body as T;
}
