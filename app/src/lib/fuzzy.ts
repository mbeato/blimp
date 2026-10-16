// Fuzzy match for ⌘K and ⌘P: the query's characters must appear in order, case-insensitive.
// Runs of consecutive characters and matches at word starts score higher, so "api" ranks
// "api.ts" above "a_p_i".

const isBoundary = (prev: string) => prev === "" || /[\s/._\-~]/.test(prev);

// Returns a score (higher is better) or null when the query doesn't match.
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return 0;
  const t = text.toLowerCase();
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
  // Prefer shorter texts when everything else is equal.
  return score - t.length * 0.01;
}

export function fuzzyFilter<T>(items: T[], query: string, text: (item: T) => string, limit = 50): T[] {
  const scored: { item: T; score: number }[] = [];
  for (const item of items) {
    const score = fuzzyScore(query, text(item));
    if (score !== null) scored.push({ item, score });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.item);
}
