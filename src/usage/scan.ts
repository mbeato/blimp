// `blimpd usage-scan` (docs/superpowers/specs/2026-11-19-usage-design.md, "Counting"): reads what is
// new in Claude Code's transcripts and Codex's session files and adds it to the usage database by hour,
// account, model, project, helper or not, and tier. blimpd runs it as a child process, so a long first
// scan (13 GB on claude1) doesn't hold blimpd up. Each file's rows, its seen keys and how far it was read
// go in one transaction, so a scan stopped half way counts no line twice. Once a day it also keeps a copy
// of the database in <usage dir>/backups, the last 7 kept.

import type { Database } from "bun:sqlite";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { accountsDir, readRecord, recordFile } from "../accounts/store";
import { claudeDir } from "../sessions";
import { openUsage, usageDir } from "./db";
import { entryFor, type Entry, pricesFile, readPrices } from "./prices";
import { accountAt, readTimeline, type Timeline } from "./whose";

export type ScanDirs = { usage?: string; claude?: string; codex?: string; accounts?: string; record?: string; prices?: string };

const CHUNK = 8 * 1024 * 1024;
const COPIES = 7;
const COPY_NAME = /^usage-\d{4}-\d{2}-\d{2}\.db$/;
const DAY = 86_400_000;
const NL = 0x0a;
// Only lines holding one of these are parsed. Checked on the bytes: most of 13 GB is tool output and
// text, and decoding it all would take minutes. A key inside a JSON string is escaped (\"usage\"), so
// it doesn't match.
const CLAUDE_NEEDLES = [Buffer.from('"usage"')];
const CODEX_NEEDLES = ["token_count", "turn_context", "session_meta"].map((s) => Buffer.from(`"${s}"`));

// What a Codex file keeps between scans: the model and folder of the last turn_context, and the last totals.
type Kept = { model: string; cwd: string; input: number; cached: number; output: number };
type Row = { hour: number; account: string; model: string; project: string; helper: number; tier: string; replies: number; input: number; output: number; cacheRead: number; write5m: number; write1h: number };

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

// A transcript line that is a reply from the model. An API error (rate limit, refusal) is written as an
// assistant line too, with model "<synthetic>".
export const isReply = (j: any) =>
  j?.type === "assistant" && !!j.message?.usage && typeof j.message.usage === "object" && typeof j.message.model === "string" && j.message.model !== "<synthetic>";

