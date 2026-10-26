// The feed's requests (docs/DESIGN.md, "Feed"): 10 s each, the connection included (AbortSignal.timeout), with
// blimpd's own User-Agent, and at most 1 MB of the answer read. The job awaits each, so they go one at a time. A
// failure's reason in a few words, for the caught-up card.

import pkg from "../../package.json";

export type Got = { status: number; text: string; type: string };
export type Get = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<Got>;

export const USER_AGENT = `blimpd/${pkg.version} (feed)`;
const LIMIT = 1024 * 1024;

export const liveGet: Get = async (url, init = {}) => {
  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers: { "User-Agent": USER_AGENT, ...init.headers },
    body: init.body,
    redirect: "follow",
    signal: AbortSignal.timeout(10_000),
  });
  const reader = res.body?.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  while (reader && size < LIMIT) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    size += value.length;
  }
  await reader?.cancel().catch(() => {});
  const all = new Uint8Array(Math.min(size, LIMIT));
  let at = 0;
  for (const p of parts) {
    const n = Math.min(p.length, all.length - at);
    all.set(p.subarray(0, n), at);
    at += n;
    if (at >= all.length) break;
  }
  return { status: res.status, text: new TextDecoder().decode(all), type: res.headers.get("content-type") ?? "" };
};

// A source that didn't work, with the words the caught-up card shows.
export class FeedError extends Error {}

export function whyFailed(e: unknown): string {
  if (e instanceof FeedError) return e.message;
  const name = (e as Error)?.name;
  if (name === "TimeoutError" || name === "AbortError") return "timed out";
  return "couldn't reach it";
}

// The answer's text; anything but 2xx is a FeedError.
export async function getText(get: Get, url: string, init?: Parameters<Get>[1]): Promise<string> {
  const r = await get(url, init);
  if (r.status < 200 || r.status >= 300) throw new FeedError(`answered ${r.status}`);
  return r.text;
}

export async function getJson(get: Get, url: string, init?: Parameters<Get>[1]): Promise<any> {
  const t = await getText(get, url, init);
  try {
    return JSON.parse(t);
  } catch {
    throw new FeedError("couldn't read it");
  }
}
