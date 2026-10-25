// The feed's readers (src/feed/): Hacker News, release notes and blogs (RSS and Atom), and linked pages. Exact
// cases inline; saved copies of real answers (test/fixtures/feed/) for the shapes the real ones have.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HN_FRONT, hnComments, hnItem, parseFront, parseItem, readHn } from "../src/feed/hn";
import { parsePage, readPage } from "../src/feed/page";
import { parseFeed, readRss } from "../src/feed/rss";
import { fakeGet } from "./feed-fake";

const fixtures = join(import.meta.dir, "fixtures", "feed");
const fixture = (f: string) => readFileSync(join(fixtures, f), "utf8");

describe("Hacker News", () => {
  test("parseFront: each story with its points, comments and thread; a text post links to its thread; no title, no card", () => {
    const front = {
      hits: [
        { objectID: "101", title: "Bun 2.0", url: "https://bun.com/blog/bun-v2.0", points: 412, num_comments: 318 },
        { objectID: "102", title: "Ask HN: What are you building?", url: null, points: 50, num_comments: 80, story_text: "<p>Tell us &amp; share</p>" },
        { objectID: "103", title: "  ", url: "https://x.dev" },
      ],
    };
    expect(parseFront(front)).toEqual([
      { kind: "hn", source: "Hacker News", rank: 1, url: "https://bun.com/blog/bun-v2.0", title: "Bun 2.0", score: 412, comments: 318, thread: "https://news.ycombinator.com/item?id=101", ref: "101" },
      {
        kind: "hn",
        source: "Hacker News",
        rank: 2,
        url: "https://news.ycombinator.com/item?id=102",
        title: "Ask HN: What are you building?",
        score: 50,
        comments: 80,
        thread: "https://news.ycombinator.com/item?id=102",
        text: "Tell us & share",
        ref: "102",
      },
    ]);
  });
  test("parseItem: the first 3 comments with text, as plain text", () => {
    expect(parseItem({ children: [{ text: "<p>First &amp; best</p>" }, { text: null }, { text: "Second" }, { text: "Third" }, { text: "Fourth" }] })).toEqual([
      "First & best",
      "Second",
      "Third",
    ]);
  });
  test("the real front page: at least 20 stories, numbered from 1, each with a title, a web link and a thread", () => {
    const stories = parseFront(JSON.parse(fixture("hn-front.json")));
    expect(stories.length).toBeGreaterThanOrEqual(20);
    stories.forEach((s, i) => {
      expect(s.rank).toBe(i + 1);
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.url).toMatch(/^https?:\/\//);
      expect(s.thread).toMatch(/^https:\/\/news\.ycombinator\.com\/item\?id=\d+$/);
    });
  });
  test("readHn and hnComments ask Algolia", async () => {
    const { get, asked } = fakeGet({ [HN_FRONT]: JSON.stringify({ hits: [] }), [hnItem("7")]: JSON.stringify({ children: [{ text: "Yes" }] }) });
    expect(await readHn(get)).toEqual([]);
    expect(await hnComments(get, "7")).toEqual(["Yes"]);
    expect(asked).toEqual([HN_FRONT, "https://hn.algolia.com/api/v1/items/7"]);
  });
});