// Every *.jsonl under dir, at any depth. A folder that isn't there has none.
function walk(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

// Calls each() with every full line in buf that holds one of the needles, and returns where the last
// full line ends: the bytes after it wait for the next read. Each needle's next place is kept, so a
// needle that isn't there is looked for once, not once per line.
function eachLine(buf: Buffer, needles: Buffer[], each: (line: string) => void): number {
  const end = buf.lastIndexOf(NL) + 1;
  const next = needles.map((n) => buf.indexOf(n));
  let from = 0;
  while (from < end) {
    let at = -1;
    for (let i = 0; i < needles.length; i++) {
      if (next[i] !== -1 && next[i] < from) next[i] = buf.indexOf(needles[i], from);
      if (next[i] !== -1 && (at === -1 || next[i] < at)) at = next[i];
    }
    if (at === -1 || at >= end) break;
    const start = buf.lastIndexOf(NL, at) + 1;
    const stop = buf.indexOf(NL, at);
    each(buf.toString("utf8", start, stop));
    from = stop + 1;
  }
  return end;
}

// Reads path from byte `from` to `size` in chunks, never the whole file. Returns where its last full line ends.
function readLines(path: string, from: number, size: number, needles: Buffer[], each: (line: string) => void): number {
  const fd = openSync(path, "r");
  try {
    const chunk = Buffer.allocUnsafe(Math.min(CHUNK, size - from));
    let pos = from;
    let carry = Buffer.alloc(0);
    while (pos < size) {
      const n = readSync(fd, chunk, 0, Math.min(chunk.length, size - pos), pos);
      if (n <= 0) break;
      pos += n;
      const buf = carry.length ? Buffer.concat([carry, chunk.subarray(0, n)]) : chunk.subarray(0, n);
      // A copy: chunk is read into again.
      carry = Buffer.from(buf.subarray(eachLine(buf, needles, each)));
    }
    return pos - carry.length;
  } finally {
    closeSync(fd);
  }
}

export function scan(dirs: ScanDirs = {}, now = Date.now()): { files: number; replies: number } {
  const claude = dirs.claude ?? claudeDir();
  const codex = dirs.codex ?? (process.env.CODEX_HOME || join(homedir(), ".codex"));
  const extra = readPrices(dirs.prices ?? pricesFile()).extra;
  const timeline = readTimeline(dirs.accounts ?? accountsDir());
  const recordId = readRecord(dirs.record ?? recordFile())?.id ?? "";
  const dir = dirs.usage ?? usageDir();
  const db = openUsage(dir)!;
  try {
    const result = scanWith(db, claude, codex, extra, timeline, recordId, now);
    dailyCopy(db, dir, now);
    return result;
  } finally {
    db.close();
  }
}

// <usage dir>/backups/usage-<UTC day>.db once a day, the newest 7 kept. VACUUM INTO writes a whole,
// consistent file and can't run inside a transaction. A copy that fails doesn't fail the scan.
function dailyCopy(db: Database, dir: string, now: number) {
  try {
    const backups = join(dir, "backups");
    const file = join(backups, `usage-${new Date(now).toISOString().slice(0, 10)}.db`);
    if (existsSync(file)) return;
    mkdirSync(backups, { recursive: true, mode: 0o700 });
    chmodSync(backups, 0o700);
    db.run("vacuum into ?", [file]);
    chmodSync(file, 0o600);
    const dated = readdirSync(backups).filter((n) => COPY_NAME.test(n)).sort();
    for (const n of dated.slice(0, -COPIES)) rmSync(join(backups, n), { force: true });
  } catch (e) {
    console.error(`blimpd usage-scan: the daily copy failed: ${(e as Error).message}`);
  }
}

function scanWith(db: Database, claude: string, codex: string, extra: Record<string, Entry>, timeline: Timeline | undefined, recordId: string, now: number) {
  const known = new Map<string, { at: number; extra: string | null }>();
  for (const f of db.query("select path, at, extra from files").all() as { path: string; at: number; extra: string | null }[]) known.set(f.path, f);
  const seen = db.query("insert or ignore into seen values (?, ?)");
  const setFile = db.query("insert or replace into files values (?, ?, ?)");
  const setMeta = db.query("insert or replace into meta values (?, ?)");
  const add = db.query(
    `insert into rows values ($hour, $account, $model, $project, $helper, $tier, $replies, $input, $output, $cacheRead, $write5m, $write1h)
     on conflict (hour, account, model, project, helper, tier) do update set
       replies = replies + excluded.replies, input = input + excluded.input, output = output + excluded.output,
       cache_read = cache_read + excluded.cache_read, write_5m = write_5m + excluded.write_5m, write_1h = write_1h + excluded.write_1h`,
  );
  const limitRow = db.query("select value from meta where key = 'codexLimit'").get() as { value: string } | null;
  let limitAt = limitRow ? num(JSON.parse(limitRow.value).at) : 0;

  let files = 0;
  let replies = 0;
  const walked = new Set<string>();

  // One file: its new lines summed by row key, then added with its seen keys and new place, together.
  const readFile = db.transaction((path: string, from: number, size: number, isCodex: boolean, keptText: string | null) => {
    const sums = new Map<string, Row>();
    const count = (r: Omit<Row, "replies">) => {
      const key = `${r.hour}\0${r.account}\0${r.model}\0${r.project}\0${r.helper}\0${r.tier}`;
      const s = sums.get(key);
      if (!s) sums.set(key, { ...r, replies: 1 });
      else {
        s.replies++;
        s.input += r.input;
        s.output += r.output;
        s.cacheRead += r.cacheRead;
        s.write5m += r.write5m;
        s.write1h += r.write1h;
      }
      replies++;
    };
    const helperFile = path.includes("/subagents/");
    const kept: Kept = keptText ? JSON.parse(keptText) : { model: "", cwd: "", input: 0, cached: 0, output: 0 };

    const claudeLine = (line: string) => {
      let j: any;
      try {
        j = JSON.parse(line);
      } catch {
        return;
      }
      if (!isReply(j)) return;
      const m = j.message;
      const u = m.usage;
      const ms = typeof j.timestamp === "string" ? Date.parse(j.timestamp) : NaN;
      if (Number.isNaN(ms)) return;
      // The same reply is written once per content block, and again in a resumed conversation's file.
      if (seen.run(`${m.id}:${j.requestId ?? ""}`, Math.floor(ms / DAY)).changes === 0) return;
      const write1h = num(u.cache_creation?.ephemeral_1h_input_tokens);
      const c = { input: num(u.input_tokens), output: num(u.output_tokens), cacheRead: num(u.cache_read_input_tokens), write5m: Math.max(0, num(u.cache_creation_input_tokens) - write1h), write1h };
      const long = entryFor(m.model, extra)?.long;
      const tier = u.speed === "fast" ? "fast" : long && c.input + c.cacheRead + c.write5m + c.write1h > long.over ? "long" : "";
      const account = !m.model.startsWith("claude-") ? "other" : timeline ? accountAt(timeline, ms) : recordId;
      count({ hour: Math.floor(ms / 3_600_000), account, model: m.model, project: typeof j.cwd === "string" ? j.cwd : "", helper: j.isSidechain === true || helperFile ? 1 : 0, tier, ...c });
    };

    const codexLine = (line: string) => {
      let j: any;
      try {
        j = JSON.parse(line);
      } catch {
        return;
      }
      const p = j?.payload;
      if (j.type === "session_meta" || j.type === "turn_context") {
        if (typeof p?.cwd === "string") kept.cwd = p.cwd;
        if (j.type === "turn_context" && typeof p?.model === "string") kept.model = p.model;
        return;
      }
      if (j.type !== "event_msg" || p?.type !== "token_count") return;
      const ms = typeof j.timestamp === "string" ? Date.parse(j.timestamp) : NaN;
      const t = p.info?.total_token_usage;
      if (t && typeof t === "object") {
        const total = { input: num(t.input_tokens), cached: num(t.cached_input_tokens), output: num(t.output_tokens) };
        const grown = { input: total.input - kept.input, cached: total.cached - kept.cached, output: total.output - kept.output };
        // A total that went down is a new count, not a turn: nothing is counted, and it is kept as it is.
        const down = grown.input < 0 || grown.cached < 0 || grown.output < 0;
        if (!down && (grown.input || grown.cached || grown.output) && !Number.isNaN(ms))
          count({ hour: Math.floor(ms / 3_600_000), account: "codex", model: kept.model, project: kept.cwd, helper: 0, tier: "", input: Math.max(0, grown.input - grown.cached), output: grown.output, cacheRead: grown.cached, write5m: 0, write1h: 0 });
        Object.assign(kept, total);
      }
      const r = p.rate_limits;
      if (r && typeof r === "object" && ms > limitAt) {
        limitAt = ms;
        setMeta.run("codexLimit", JSON.stringify({ at: ms, plan: r.plan_type, primary: r.primary, secondary: r.secondary }));
      }
    };

    const at = readLines(path, from, size, isCodex ? CODEX_NEEDLES : CLAUDE_NEEDLES, isCodex ? codexLine : claudeLine);
    for (const r of sums.values())
      add.run({ $hour: r.hour, $account: r.account, $model: r.model, $project: r.project, $helper: r.helper, $tier: r.tier, $replies: r.replies, $input: r.input, $output: r.output, $cacheRead: r.cacheRead, $write5m: r.write5m, $write1h: r.write1h });
    setFile.run(path, at, isCodex ? JSON.stringify(kept) : null);
  });

  for (const [top, isCodex] of [
    [join(claude, "projects"), false],
    [join(codex, "sessions"), true],
  ] as const) {
    for (const path of walk(top)) {
      walked.add(path);
      let size: number;
      try {
        size = statSync(path).size;
      } catch {
        continue; // gone since the walk
      }
      const k = known.get(path);
      // Equal: nothing new. Smaller: rewritten or cut, left alone rather than counted again.
      if (k && size <= k.at) continue;
      readFile(path, k?.at ?? 0, size, isCodex, k?.extra ?? null);
      files++;
    }
  }

  // A file that went leaves the table; its totals stay in rows.
  const forget = db.query("delete from files where path = ?");
  db.transaction(() => {
    for (const path of known.keys()) if (!walked.has(path)) forget.run(path);
  })();
  db.run("delete from seen where day < ?", [Math.floor(now / DAY) - 40]);
  setMeta.run("scanEnded", String(now));
  return { files, replies };
}

// `blimpd usage-scan`: blimpd runs it, so it prints nothing unless it fails.
export function runUsageScan(): number {
  try {
    scan();
    return 0;
  } catch (e) {
    console.error(`blimpd usage-scan: ${(e as Error).message}`);
    return 1;
  }
}
