// The feed's job (docs/DESIGN.md, "Feed"). Every minute it reads config.json. While the feed is on and an hour has
// passed since the last run started, it runs: every source, one request at a time, merged into one card per link,
// then each new card's comments, page or README for the model. Then one call to the small model a minute, at most 6
// an hour, summarizes the 10 newest cards waiting. Its errors are caught, so it can't take blimpd down.

import { askClaude } from "../names";
import { readGithub, readReadme } from "./github";
import { hnComments, readHn } from "./hn";
import { type Get, liveGet, whyFailed } from "./net";
import { type Page, readPage } from "./page";
import { readReddit, readRedditKey, redditComments, type RedditKey } from "./reddit";
import { readRss } from "./rss";
import { type Card, type CardSource, cleanup, feedChanged, feedFile, type FeedSettings, type Found, readFeed, readFeedSettings, type Run, updateFeed } from "./store";
import { cardInput, checkSummaries, feedPrompt } from "./summary";
import { cardId } from "./text";

const MIN = 60_000;
const HOUR = 60 * MIN;
const BATCH = 10;
const CALLS = 6;
const TRIES = 2;

export type FeedDeps = {
  get: Get;
  ask: (prompt: string) => Promise<string | undefined>;
  settings: () => FeedSettings;
  redditKey: () => RedditKey | undefined;
  file: string;
  now: () => number;
};
const live: FeedDeps = {
  get: liveGet,
  ask: (p) => askClaude(p, 120_000),
  settings: () => readFeedSettings(),
  redditKey: () => readRedditKey(),
  get file() {
    return feedFile();
  },
  now: () => Date.now(),
};

const host = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

// In this order: HN, each subreddit (with a key), GitHub, each blog (named by its address's host in runs).
function sources(d: FeedDeps, s: FeedSettings, key: RedditKey | undefined, now: number): { name: string; read: () => Promise<Found[]> }[] {
  const list = [{ name: "Hacker News", read: () => readHn(d.get) }];
  if (key) for (const sub of s.subreddits) list.push({ name: `r/${sub}`, read: () => readReddit(d.get, key, sub, now) });
  list.push({ name: "GitHub trending", read: () => readGithub(d.get) });
  for (const url of s.rss) list.push({ name: host(url), read: () => readRss(d.get, url, now) });
  return list;
}

const sourceOf = (f: Found): CardSource => ({
  kind: f.kind,
  name: f.source,
  ...(f.score !== undefined && { score: f.score }),
  ...(f.comments !== undefined && { comments: f.comments }),
  ...(f.thread && { thread: f.thread }),
});

// A source's entry on a card: replaced by name (its new scores), or added.
function upsert(list: CardSource[], s: CardSource) {
  const i = list.findIndex((x) => x.name === s.name);
  if (i >= 0) list[i] = s;
  else list.push(s);
}

// The comments, linked page or README a new card's input adds. Whatever fails is left out.
async function readMore(d: FeedDeps, key: RedditKey | undefined, c: Card, finds: Found[], now: number) {
  const comments: string[] = [];
  let readme: string | undefined;
  for (const f of finds)
    try {
      if (f.kind === "hn" && f.ref) comments.push(...(await hnComments(d.get, f.ref)));
      else if (f.kind === "reddit" && f.ref && key) comments.push(...(await redditComments(d.get, key, f.ref, now)));
      else if (f.kind === "github" && f.ref) readme = await readReadme(d.get, f.ref);
    } catch {}
  // A thread or a repo is its own page: there's nothing more to read there.
  let page: Page | undefined;
  if (!finds.some((f) => f.kind === "github" || f.thread === c.url))
    try {
      page = await readPage(d.get, c.url);
    } catch {}
  if (page?.image && !c.image) c.image = page.image;
  return { text: finds.map((f) => f.text).find((t) => t), page, readme, comments };
}

