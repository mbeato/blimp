// The feed's store (docs/DESIGN.md, "Feed"): its settings in config.json, its cards in <socket dir>/feed.json, the
// order the phone sees them in, and the events socket's message. Every change goes through updateFeed, which reads,
// changes and writes in one go (no await in between), so the job's changes and a route's never undo each other.

import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configFile, readConfig } from "../names";
import { blimpDir } from "../sessions";

export type Kind = "hn" | "reddit" | "github" | "rss";
// A post a source found in a run, before it's a card. rank: its place in its source's list, from 1. ref: what its
// source needs to read more (HN's story id, Reddit's permalink, GitHub's owner/repo).
export type Found = {
  kind: Kind;
  source: string;
  url: string;
  title: string;
  rank: number;
  score?: number;
  comments?: number;
  thread?: string;
  text?: string;
  image?: string;
  ref?: string;
};
export type CardSource = { kind: Kind; name: string; score?: number; comments?: number; thread?: string };
// at: when the run that found it started (ms). rank: its best place in its sources' lists in that run. tries: failed
// summaries, triedAt the last one's time. input: what the model reads, dropped once there's a summary.
export type Card = {
  id: string;
  url: string;
  title: string;
  sources: CardSource[];
  at: number;
  rank: number;
  image?: string;
  summary?: string;
  interest?: boolean;
  tries: number;
  triedAt?: number;
  input?: string;
};
export type Run = { at: number; ok: boolean; reason?: string };
// seen: card id -> when. saved: card ids, the newest last. runs: each source's last result. calls: the model calls
// of the last hour.
export type FeedFile = { cards: Record<string, Card>; seen: Record<string, number>; saved: string[]; runs: Record<string, Run>; lastRun: number; calls: number[] };
export type FeedSettings = { on: boolean; subreddits: string[]; rss: string[]; interests: string[] };

export const DEFAULT_SUBREDDITS = ["programming", "LocalLLaMA", "ClaudeAI", "MachineLearning"];
// Checked live when the feed was built (the plan's Task 3); one that stops working shows on the caught-up card.
export const DEFAULT_RSS = [
  "https://developer.apple.com/news/rss/news.rss",
  "https://openai.com/news/rss.xml",
  "https://www.swift.org/atom.xml",
  "https://bun.com/rss.xml",
  "https://github.blog/changelog/feed/",
];
export const FEED_ID = /^[0-9a-f]{16}$/;

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

export const feedFile = () => join(blimpDir(), "feed.json");

const list = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string").map((s) => s.trim()) : undefined);

