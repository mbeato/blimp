// The feed's job (src/feed/job.ts), against a stand-in internet (feed-fake.ts) and a stand-in model: a run's cards,
// summaries, the caps, and the hourly tick.

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TRENDING } from "../src/feed/github";
import { HN_FRONT, hnItem } from "../src/feed/hn";
import { type FeedDeps, feedTick, fetchRun, summarizeOnce } from "../src/feed/job";
import { forgetRedditToken, REDDIT_TOKEN, redditCommentsUrl, redditListing } from "../src/feed/reddit";
import { type Card, type FeedSettings, readFeed, shownFeed, updateFeed } from "../src/feed/store";
import { cardId } from "../src/feed/text";
import { fakeGet } from "./feed-fake";

const dir = mkdtempSync(join(tmpdir(), "blimp-feed-job-"));
let n = 0;
const MIN = 60_000;
const HOUR = 60 * MIN;
const start = 1_800_000_000_000;
const json = JSON.stringify;
const key = { id: "client-id-1", secret: "secret-value-123456" };
const settings = (extra: Partial<FeedSettings> = {}): FeedSettings => ({ on: true, subreddits: ["programming"], rss: ["https://a.dev/feed.xml"], interests: [], ...extra });

function deps(pages: Parameters<typeof fakeGet>[0], extra: Partial<FeedDeps> = {}, answer: (prompt: string) => string | undefined = () => undefined) {
  const { get, asked } = fakeGet(pages);
  const prompts: string[] = [];
  const d: FeedDeps = {
    get,
    ask: async (p) => (prompts.push(p), answer(p)),
    settings: () => settings(),
    redditKey: () => key,
    file: join(dir, `feed-${n++}.json`),
    now: () => start,
    ...extra,
  };
  return { d, asked, prompts };
}

const BUN = "https://bun.com/blog/bun-v2.0?utm_source=hn";
const PERMALINK = "/r/programming/comments/abc/bun_20/";
const pages = {
  [HN_FRONT]: json({
    hits: [
      { objectID: "1", title: "Bun 2.0", url: BUN, points: 412, num_comments: 318 },
      { objectID: "2", title: "Ask HN: Tabs or spaces?", url: null, points: 5, num_comments: 1, story_text: "Question?" },
    ],
  }),
  [hnItem("1")]: json({ children: [{ text: "Fast!" }] }),
  [hnItem("2")]: json({ children: [] }),
  [BUN]: `<meta property="og:image" content="https://bun.com/og.png"><p>Bun 2.0 is here.</p>`,
  [REDDIT_TOKEN]: json({ access_token: "tok", expires_in: 3600 }),
  [redditListing("programming")]: json({ data: { children: [{ kind: "t3", data: { title: "Bun 2.0 is out", url: "https://www.bun.com/blog/bun-v2.0", permalink: PERMALINK, score: 230, num_comments: 12 } }] } }),
  [redditCommentsUrl(PERMALINK)]: json([{}, { data: { children: [{ kind: "t1", data: { body: "Finally." } }] } }]),
  [TRENDING]: 503,
  "https://a.dev/feed.xml": `<rss><channel><title>A Dev</title><item><title>A post</title><link>https://a.dev/post</link><pubDate>${new Date(start - HOUR).toUTCString()}</pubDate><description>About it.</description></item></channel></rss>`,
};

beforeEach(forgetRedditToken);

describe("fetchRun", () => {
  test("every source; one card per link with both sources; what the model reads; a failed source is recorded and the rest still load", async () => {
    const { d, asked } = deps(pages);
    await fetchRun(d, settings(), start);
    const f = readFeed(d.file);
    expect(Object.keys(f.cards).length).toBe(3);
    const bun = f.cards[cardId(BUN)];
    expect(bun.sources).toEqual([
      { kind: "hn", name: "Hacker News", score: 412, comments: 318, thread: "https://news.ycombinator.com/item?id=1" },
      { kind: "reddit", name: "r/programming", score: 230, comments: 12, thread: "https://www.reddit.com" + PERMALINK },
    ]);
    expect(bun).toMatchObject({ url: BUN, title: "Bun 2.0", at: start, rank: 1, image: "https://bun.com/og.png", tries: 0 });
    expect(bun.summary).toBeUndefined();
    expect(bun.input).toContain("Comment 1: Fast!");
    expect(bun.input).toContain("Comment 2: Finally.");
    expect(bun.input).toContain("Page: Bun 2.0 is here.");
    expect(f.cards[cardId("https://news.ycombinator.com/item?id=2")].input).toContain("Post: Question?");
    expect(asked).not.toContain("https://news.ycombinator.com/item?id=2"); // its link is its thread: no page to read
    expect(f.cards[cardId("https://a.dev/post")]).toMatchObject({ title: "A post", sources: [{ kind: "rss", name: "A Dev" }] });
    expect(f.runs).toEqual({
      "Hacker News": { at: start, ok: true },
      "r/programming": { at: start, ok: true },
      "GitHub trending": { at: start, ok: false, reason: "answered 503" },
      "a.dev": { at: start, ok: true },
    });
  });
  test("without a Reddit key the subreddits are skipped and Reddit says no key", async () => {
    const { d, asked } = deps(pages, { redditKey: () => undefined });
    await fetchRun(d, settings(), start);
    const f = readFeed(d.file);
    expect(f.runs.Reddit).toEqual({ at: start, ok: false, reason: "no key" });
    expect(f.runs["r/programming"]).toBeUndefined();
    expect(asked.some((u) => u.includes("reddit"))).toBe(false);
    expect(f.cards[cardId(BUN)].sources.map((s) => s.name)).toEqual(["Hacker News"]);
  });
  test("a card found again keeps its summary and seen mark, gets the new scores, and isn't read again", async () => {
    const { d } = deps(pages);
    await fetchRun(d, settings(), start);
    const id = cardId(BUN);
    updateFeed((f) => {
      f.cards[id].summary = "Kept.";
      f.seen[id] = start;
    }, d.file);
    const again = fakeGet({ ...pages, [HN_FRONT]: json({ hits: [{ objectID: "1", title: "Bun 2.0", url: BUN, points: 999, num_comments: 400 }] }) });
    await fetchRun({ ...d, get: again.get }, settings(), start + HOUR);
    const f = readFeed(d.file);
    expect(f.cards[id]).toMatchObject({ summary: "Kept.", at: start });
    expect(f.cards[id].sources[0]).toMatchObject({ score: 999, comments: 400 });
    expect(f.seen[id]).toBe(start);
    expect(again.asked).not.toContain(hnItem("1"));
    expect(again.asked).not.toContain(BUN);
  });
});

