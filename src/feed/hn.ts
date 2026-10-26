// Hacker News for the feed (docs/DESIGN.md, "Feed"): the front page (30 stories) from Algolia's API, and a new
// story's first 3 comments (in the order Algolia gives them).

import { type Get, getJson } from "./net";
import type { Found } from "./store";
import { plain } from "./text";

export const HN_FRONT = "https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30";
export const hnItem = (id: string) => `https://hn.algolia.com/api/v1/items/${id}`;
const thread = (id: string) => `https://news.ycombinator.com/item?id=${id}`;

// A text post (no url) links to its thread.
export function parseFront(json: any): Found[] {
  const hits: any[] = Array.isArray(json?.hits) ? json.hits : [];
  return hits
    .filter((h) => typeof h?.objectID === "string" && typeof h.title === "string" && h.title.trim())
    .slice(0, 30)
    .map(
      (h, i): Found => ({
        kind: "hn",
        source: "Hacker News",
        rank: i + 1,
        url: typeof h.url === "string" && h.url ? h.url : thread(h.objectID),
        title: h.title.trim(),
        ...(typeof h.points === "number" && { score: h.points }),
        ...(typeof h.num_comments === "number" && { comments: h.num_comments }),
        thread: thread(h.objectID),
        ...(typeof h.story_text === "string" && h.story_text && { text: plain(h.story_text) }),
        ref: h.objectID,
      }),
    );
}

export function parseItem(json: any): string[] {
  const kids: any[] = Array.isArray(json?.children) ? json.children : [];
  return kids
    .filter((k) => typeof k?.text === "string" && k.text.trim())
    .slice(0, 3)
    .map((k) => plain(k.text));
}

export const readHn = async (get: Get) => parseFront(await getJson(get, HN_FRONT));
export const hnComments = async (get: Get, id: string) => parseItem(await getJson(get, hnItem(id)));
