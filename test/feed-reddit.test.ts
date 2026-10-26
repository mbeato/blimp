// Reddit for the feed (src/feed/reddit.ts): a subreddit's rising posts, a post's top comments, the app-only token,
// and `blimpd reddit-key`.

import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  forgetRedditToken,
  parseComments,
  parseListing,
  readReddit,
  readRedditKey,
  REDDIT_TOKEN,
  redditComments,
  redditCommentsUrl,
  redditFile,
  redditListing,
  runRedditKey,
} from "../src/feed/reddit";
import { fakeGet } from "./feed-fake";

const json = JSON.stringify;
const key = { id: "client-id-1", secret: "secret-value-123456" };
const now = 1_800_000_000_000;
const listing = json({
  data: {
    children: [
      { kind: "t3", data: { title: "Weekly thread", permalink: "/r/programming/comments/s/weekly/", url: "https://www.reddit.com/r/programming/comments/s/weekly/", stickied: true } },
      {
        kind: "t3",
        data: {
          title: "Bun 2.0 is out",
          permalink: "/r/programming/comments/a/bun/",
          url: "https://bun.com/blog/bun-v2.0",
          score: 230,
          num_comments: 12,
          preview: { images: [{ source: { url: "https://preview.redd.it/x.png?a=1&b=2" } }] },
        },
      },
      {
        kind: "t3",
        data: { title: "Ask: tabs?", permalink: "/r/programming/comments/b/tabs/", url: "https://www.reddit.com/r/programming/comments/b/tabs/", is_self: true, selftext: "  Which one?  ", score: 3, num_comments: 40 },
      },
      { kind: "t3", data: { title: "nsfw", permalink: "/r/x/", url: "https://x", over_18: true } },
    ],
  },
});

test("parseListing: stickied and over-18 posts left out; a self post links to its thread", () => {
  expect(parseListing(JSON.parse(listing), "programming")).toEqual([
    {
      kind: "reddit",
      source: "r/programming",
      rank: 1,
      url: "https://bun.com/blog/bun-v2.0",
      title: "Bun 2.0 is out",
      thread: "https://www.reddit.com/r/programming/comments/a/bun/",
      score: 230,
      comments: 12,
      image: "https://preview.redd.it/x.png?a=1&b=2",
      ref: "/r/programming/comments/a/bun/",
    },
    {
      kind: "reddit",
      source: "r/programming",
      rank: 2,
      url: "https://www.reddit.com/r/programming/comments/b/tabs/",
      title: "Ask: tabs?",
      thread: "https://www.reddit.com/r/programming/comments/b/tabs/",
      score: 3,
      comments: 40,
      text: "Which one?",
      ref: "/r/programming/comments/b/tabs/",
    },
  ]);
});

test("parseComments: the first 3 comments, not a stickied one, spaces collapsed", () => {
  const c = (body: string, extra = {}) => ({ kind: "t1", data: { body, ...extra } });
  expect(parseComments([{}, { data: { children: [c("mod note", { stickied: true }), c("One\n\ntwo"), c("Three"), { kind: "more", data: {} }, c("Four"), c("Five")] } }])).toEqual([
    "One two",
    "Three",
    "Four",
  ]);
});

describe("readReddit", () => {
  beforeEach(forgetRedditToken);
  const token = { [REDDIT_TOKEN]: json({ access_token: "tok", expires_in: 3600 }) };

  test("one token for every request until a minute before it runs out", async () => {
    const { get, asked } = fakeGet({ ...token, [redditListing("programming")]: listing, [redditListing("ClaudeAI")]: json({ data: { children: [] } }) });
    expect((await readReddit(get, key, "programming", now)).length).toBe(2);
    expect(await readReddit(get, key, "ClaudeAI", now + 30 * 60_000)).toEqual([]);
    await readReddit(get, key, "ClaudeAI", now + 60 * 60_000);
    expect(asked).toEqual([`POST ${REDDIT_TOKEN}`, redditListing("programming"), redditListing("ClaudeAI"), `POST ${REDDIT_TOKEN}`, redditListing("ClaudeAI")]);
  });
  test('a refused key or token is "key rejected"; a subreddit that answers something else says what', async () => {
    await expect(readReddit(fakeGet({ [REDDIT_TOKEN]: 401 }).get, key, "programming", now)).rejects.toThrow("key rejected");
    await expect(readReddit(fakeGet({ ...token, [redditListing("programming")]: 401 }).get, key, "programming", now)).rejects.toThrow("key rejected");
    await expect(readReddit(fakeGet({ ...token, [redditListing("gone")]: 404 }).get, key, "gone", now)).rejects.toThrow("answered 404");
  });
  test("redditComments reads a post's top comments", async () => {
    const permalink = "/r/p/comments/a/bun/";
    const { get } = fakeGet({ ...token, [redditCommentsUrl(permalink)]: json([{}, { data: { children: [{ kind: "t1", data: { body: "Finally." } }] } }]) });
    expect(await redditComments(get, key, permalink, now)).toEqual(["Finally."]);
  });
});

describe("blimpd reddit-key", () => {
  test("saves the key, 600; the secret is never printed", () => {
    const dir = mkdtempSync(join(tmpdir(), "blimp-reddit-"));
    const out: string[] = [];
    const l = spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
    try {
      expect(runRedditKey([key.id, key.secret], dir)).toBe(0);
    } finally {
      l.mockRestore();
    }
    expect(readRedditKey(redditFile(dir))).toEqual(key);
    expect(statSync(redditFile(dir)).mode & 0o777).toBe(0o600);
    expect(out.join("\n")).not.toContain(key.secret);
  });
  test("anything else: the usage, exit 1, nothing saved", () => {
    const dir = mkdtempSync(join(tmpdir(), "blimp-reddit-"));
    const e = spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const args of [[], ["only-one-part"], ["a b c d e f", key.secret], [key.id, key.secret, "extra"]]) expect(runRedditKey(args, dir)).toBe(1);
    } finally {
      e.mockRestore();
    }
    expect(readRedditKey(redditFile(dir))).toBeUndefined();
  });
});