describe("summarizeOnce", () => {
  // nCards cards waiting for a summary, card 0 the newest, each a minute older than the one before.
  const url = (i: number) => `https://e.com/${i}`;
  function waiting(nCards: number, extra: Partial<FeedDeps> = {}, answer?: (prompt: string) => string | undefined) {
    const made = deps({}, extra, answer);
    updateFeed((f) => {
      for (let i = 0; i < nCards; i++) {
        const c: Card = { id: cardId(url(i)), url: url(i), title: `Post ${i}`, sources: [{ kind: "hn", name: "Hacker News" }], at: start - i * MIN, rank: 1, tries: 0, input: `Title: Post ${i}` };
        f.cards[c.id] = c;
      }
    }, made.d.file);
    return made;
  }
  const at = (file: string, i: number) => readFeed(file).cards[cardId(url(i))];

  test("the 10 newest waiting go in one call; each answer is kept (interest only with an interests list); a missing one is a failed try", async () => {
    const answer = json(Array.from({ length: 10 }, (_, i) => ({ n: i + 1, summary: `About post ${i}.`, interest: i === 0 })).filter((a) => a.n !== 3));
    const { d, prompts } = waiting(12, { settings: () => settings({ interests: ["Bun"] }) }, () => answer);
    await summarizeOnce(d, d.settings());
    expect(prompts.length).toBe(1);
    expect(prompts[0]).toContain("Title: Post 9\n");
    expect(prompts[0]).not.toContain("Title: Post 10\n");
    expect(at(d.file, 0)).toMatchObject({ summary: "About post 0.", interest: true });
    expect(at(d.file, 0).input).toBeUndefined();
    expect(at(d.file, 1)).toMatchObject({ summary: "About post 1.", interest: false });
    expect(at(d.file, 2)).toMatchObject({ tries: 1, triedAt: start });
    expect(at(d.file, 2).summary).toBeUndefined();
    expect(at(d.file, 10).tries).toBe(0);
    expect(readFeed(d.file).calls).toEqual([start]);
  });
  test("without an interests list nothing is an interest match", async () => {
    const { d } = waiting(1, {}, () => json([{ n: 1, summary: "About it.", interest: true }]));
    await summarizeOnce(d, d.settings());
    expect(at(d.file, 0)).toMatchObject({ summary: "About it.", interest: false });
  });
  test("a failed try waits an hour; after two the card shows with its title only and isn't tried again", async () => {
    let now = start;
    const { d, prompts } = waiting(1, { now: () => now });
    await summarizeOnce(d, d.settings());
    await summarizeOnce(d, d.settings());
    expect(prompts.length).toBe(1);
    now += HOUR;
    await summarizeOnce(d, d.settings());
    expect(at(d.file, 0).tries).toBe(2);
    expect(shownFeed(true, d.file).cards.map((c) => c.title)).toEqual(["Post 0"]);
    now += HOUR;
    await summarizeOnce(d, d.settings());
    expect(prompts.length).toBe(2);
  });
  test("at most 6 calls an hour", async () => {
    let now = start;
    const { d, prompts } = waiting(80, { now: () => now });
    for (let i = 0; i < 8; i++) {
      await summarizeOnce(d, d.settings());
      now += MIN;
    }
    expect(prompts.length).toBe(6);
    now = start + HOUR;
    await summarizeOnce(d, d.settings());
    expect(prompts.length).toBe(7);
  });
  test("a seen card isn't summarized", async () => {
    const { d, prompts } = waiting(1);
    updateFeed((f) => void (f.seen[cardId(url(0))] = start), d.file);
    await summarizeOnce(d, d.settings());
    expect(prompts.length).toBe(0);
  });
});

describe("feedTick", () => {
  test("off: nothing fetched; on: a run, then none until an hour after it started, even after a restart", async () => {
    let now = start;
    let on = false;
    const { d, asked } = deps(pages, { now: () => now, settings: () => settings({ on }) });
    const fronts = () => asked.filter((u) => u === HN_FRONT).length;
    await feedTick(d);
    expect(asked).toEqual([]);
    on = true;
    await feedTick(d);
    expect(fronts()).toBe(1);
    expect(readFeed(d.file).lastRun).toBe(start);
    now += 59 * MIN; // as after a restart: lastRun is in the file
    await feedTick(d);
    expect(fronts()).toBe(1);
    now += MIN;
    await feedTick(d);
    expect(fronts()).toBe(2);
  });
});
