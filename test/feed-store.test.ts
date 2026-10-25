// The feed's store (src/feed/store.ts): settings, feed.json, cleanup, order, what the phone gets, seen and saved.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { byOrder, type Card, cleanup, DEFAULT_RSS, DEFAULT_SUBREDDITS, feedMessage, type FeedFile, markFeedSeen, onFeedChange, readFeed, readFeedSettings, setFeedSaved, shownFeed, updateFeed } from "../src/feed/store";

const dir = mkdtempSync(join(tmpdir(), "blimp-feed-store-"));
let n = 0;
const fresh = () => join(dir, `feed-${n++}.json`);
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const now = 1_800_000_000_000;
const id = (c: string) => c.repeat(16);
const card = (cid: string, extra: Partial<Card> = {}): Card => ({
  id: cid,
  url: `https://example.com/${cid}`,
  title: `Card ${cid}`,
  sources: [{ kind: "hn", name: "Hacker News", score: 1 }],
  at: now,
  rank: 1,
  summary: "What it is.",
  tries: 0,
  ...extra,
});
const put = (file: string, cards: Card[], extra: Partial<FeedFile> = {}) =>
  writeFileSync(file, JSON.stringify({ cards: Object.fromEntries(cards.map((c) => [c.id, c])), seen: {}, saved: [], runs: {}, lastRun: now, calls: [], ...extra }));

describe("readFeedSettings", () => {
  const cfg = (v: unknown) => {
    const f = join(dir, `config-${n++}.json`);
    writeFileSync(f, JSON.stringify(v));
    return f;
  };
  test("off unless on is true; missing lists get the defaults", () => {
    expect(readFeedSettings(join(dir, "none.json"))).toEqual({ on: false, subreddits: DEFAULT_SUBREDDITS, rss: DEFAULT_RSS, interests: [] });
    expect(readFeedSettings(cfg({ feed: { on: "yes" } })).on).toBe(false);
    expect(readFeedSettings(cfg({ names: false, feed: { on: true } })).on).toBe(true);
  });
  test("lists keep what fits: subreddit names (r/ dropped), http(s) feeds, at most 20 interests of up to 60 characters", () => {
    const s = readFeedSettings(
      cfg({
        feed: {
          on: true,
          subreddits: ["programming", "r/LocalLLaMA", "bad name", 3],
          rss: ["https://a.dev/feed.xml", "ftp://x", "javascript:alert(1)"],
          interests: ["Bun", "", "x".repeat(61), ...Array.from({ length: 30 }, (_, i) => `i${i}`)],
        },
      }),
    );
    expect(s.subreddits).toEqual(["programming", "LocalLLaMA"]);
    expect(s.rss).toEqual(["https://a.dev/feed.xml"]);
    expect(s.interests.length).toBe(20);
    expect(s.interests[0]).toBe("Bun");
    expect(readFeedSettings(cfg({ feed: { on: true, subreddits: [] } })).subreddits).toEqual([]);
  });
});

describe("readFeed and updateFeed", () => {
  test("missing or broken: empty", () => {
    expect(readFeed(join(dir, "missing.json"))).toEqual({ cards: {}, seen: {}, saved: [], runs: {}, lastRun: 0, calls: [] });
    const f = fresh();
    writeFileSync(f, "{not json");
    expect(readFeed(f).cards).toEqual({});
  });
  test("a card without a link, title, sources or time is left out, and a saved id with no card", () => {
    const f = fresh();
    writeFileSync(
      f,
      JSON.stringify({
        cards: { [id("a")]: card(id("a")), [id("b")]: { title: "no link", sources: [], at: now } },
        saved: [id("a"), id("c")],
        seen: { [id("a")]: now, x: "no" },
        lastRun: now,
      }),
    );
    const r = readFeed(f);
    expect(Object.keys(r.cards)).toEqual([id("a")]);
    expect(r.saved).toEqual([id("a")]);
    expect(r.seen).toEqual({ [id("a")]: now });
  });
  test("a change is written whole, 600, and gives what the change returned", () => {
    const f = fresh();
    expect(updateFeed((g) => ((g.lastRun = 5), "done"), f)).toBe("done");
    expect(readFeed(f).lastRun).toBe(5);
    expect(statSync(f).mode & 0o777).toBe(0o600);
  });
});

