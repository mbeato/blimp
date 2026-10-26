// Reddit for the feed (docs/DESIGN.md, "Feed"): the top 5 posts of a subreddit's rising list (not stickied, not over
// 18) and a post's top 3 comments, through Reddit's API with an app-only token. The key is Max's own Reddit app
// ("script" type), given once with `blimpd reddit-key <client id> <secret>` and kept in <socket dir>/reddit.json
// (600); no route sends it back.

import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { blimpDir } from "../sessions";
import { FeedError, type Get } from "./net";
import type { Found } from "./store";

export type RedditKey = { id: string; secret: string };

export const redditFile = (dir = blimpDir()) => join(dir, "reddit.json");
export const REDDIT_TOKEN = "https://www.reddit.com/api/v1/access_token";
const API = "https://oauth.reddit.com";
// raw_json=1: titles and links come as they are, not HTML-escaped.
export const redditListing = (sub: string) => `${API}/r/${sub}/rising?limit=10&raw_json=1`;
export const redditCommentsUrl = (permalink: string) => `${API}${permalink}?limit=3&sort=top&depth=1&raw_json=1`;

export function readRedditKey(file = redditFile()): RedditKey | undefined {
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    if (typeof v?.id === "string" && typeof v.secret === "string" && v.id && v.secret) return { id: v.id, secret: v.secret };
  } catch {}
  return undefined;
}

export function saveRedditKey(key: RedditKey, file = redditFile()) {
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(key), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

const KEY_USAGE = "usage: blimpd reddit-key <client id> <secret>";
const KEY_PART = /^[\w-]{6,64}$/;

// `blimpd reddit-key <client id> <secret>`; the running blimpd uses it from its next run. The secret is never printed.
export function runRedditKey(args: string[], dir = blimpDir()): number {
  const [id, secret] = args;
  if (args.length !== 2 || !KEY_PART.test(id) || !KEY_PART.test(secret)) {
    console.error(KEY_USAGE);
    return 1;
  }
  saveRedditKey({ id, secret }, redditFile(dir));
  console.log("Reddit key saved. The feed uses it from its next run.");
  return 0;
}

// The app-only token, kept until a minute before it runs out.
let token: { value: string; until: number; key: string } | undefined;
export const forgetRedditToken = () => void (token = undefined);

async function appToken(get: Get, key: RedditKey, now: number): Promise<string> {
  const k = `${key.id}:${key.secret}`;
  if (token?.key === k && now < token.until) return token.value;
  const r = await get(REDDIT_TOKEN, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(k).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (r.status === 401 || r.status === 403) throw new FeedError("key rejected");
  if (r.status < 200 || r.status >= 300) throw new FeedError(`answered ${r.status}`);
  let v: any;
  try {
    v = JSON.parse(r.text);
  } catch {}
  if (typeof v?.access_token !== "string") throw new FeedError("key rejected");
  const life = typeof v.expires_in === "number" ? v.expires_in : 3600;
  token = { value: v.access_token, until: now + Math.max(60, life - 60) * 1000, key: k };
  return token.value;
}

// A GET with the token. A 401 means the token was refused: it's dropped, and the key counts as rejected.
async function authed(get: Get, key: RedditKey, url: string, now: number): Promise<any> {
  const r = await get(url, { headers: { Authorization: `Bearer ${await appToken(get, key, now)}` } });
  if (r.status === 401) {
    forgetRedditToken();
    throw new FeedError("key rejected");
  }
  if (r.status < 200 || r.status >= 300) throw new FeedError(`answered ${r.status}`);
  try {
    return JSON.parse(r.text);
  } catch {
    throw new FeedError("couldn't read it");
  }
}

export function parseListing(json: any, sub: string): Found[] {
  const kids: any[] = Array.isArray(json?.data?.children) ? json.data.children : [];
  return kids
    .map((k) => k?.data)
    .filter((d) => d && typeof d.title === "string" && d.title.trim() && typeof d.permalink === "string" && d.permalink.startsWith("/r/") && !d.stickied && !d.over_18)
    .slice(0, 5)
    .map((d, i): Found => {
      const thread = `https://www.reddit.com${d.permalink}`;
      const url = typeof d.url_overridden_by_dest === "string" ? d.url_overridden_by_dest : d.is_self || typeof d.url !== "string" ? thread : d.url;
      const image = d.preview?.images?.[0]?.source?.url;
      return {
        kind: "reddit",
        source: `r/${sub}`,
        rank: i + 1,
        url: /^https?:\/\//i.test(url) ? url : thread,
        title: d.title.trim(),
        thread,
        ...(typeof d.score === "number" && { score: d.score }),
        ...(typeof d.num_comments === "number" && { comments: d.num_comments }),
        ...(typeof d.selftext === "string" && d.selftext.trim() && { text: d.selftext.trim() }),
        ...(typeof image === "string" && { image }),
        ref: d.permalink,
      };
    });
}

export function parseComments(json: any): string[] {
  const kids: any[] = Array.isArray(json?.[1]?.data?.children) ? json[1].data.children : [];
  return kids
    .filter((k) => k?.kind === "t1" && typeof k.data?.body === "string" && !k.data.stickied)
    .slice(0, 3)
    .map((k) => k.data.body.replace(/\s+/g, " ").trim());
}

export const readReddit = async (get: Get, key: RedditKey, sub: string, now: number) => parseListing(await authed(get, key, redditListing(sub), now), sub);
export const redditComments = async (get: Get, key: RedditKey, permalink: string, now: number) => parseComments(await authed(get, key, redditCommentsUrl(permalink), now));