describe("release notes and blogs", () => {
  const since = Date.parse("Sat, 24 Oct 2026 00:00:00 GMT");
  test("RSS: posts since the cut-off with a web link; escaped HTML and CDATA become text; the feed's title is the source", () => {
    const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>Bun Blog</title><link>https://bun.com</link>
<item><title>Bun v2.0</title><link>https://bun.com/blog/bun-v2.0</link><pubDate>Mon, 26 Oct 2026 10:00:00 GMT</pubDate>
<description>&lt;p&gt;Big &amp;amp; fast.&lt;/p&gt;</description></item>
<item><title><![CDATA[Old & gone]]></title><link>https://bun.com/blog/old</link><pubDate>Mon, 19 Oct 2026 10:00:00 GMT</pubDate></item>
<item><title>No date</title><link>https://bun.com/blog/nodate</link></item>
<item><title>Bad link</title><link>javascript:alert(1)</link><pubDate>Mon, 26 Oct 2026 09:00:00 GMT</pubDate></item>
</channel></rss>`;
    expect(parseFeed(rss, "https://bun.com/rss.xml", since)).toEqual([
      { kind: "rss", source: "Bun Blog", rank: 1, url: "https://bun.com/blog/bun-v2.0", title: "Bun v2.0", text: "Big & fast." },
    ]);
  });
  test("Atom: the alternate link (its &amp; decoded), published or else updated, content or else summary", () => {
    const atom = `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title type="text">Swift.org</title>
<link href="https://www.swift.org/" rel="alternate"/><updated>2026-10-26T00:00:00Z</updated>
<entry><title>Swift 6.3 Released</title><link rel="alternate" type="text/html" href="https://www.swift.org/blog/swift-6.3-released/?a=1&amp;b=2"/>
<published>2026-10-25T12:00:00Z</published><updated>2026-10-25T13:00:00Z</updated><content type="html">&lt;p&gt;Swift 6.3 is out.&lt;/p&gt;</content></entry>
<entry><title>Only updated</title><link href="https://www.swift.org/blog/x/"/><updated>2026-10-25T00:00:00Z</updated><summary>Short.</summary></entry>
</feed>`;
    expect(parseFeed(atom, "https://www.swift.org/atom.xml", since)).toEqual([
      { kind: "rss", source: "Swift.org", rank: 1, url: "https://www.swift.org/blog/swift-6.3-released/?a=1&b=2", title: "Swift 6.3 Released", text: "Swift 6.3 is out." },
      { kind: "rss", source: "Swift.org", rank: 2, url: "https://www.swift.org/blog/x/", title: "Only updated", text: "Short." },
    ]);
  });
  test("no title: the address's host is the source; not a feed at all: a FeedError", () => {
    const bare = `<rss><channel><item><title>T</title><link>https://a.dev/x</link><pubDate>Mon, 26 Oct 2026 10:00:00 GMT</pubDate></item></channel></rss>`;
    expect(parseFeed(bare, "https://a.dev/feed.xml", 0)[0].source).toBe("a.dev");
    expect(() => parseFeed("<html><title>x</title></html>", "https://a.dev/", 0)).toThrow("not a feed");
  });
  test("real feeds: Apple's developer news (RSS) and Swift.org (Atom), every post with a title, a web link and a source", () => {
    for (const [file, url] of [
      ["apple-news.rss", "https://developer.apple.com/news/rss/news.rss"],
      ["swift.atom", "https://www.swift.org/atom.xml"],
    ]) {
      const posts = parseFeed(fixture(file), url, 0);
      expect(posts.length).toBeGreaterThan(3);
      for (const p of posts) {
        expect(p.title.length).toBeGreaterThan(0);
        expect(p.url).toMatch(/^https?:\/\//);
        expect(p.source.length).toBeGreaterThan(0);
      }
    }
  });
  test("readRss keeps the last 3 days", async () => {
    const now = Date.parse("Mon, 26 Oct 2026 12:00:00 GMT");
    const xml = `<rss><channel><title>A</title>
<item><title>New</title><link>https://a.dev/new</link><pubDate>Mon, 26 Oct 2026 10:00:00 GMT</pubDate></item>
<item><title>Old</title><link>https://a.dev/old</link><pubDate>Thu, 22 Oct 2026 10:00:00 GMT</pubDate></item></channel></rss>`;
    const { get } = fakeGet({ "https://a.dev/feed.xml": xml });
    expect((await readRss(get, "https://a.dev/feed.xml", now)).map((p) => p.title)).toEqual(["New"]);
  });
});

describe("linked pages", () => {
  test("parsePage: description, picture (made absolute) and the first paragraphs; not the script", async () => {
    const html = `<html><head><meta name="description" content="A &amp; B"><meta property="og:image" content="/img/card.png"></head>
<body><script>var x = "<p>not this</p>"</script><p>First &amp; para.</p><div>skip</div><p>Second <b>bold</b>.</p></body></html>`;
    expect(await parsePage(html, "https://example.com/post")).toEqual({ description: "A & B", image: "https://example.com/img/card.png", text: "First & para. Second bold." });
  });
  test("parsePage: at most 1,500 characters of text", async () => {
    expect((await parsePage(`<p>${"word ".repeat(1000)}</p>`, "https://e.com")).text.length).toBeLessThanOrEqual(1501);
  });
  test("readPage: only an HTML page that answered 2xx", async () => {
    const { get } = fakeGet({
      "https://e.com/a": "<p>Hi</p>",
      "https://e.com/pdf": { status: 200, text: "%PDF", type: "application/pdf" },
      "https://e.com/gone": 404,
    });
    expect((await readPage(get, "https://e.com/a"))?.text).toBe("Hi");
    expect(await readPage(get, "https://e.com/pdf")).toBeUndefined();
    expect(await readPage(get, "https://e.com/gone")).toBeUndefined();
  });
});