test("cleanup: cards go 3 days after they were found unless saved; seen marks after 7 days", () => {
  const f: FeedFile = {
    cards: { [id("a")]: card(id("a"), { at: now - 3 * DAY - 1 }), [id("b")]: card(id("b"), { at: now - 3 * DAY - 1 }), [id("c")]: card(id("c"), { at: now - DAY }) },
    seen: { [id("x")]: now - 7 * DAY - 1, [id("y")]: now - DAY },
    saved: [id("b")],
    runs: {},
    lastRun: now,
    calls: [],
  };
  cleanup(f, now);
  expect(Object.keys(f.cards).sort()).toEqual([id("b"), id("c")]);
  expect(Object.keys(f.seen)).toEqual([id("y")]);
});

test("byOrder: interest first, then the newest run, then each source's place, the sources taking turns (HN, GitHub, Reddit, release notes)", () => {
  const src = (kind: Card["sources"][0]["kind"]) => [{ kind, name: kind }];
  const cards = [
    card(id("1"), { at: now - HOUR, rank: 1 }),
    card(id("2"), { at: now, rank: 2, sources: src("hn") }),
    card(id("3"), { at: now, rank: 1, sources: src("reddit") }),
    card(id("4"), { at: now, rank: 1, sources: src("github") }),
    card(id("5"), { at: now - 2 * HOUR, interest: true }),
    card(id("6"), { at: now, rank: 1, sources: src("hn") }),
    card(id("7"), { at: now, rank: 1, sources: src("rss") }),
  ];
  expect(cards.sort(byOrder).map((c) => c.id[0])).toEqual(["5", "6", "4", "3", "7", "2", "1"]);
});

describe("shownFeed", () => {
  test("off: nothing", () => {
    const f = fresh();
    put(f, [card(id("a"))]);
    expect(shownFeed(false, f)).toEqual({ on: false, cards: [], saved: [], runs: {}, next: 0 });
  });
  test("the unseen cards that are ready, in order, without what only blimpd needs; saved ones newest first; the next run an hour after the last", () => {
    const f = fresh();
    put(
      f,
      [
        card(id("a"), { rank: 2, input: "for the model", triedAt: 1 }),
        card(id("b"), { rank: 1 }),
        card(id("c"), { summary: undefined, tries: 1 }), // waiting for its summary
        card(id("d"), { summary: undefined, tries: 2, rank: 3 }), // two failed tries: title only
        card(id("e")), // seen
      ],
      { seen: { [id("e")]: now }, saved: [id("e"), id("a")], runs: { "Hacker News": { at: now, ok: true } } },
    );
    const s = shownFeed(true, f);
    expect(s.cards.map((c) => c.id)).toEqual([id("b"), id("a"), id("d")]);
    expect(s.cards[1]).toEqual({
      id: id("a"),
      url: `https://example.com/${id("a")}`,
      title: `Card ${id("a")}`,
      sources: [{ kind: "hn", name: "Hacker News", score: 1 }],
      at: now,
      summary: "What it is.",
      interest: false,
    });
    expect(s.cards[2].summary).toBeUndefined();
    expect(s.saved.map((c) => c.id)).toEqual([id("a"), id("e")]);
    expect(s.runs).toEqual({ "Hacker News": { at: now, ok: true } });
    expect(s.next).toBe(now + HOUR);
  });
});

describe("seen, saved and the events' message", () => {
  test("seen cards stop showing and the count drops; a listener hears of it; an unknown id is ignored", () => {
    const f = fresh();
    put(f, [card(id("a")), card(id("b"))]);
    let heard = 0;
    onFeedChange(() => heard++);
    expect(JSON.parse(feedMessage(true, f))).toEqual({ type: "feed", on: true, unseen: 2 });
    markFeedSeen([id("a"), id("z")], now, f);
    expect(heard).toBe(1);
    expect(shownFeed(true, f).cards.map((c) => c.id)).toEqual([id("b")]);
    expect(Object.keys(readFeed(f).seen)).toEqual([id("a")]);
    expect(JSON.parse(feedMessage(true, f))).toEqual({ type: "feed", on: true, unseen: 1 });
    expect(JSON.parse(feedMessage(false, f))).toEqual({ type: "feed", on: false, unseen: 0 });
  });
  test("saving puts a card last in saved (the newest); unsaving takes it out; an unknown card is false", () => {
    const f = fresh();
    put(f, [card(id("a")), card(id("b"))]);
    expect(setFeedSaved(id("a"), true, f)).toBe(true);
    expect(setFeedSaved(id("b"), true, f)).toBe(true);
    expect(setFeedSaved(id("a"), true, f)).toBe(true);
    expect(readFeed(f).saved).toEqual([id("b"), id("a")]);
    expect(setFeedSaved(id("b"), false, f)).toBe(true);
    expect(readFeed(f).saved).toEqual([id("a")]);
    expect(setFeedSaved(id("z"), true, f)).toBe(false);
  });
});
