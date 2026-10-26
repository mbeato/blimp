// Release notes and blogs for the feed (docs/DESIGN.md, "Feed"): RSS 2.0 and Atom, read with a few patterns rather
// than an XML parser (title, link, date and text are all the feed needs; CDATA and entities are handled). A post
// without a date or a web link is left out.

import { clip } from "../names";
import { FeedError, type Get, getText } from "./net";
import type { Found } from "./store";
import { decode, plain } from "./text";

const DAY = 24 * 60 * 60_000;

// The inside of the first <name …>…</name> in block, or undefined. name may have a prefix (content:encoded).
function inner(block: string, name: string): string | undefined {
  return block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"))?.[1];
}

// Text content: CDATA as it is, anything else with its entities decoded once (escaped HTML becomes HTML), then plain.
const content = (raw: string | undefined) => (raw === undefined ? undefined : plain(/<!\[CDATA\[/.test(raw) ? raw : decode(raw)));

// Atom's link: the alternate one, or one with no rel.
function atomLink(entry: string): string | undefined {
  const attrs = [...entry.matchAll(/<link\b([^>]*)>/gi)].map((m) => m[1]);
  const alt = attrs.find((a) => !/\brel=/.test(a) || /\brel=["']alternate["']/.test(a));
  const href = alt?.match(/\bhref=["']([^"']+)["']/)?.[1];
  return href === undefined ? undefined : decode(href);
}

// The posts published since `since` (ms). Its source: the feed's title, or the address's host.
export function parseFeed(xml: string, url: string, since: number): Found[] {
  if (!/<(rss|feed|rdf:RDF)[\s>]/i.test(xml)) throw new FeedError("not a feed");
  const atom = !/<rss[\s>]/i.test(xml) && /<feed[\s>]/i.test(xml);
  const start = xml.search(atom ? /<entry[\s>]/i : /<item[\s>]/i);
  const head = start < 0 ? xml : xml.slice(0, start);
  let source = clip(content(inner(head, "title")) ?? "", 40);
  if (!source)
    try {
      source = new URL(url).hostname;
    } catch {
      source = url;
    }
  const blocks = [...xml.matchAll(atom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi)].map((m) => m[0]);
  const posts: Found[] = [];
  for (const b of blocks) {
    const title = content(inner(b, "title"));
    const link = (atom ? atomLink(b) : content(inner(b, "link")))?.trim();
    const when = Date.parse(content(inner(b, atom ? "published" : "pubDate")) ?? content(inner(b, "updated")) ?? content(inner(b, "dc:date")) ?? "");
    if (!title || !link || !/^https?:\/\//i.test(link) || !(when >= since)) continue;
    const text = content(inner(b, "content:encoded") ?? inner(b, "content") ?? inner(b, "description") ?? inner(b, "summary"));
    posts.push({ kind: "rss", source, rank: posts.length + 1, url: link, title, ...(text && { text }) });
  }
  return posts;
}

// The last 3 days of one feed.
export const readRss = async (get: Get, url: string, now: number) => parseFeed(await getText(get, url), url, now - 3 * DAY);
