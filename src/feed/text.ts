// Text helpers for the feed (docs/DESIGN.md, "Feed"): entities and HTML to plain text, and the one form of a link
// that tells two sources' posts are the same card.

import { createHash } from "node:crypto";

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

// &amp; &lt; &gt; &quot; &apos; &nbsp; and numeric ones (&#8217; &#x2019;). Anything else stays as it is.
export function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

// HTML to plain text: CDATA's inside kept, scripts and styles dropped, every tag a space, entities decoded, runs of
// space made one.
export function plain(html: string): string {
  const t = html
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ");
  return decode(t).replace(/\s+/g, " ").trim();
}

const TRACKING = /^(utm_.*|ref|ref_src|fbclid|gclid|mc_cid|mc_eid)$/i;

// The form two posts of the same link share: https, no www., no default port, no #part, no tracking parameters, the
// rest sorted, and no final /. Not a web address: as it is, trimmed.
export function normalLink(url: string): string {
  const raw = url.trim();
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return raw;
  if (u.port === "80" || u.port === "443") u.port = "";
  u.protocol = "https:";
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
  u.hash = "";
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  u.searchParams.sort();
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
  const s = u.toString();
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

// A card's id: the first 16 hex characters of the SHA-256 of its link's normal form.
export const cardId = (url: string) => createHash("sha256").update(normalLink(url)).digest("hex").slice(0, 16);