// One run. What it found is merged into feed.json at the end, in one change, with this run's result per source.
export async function fetchRun(d: FeedDeps, s: FeedSettings, start: number): Promise<void> {
  const key = d.redditKey();
  const runs: Record<string, Run> = {};
  if (!key && s.subreddits.length) runs.Reddit = { at: start, ok: false, reason: "no key" };
  const found: Found[] = [];
  for (const src of sources(d, s, key, start))
    try {
      found.push(...(await src.read()));
      runs[src.name] = { at: start, ok: true };
    } catch (e) {
      runs[src.name] = { at: start, ok: false, reason: whyFailed(e) };
    }

  // One card per link: a link already kept only gets its new scores; a new one is read further for the model.
  const known = readFeed(d.file).cards;
  const rescored = new Map<string, CardSource[]>();
  const fresh = new Map<string, { card: Card; finds: Found[] }>();
  for (const f of found) {
    const id = cardId(f.url);
    if (known[id]) {
      const list = rescored.get(id) ?? [...known[id].sources];
      upsert(list, sourceOf(f));
      rescored.set(id, list);
      continue;
    }
    const had = fresh.get(id);
    if (had) {
      upsert(had.card.sources, sourceOf(f));
      had.card.rank = Math.min(had.card.rank, f.rank);
      if (!had.card.image && f.image) had.card.image = f.image;
      had.finds.push(f);
    } else
      fresh.set(id, {
        card: { id, url: f.url, title: f.title, sources: [sourceOf(f)], at: start, rank: f.rank, ...(f.image && { image: f.image }), tries: 0 },
        finds: [f],
      });
  }
  for (const { card, finds } of fresh.values()) card.input = cardInput(card, await readMore(d, key, card, finds, start));

  updateFeed((g) => {
    for (const [id, list] of rescored) if (g.cards[id]) g.cards[id].sources = list;
    for (const [id, { card }] of fresh) if (!g.cards[id]) g.cards[id] = card;
    g.runs = runs;
    cleanup(g, d.now());
  }, d.file);
}

// One call for the 10 newest cards waiting (no summary yet, fewer than 2 failed tries, the last an hour ago or more,
// not seen), unless 6 calls were made in the last hour.
export async function summarizeOnce(d: FeedDeps, s: FeedSettings): Promise<void> {
  const t = d.now();
  const f = readFeed(d.file);
  const calls = f.calls.filter((c) => t - c < HOUR);
  if (calls.length >= CALLS) return;
  const waiting = Object.values(f.cards)
    .filter((c) => c.summary === undefined && c.tries < TRIES && !(c.id in f.seen) && (c.triedAt === undefined || t - c.triedAt >= HOUR))
    .sort((a, b) => b.at - a.at || a.rank - b.rank || a.id.localeCompare(b.id))
    .slice(0, BATCH);
  if (!waiting.length) return;
  updateFeed((g) => void (g.calls = [...calls, t]), d.file);
  const prompt = feedPrompt(
    waiting.map((c, i) => ({ n: i + 1, input: c.input ?? cardInput(c, { comments: [] }) })),
    s.interests,
  );
  const got = checkSummaries((await d.ask(prompt)) ?? "", waiting.length);
  updateFeed((g) => {
    waiting.forEach((w, i) => {
      const c = g.cards[w.id];
      if (!c) return;
      const r = got.get(i + 1);
      if (r) {
        c.summary = r.summary;
        c.interest = s.interests.length > 0 && r.interest;
        delete c.input;
        delete c.triedAt;
      } else {
        c.tries += 1;
        c.triedAt = t;
      }
    });
  }, d.file);
}

let busy = false;
let wasOn: boolean | undefined;

export async function feedTick(d: FeedDeps = live): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const s = d.settings();
    if (s.on !== wasOn) {
      wasOn = s.on;
      feedChanged();
    }
    if (!s.on) return;
    const t = d.now();
    if (t - readFeed(d.file).lastRun >= HOUR) {
      // Saved first, so a restart part way through doesn't fetch again.
      updateFeed((f) => void (f.lastRun = t), d.file);
      await fetchRun(d, s, t);
      feedChanged();
    }
    await summarizeOnce(d, s);
    feedChanged();
  } catch {
  } finally {
    busy = false;
  }
}

// Once now (a run if the last started an hour ago or more), then every minute.
export function startFeed(every = MIN) {
  void feedTick();
  setInterval(() => void feedTick(), every);
}
