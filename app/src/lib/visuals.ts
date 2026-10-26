// A page a session showed with blimp's show tool (docs/superpowers/specs/2026-10-26-visuals-design.md), as a tab:
// its key, and the events message that opens it. One tab per page file: showing the same file again moves its tab
// to the new copy.

import type { Visual } from "./api";

// Shares `active` with file paths, "tab:" browser tabs and "gallery:" folders. File paths are absolute, so they
// never start with the prefix.
const PREFIX = "visual:";
export const visualTab = (source: string) => PREFIX + source;
export const isVisualTab = (key: string | null) => !!key?.startsWith(PREFIX);

// A "visual" events message, or null if it isn't one this app can show. The id goes into a URL, so only blimpd's.
export function visualFrom(m: unknown): Visual | null {
  const v = m as Record<string, unknown> | null;
  const str = (x: unknown): x is string => typeof x === "string";
  if (!v || typeof v !== "object" || v.type !== "visual") return null;
  if (!str(v.id) || !/^[0-9a-f]{12}$/.test(v.id) || !str(v.title) || !str(v.session) || !str(v.dir) || !str(v.source)) return null;
  return { id: v.id, title: v.title, session: v.session, dir: v.dir, source: v.source, at: typeof v.at === "number" ? v.at : 0 };
}