// config.json's "feed". Off unless "on" is true. A list that's missing gets its default; subreddits are plain names
// ("r/" dropped), feeds http(s) addresses, interests at most 20 of up to 60 characters.
export function readFeedSettings(file = configFile()): FeedSettings {
  const f = ((readConfig(file) as { feed?: any }).feed ?? {}) as Record<string, unknown>;
  return {
    on: f.on === true,
    subreddits: list(f.subreddits)?.map((s) => s.replace(/^\/?r\//i, "")).filter((s) => /^[A-Za-z0-9_]{2,21}$/.test(s)) ?? DEFAULT_SUBREDDITS,
    rss: list(f.rss)?.filter((s) => /^https?:\/\/\S+$/i.test(s)) ?? DEFAULT_RSS,
    interests: (list(f.interests)?.filter((s) => s.length > 0 && s.length <= 60) ?? []).slice(0, 20),
  };
}

const empty = (): FeedFile => ({ cards: {}, seen: {}, saved: [], runs: {}, lastRun: 0, calls: [] });

// Missing or broken: empty (the next run fills it). Any other failure to read it (a busy or unreadable file) throws,
// so a change is never written over saved and seen that were only unreadable for a moment. A card without a link, title, sources or time is left out, and
// a saved id without its card.
export function readFeed(file = feedFile()): FeedFile {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return empty();
    throw e;
  }
  let v: any;
  try {
    v = JSON.parse(text);
  } catch {
    return empty();
  }
  const f = empty();
  if (!v || typeof v !== "object") return f;
  for (const [id, c] of Object.entries(v.cards ?? {}) as [string, any][])
    if (c && typeof c.url === "string" && typeof c.title === "string" && Array.isArray(c.sources) && typeof c.at === "number")
      f.cards[id] = { ...c, id, rank: typeof c.rank === "number" ? c.rank : 99, tries: typeof c.tries === "number" ? c.tries : 0 };
  for (const [id, t] of Object.entries(v.seen ?? {})) if (typeof t === "number") f.seen[id] = t;
  if (Array.isArray(v.saved)) f.saved = v.saved.filter((id: unknown) => typeof id === "string" && f.cards[id]);
  for (const [k, r] of Object.entries(v.runs ?? {}) as [string, any][]) if (r && typeof r.at === "number" && typeof r.ok === "boolean") f.runs[k] = r;
  if (typeof v.lastRun === "number") f.lastRun = v.lastRun;
  if (Array.isArray(v.calls)) f.calls = v.calls.filter((t: unknown) => typeof t === "number");
  return f;
}

// Read, change, write: through a temp file and a rename, so it's never half written; 600.
export function updateFeed<T>(change: (f: FeedFile) => T, file = feedFile()): T {
  const f = readFeed(file);
  const out = change(f);
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(f), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  return out;
}

// Cards go 3 days after they were found, unless saved; seen marks after 7 days, so a card found again later still
// counts as seen.
export function cleanup(f: FeedFile, now: number) {
  const saved = new Set(f.saved);
  for (const [id, c] of Object.entries(f.cards)) if (now - c.at > 3 * DAY && !saved.has(id)) delete f.cards[id];
  for (const [id, t] of Object.entries(f.seen)) if (now - t > 7 * DAY) delete f.seen[id];
}

// A card shows once it has a summary, or after two failed tries with its title only.
export const ready = (c: Card) => c.summary !== undefined || c.tries >= 2;

const KINDS: Kind[] = ["hn", "github", "reddit", "rss"];

// Interest matches first; then the newest run; then each source's place, the sources taking turns at each place
// (HN, GitHub, Reddit, release notes).
export function byOrder(a: Card, b: Card): number {
  return (
    Number(!!b.interest) - Number(!!a.interest) ||
    b.at - a.at ||
    a.rank - b.rank ||
    KINDS.indexOf(a.sources[0]?.kind) - KINDS.indexOf(b.sources[0]?.kind) ||
    a.id.localeCompare(b.id)
  );
}

// What the phone gets of a card.
export type ShownCard = { id: string; url: string; title: string; sources: CardSource[]; at: number; image?: string; summary?: string; interest: boolean };
export type ShownFeed = { on: boolean; cards: ShownCard[]; saved: ShownCard[]; runs: Record<string, Run>; next: number };

const shown = (c: Card): ShownCard => ({
  id: c.id,
  url: c.url,
  title: c.title,
  sources: c.sources,
  at: c.at,
  ...(c.image && { image: c.image }),
  ...(c.summary !== undefined && { summary: c.summary }),
  interest: !!c.interest,
});

const unseen = (f: FeedFile) => Object.values(f.cards).filter((c) => ready(c) && !(c.id in f.seen));

// GET /feed: the unseen cards that are ready, in order; the saved ones, newest first; each source's last run; when
// the next run starts. Off: nothing.
export function shownFeed(on = readFeedSettings().on, file = feedFile()): ShownFeed {
  if (!on) return { on: false, cards: [], saved: [], runs: {}, next: 0 };
  const f = readFeed(file);
  return {
    on: true,
    cards: unseen(f).sort(byOrder).map(shown),
    saved: [...f.saved].reverse().map((id) => shown(f.cards[id])),
    runs: f.runs,
    next: f.lastRun + HOUR,
  };
}

// The events socket's message: the switch, and how many cards the phone hasn't seen (its Feed button's dot).
export function feedMessage(on = readFeedSettings().on, file = feedFile()): string {
  return JSON.stringify({ type: "feed", on, unseen: on ? unseen(readFeed(file)).length : 0 });
}

const listeners: (() => void)[] = [];
// server.ts publishes the message when it changes: after a run, a summary, a seen card, the switch.
export const onFeedChange = (f: () => void) => void listeners.push(f);
export function feedChanged() {
  for (const f of listeners)
    try {
      f();
    } catch {}
}

// POST /feed/seen: these cards don't come back. An id that isn't a card is ignored.
export function markFeedSeen(ids: string[], now = Date.now(), file = feedFile()) {
  updateFeed((f) => {
    for (const id of ids) if (f.cards[id]) f.seen[id] ??= now;
  }, file);
  feedChanged();
}

// POST /feed/saved: saved goes last (the newest), unsaved comes out. false: no such card.
export function setFeedSaved(id: string, saved: boolean, file = feedFile()): boolean {
  return updateFeed((f) => {
    if (!f.cards[id]) return false;
    f.saved = f.saved.filter((s) => s !== id);
    if (saved) f.saved.push(id);
    return true;
  }, file);
}
