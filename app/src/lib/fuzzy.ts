// Fuzzy match for ⌘K and ⌘P: the query's characters must appear in order, case-insensitive.
// Ranking, strongest first: the query as one contiguous piece beats scattered characters, a
// match at a word start beats one mid-word, and (for ⌘K) a title match beats a folder or name
// match. Each step is worth more than everything after it, so a lower one never outweighs it.

const CONTIGUOUS = 2000;
const WORD_START = 1000;
const TITLE = 100;

const isBoundary = (prev: string) => prev === "" || /[\s/._\-~:]/.test(prev);

// Every query character in order. Runs and word starts score higher; always below CONTIGUOUS.
function scattered(q: string, t: string, text: string): number | null {
  let score = 0;
  let ti = 0;
  let run = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    run = found === ti && ti > 0 ? run + 1 : 0;
    score += 1 + run * 2;
    if (isBoundary(found > 0 ? text[found - 1] : "")) score += 3;
    score -= Math.min(found - ti, 5) * 0.1; // small penalty for gaps
    ti = found + 1;
  }
  return Math.min(score, WORD_START - TITLE - 1);
}

// Returns a score (higher is better) or null when the query doesn't match.
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return 0;
  const t = text.toLowerCase();
  let score: number | null = null;
  // The query as typed ("fix bug") and without spaces ("fixbug"), anywhere in the text.
  for (const piece of new Set([query.toLowerCase().trim().replace(/\s+/g, " "), q])) {
    for (let i = t.indexOf(piece); i >= 0; i = t.indexOf(piece, i + 1)) {
      const s = CONTIGUOUS + (isBoundary(i > 0 ? text[i - 1] : "") ? WORD_START : 0) - Math.min(i, 50) * 0.1;
      if (score === null || s > score) score = s;
    }
  }
  score ??= scattered(q, t, text);
  if (score === null) return null;
  // Prefer shorter texts when everything else is equal.
  return score - Math.min(t.length, 4000) * 0.01;
}

// ⌘K: a session's title, folder and name, each on its own, then all three together so a query
// can span them ("api rate"). A title match gets a bonus over the same match elsewhere.
export function sessionScore(query: string, title: string, folder: string, name: string): number | null {
  const scores = [
    fuzzyScore(query, title),
    fuzzyScore(query, folder),
    fuzzyScore(query, name),
    fuzzyScore(query, `${title} ${folder} ${name}`),
  ];
  if (scores[0] !== null) scores[0] += TITLE;
  const ok = scores.filter((s): s is number => s !== null);
  return ok.length ? Math.max(...ok) : null;
}

// Best first; items that don't match are dropped. The sort is stable, so ties keep their order.
export function rank<T>(items: T[], score: (item: T) => number | null, limit = 50): T[] {
  const scored: { item: T; score: number }[] = [];
  for (const item of items) {
    const s = score(item);
    if (s !== null) scored.push({ item, score: s });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.item);
}

export const fuzzyFilter = <T>(items: T[], query: string, text: (item: T) => string, limit = 50): T[] =>
  rank(items, (i) => fuzzyScore(query, text(i)), limit);
