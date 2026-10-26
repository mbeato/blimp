// The feed's text helpers (src/feed/text.ts) and its requests (src/feed/net.ts), against a local server.

import { afterAll, describe, expect, test } from "bun:test";
import { FeedError, getJson, getText, liveGet, USER_AGENT, whyFailed } from "../src/feed/net";
import { cardId, decode, normalLink, plain } from "../src/feed/text";

describe("decode", () => {
  test("named and numeric entities; anything else stays", () => {
    expect(decode("a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos; &#8217;&#x2019;")).toBe(`a & b <c> "d" 'e' ’’`);
    expect(decode("x&nbsp;y")).toBe("x y");
    expect(decode("&bogus; &#0; &")).toBe("&bogus; &#0; &");
  });
});

test("plain: tags go, entities are decoded, spaces collapse; CDATA's inside stays; scripts and styles go", () => {
  expect(plain("<p>Hello <b>world</b></p><p>Two&amp;three</p>")).toBe("Hello world Two&three");
  expect(plain("<![CDATA[<p>In CDATA</p>]]>")).toBe("In CDATA");
  expect(plain("a<script>bad()</script>b<style>.x{}</style>c")).toBe("a b c");
  expect(plain("&lt;not a tag&gt;")).toBe("<not a tag>");
});

describe("normalLink", () => {
  test("the same link from two sources matches", () => {
    for (const same of [
      "http://example.com/post",
      "https://www.example.com/post",
      "https://Example.com/post/",
      "https://example.com/post#comments",
      "https://example.com/post?utm_source=hn&utm_medium=x",
      "https://example.com/post?ref=producthunt&fbclid=1",
      "https://example.com:443/post",
    ])
      expect(normalLink(same)).toBe("https://example.com/post");
  });
  test("different links don't; parameters that matter stay, sorted", () => {
    expect(normalLink("https://example.com/post?id=2")).not.toBe(normalLink("https://example.com/post?id=3"));
    expect(normalLink("https://example.com/p?b=2&a=1&utm_x=y")).toBe("https://example.com/p?a=1&b=2");
    expect(normalLink("https://example.com/")).toBe("https://example.com");
  });
  test("not a web address: as it is, trimmed", () => {
    expect(normalLink(" mailto:x@y.z ")).toBe("mailto:x@y.z");
    expect(normalLink("not a link")).toBe("not a link");
  });
});

test("cardId: 16 hex characters, the same for the same link", () => {
  expect(cardId("http://www.example.com/post/")).toBe(cardId("https://example.com/post"));
  expect(cardId("https://example.com/post")).toMatch(/^[0-9a-f]{16}$/);
  expect(cardId("https://example.com/other")).not.toBe(cardId("https://example.com/post"));
});

describe("liveGet", () => {
  let ua: string | null = null;
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      ua = req.headers.get("user-agent");
      if (path === "/big") return new Response("x".repeat(2 * 1024 * 1024), { headers: { "content-type": "text/plain" } });
      return new Response("hi", { status: path === "/gone" ? 410 : 200, headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });
  afterAll(() => server.stop(true));
  const at = (p: string) => `http://127.0.0.1:${server.port}${p}`;

  test("sends blimpd's User-Agent and gives the status, text and type", async () => {
    expect(await liveGet(at("/"))).toEqual({ status: 200, text: "hi", type: "text/html; charset=utf-8" });
    expect(ua).toBe(USER_AGENT);
    expect(USER_AGENT).toMatch(/^blimpd\/\d+\.\d+\.\d+ \(feed\)$/);
  });
  test("reads at most 1 MB", async () => {
    expect((await liveGet(at("/big"))).text.length).toBe(1024 * 1024);
  });
  test("getText and getJson: anything but 2xx, or JSON that isn't, is a FeedError with its words", async () => {
    await expect(getText(liveGet, at("/gone"))).rejects.toThrow("answered 410");
    await expect(getJson(liveGet, at("/"))).rejects.toThrow("couldn't read it");
  });
});

test("whyFailed: a FeedError's words, a timeout, anything else", () => {
  expect(whyFailed(new FeedError("no key"))).toBe("no key");
  expect(whyFailed(Object.assign(new Error("x"), { name: "TimeoutError" }))).toBe("timed out");
  expect(whyFailed(new Error("ECONNREFUSED"))).toBe("couldn't reach it");
});
