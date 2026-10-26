// A linked page for the feed (docs/DESIGN.md, "Feed"): its description, its picture (og:image) and its first
// paragraphs (1,500 characters), read with Bun's HTMLRewriter. Only an HTML page that answered 2xx.

import { clip } from "../names";
import type { Get } from "./net";
import { decode } from "./text";

export type Page = { description?: string; image?: string; text: string };

const MAX = 1500;

// An http(s) address, relative ones made whole against the page's own.
function absolute(src: string, base: string): string | undefined {
  try {
    const u = new URL(src, base);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}

export async function parsePage(html: string, base: string): Promise<Page> {
  let description: string | undefined;
  let image: string | undefined;
  let text = "";
  await new HTMLRewriter()
    .on('meta[name="description"]', {
      element(e) {
        description ??= e.getAttribute("content") ?? undefined;
      },
    })
    .on('meta[property="og:description"]', {
      element(e) {
        description ??= e.getAttribute("content") ?? undefined;
      },
    })
    .on('meta[property="og:image"]', {
      element(e) {
        image ??= e.getAttribute("content") ?? undefined;
      },
    })
    .on("p", {
      element() {
        if (text) text += " ";
      },
      text(t) {
        if (text.length < MAX) text += t.text;
      },
    })
    .transform(new Response(html))
    .text();
  const page: Page = { text: clip(decode(text), MAX) };
  const d = description && clip(decode(description), 300);
  if (d) page.description = d;
  const img = image && absolute(decode(image), base);
  if (img) page.image = img;
  return page;
}

export async function readPage(get: Get, url: string): Promise<Page | undefined> {
  const r = await get(url);
  if (r.status < 200 || r.status >= 300 || !/html/i.test(r.type)) return undefined;
  return parsePage(r.text, url);
}
