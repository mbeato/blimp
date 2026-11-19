// The usage scan (src/usage/scan.ts): each Claude reply and Codex turn counted once, by hour, account,
// model, project, helper and tier. Made-up transcripts in fresh temp folders; never the real ~/.claude.

import { afterAll, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openUsage } from "../src/usage/db";
import { scan, type ScanDirs } from "../src/usage/scan";

const root = mkdtempSync(join(tmpdir(), "blimp-scan-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = (): Required<ScanDirs> => {
  const d = join(root, `t${++n}`);
  mkdirSync(d, { recursive: true });
  return { usage: join(d, "usage"), claude: join(d, "claude"), codex: join(d, "codex"), accounts: join(d, "accounts"), record: join(d, "claude.json"), prices: join(d, "prices.json") };
};

const H = 3_600_000;
const T0 = Date.UTC(2026, 10, 19, 10, 15); // 2026-11-19 10:15 UTC
const NOW = Date.UTC(2026, 10, 19, 18);
const iso = (ms: number) => new Date(ms).toISOString();

type Claude = { id?: string; req?: string; model?: string; at?: number | null; usage?: object; cwd?: string; side?: boolean; speed?: string; type?: string };
const claude = (o: Claude = {}) =>
  JSON.stringify({
    type: o.type ?? "assistant",
    ...(o.at !== null && { timestamp: iso(o.at ?? T0) }),
    requestId: o.req ?? "req_1",
    cwd: o.cwd ?? "/home/u/proj",
    isSidechain: o.side ?? false,
    message: {
      id: o.id ?? "msg_1",
      model: o.model ?? "claude-opus-5-5",
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 40,
        cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 0 },
        speed: o.speed ?? "standard",
        ...o.usage,
      },
    },
  }) + "\n";

const put = (file: string, text: string) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const session = (d: ScanDirs, name: string, project = "-home-u-proj") => join(d.claude!, "projects", project, name);

const rows = (d: ScanDirs) => {
  const db = openUsage(d.usage, true)!;
  const r = db.query("select * from rows order by hour, account, model, project, helper, tier").all() as any[];
  db.close();
  return r;
};
const meta = (d: ScanDirs, key: string) => {
  const db = openUsage(d.usage, true)!;
  const r = db.query("select value from meta where key = ?").get(key) as { value: string } | null;
  db.close();
  return r?.value;
};
const filesTable = (d: ScanDirs) => {
  const db = openUsage(d.usage, true)!;
  const r = db.query("select path, at from files order by path").all() as { path: string; at: number }[];
  db.close();
  return r;
};

test("one reply written on three lines is one reply, its tokens once", () => {
  const d = fresh();
  put(session(d, "a.jsonl"), claude() + claude() + claude());
  expect(scan(d, NOW)).toEqual({ files: 1, replies: 1 });
  expect(rows(d)).toEqual([
    { hour: Math.floor(T0 / H), account: "", model: "claude-opus-5-5", project: "/home/u/proj", helper: 0, tier: "", replies: 1, input: 10, output: 20, cache_read: 30, write_5m: 40, write_1h: 0 },
  ]);
});

test("the same reply in a second file is not counted again; a second scan adds nothing and reads no file", () => {
  const d = fresh();
  put(session(d, "a.jsonl"), claude());
  put(session(d, "b.jsonl"), claude() + claude({ id: "msg_2" }));
  expect(scan(d, NOW)).toEqual({ files: 2, replies: 2 });
  expect(rows(d)[0].replies).toBe(2);
  expect(scan(d, NOW)).toEqual({ files: 0, replies: 0 });
  expect(rows(d)[0].replies).toBe(2);
});

test("a last line with no newline waits; once the rest is there it is counted once", () => {
  const d = fresh();
  const f = session(d, "a.jsonl");
  const line = claude({ id: "msg_2" });
  put(f, claude() + line.slice(0, 50));
  expect(scan(d, NOW)).toEqual({ files: 1, replies: 1 });
  expect(filesTable(d)[0].at).toBe(claude().length);
  appendFileSync(f, line.slice(50));
  expect(scan(d, NOW)).toEqual({ files: 1, replies: 1 });
  expect(rows(d)[0].replies).toBe(2);
  expect(scan(d, NOW)).toEqual({ files: 0, replies: 0 });
});

test("<synthetic> is not a reply; nor is a line with no timestamp, or one that isn't the assistant's", () => {
  const d = fresh();
  put(session(d, "a.jsonl"), claude({ model: "<synthetic>" }) + claude({ id: "m2", at: null }) + claude({ id: "m3", type: "user" }) + "{broken\n");
  expect(scan(d, NOW)).toEqual({ files: 1, replies: 0 });
  expect(rows(d)).toEqual([]);
});

test("the two kinds of cache write", () => {
  const d = fresh();
  put(session(d, "a.jsonl"), claude({ usage: { cache_creation_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 60 } } }));
  scan(d, NOW);
  expect(rows(d)[0]).toMatchObject({ write_5m: 40, write_1h: 60 });
});

test("a missing number is 0", () => {
  const d = fresh();
  put(session(d, "a.jsonl"), JSON.stringify({ type: "assistant", timestamp: iso(T0), message: { id: "m", model: "claude-opus-5-5", usage: { output_tokens: 5 } } }) + "\n");
  expect(scan(d, NOW).replies).toBe(1);
  expect(rows(d)[0]).toMatchObject({ project: "", input: 0, output: 5, cache_read: 0, write_5m: 0, write_1h: 0 });
});

test("a helper agent's file and a sidechain line are helper rows", () => {
  const d = fresh();
  put(session(d, "a.jsonl"), claude() + claude({ id: "m2", side: true }));
  put(join(d.claude, "projects", "-home-u-proj", "a", "subagents", "agent-1.jsonl"), claude({ id: "m3" }));
  scan(d, NOW);
  expect(rows(d).map((r) => [r.helper, r.replies])).toEqual([
    [0, 1],
    [1, 2],
  ]);
});

test("two replies in different hours are two rows; in the same hour, one row with two replies", () => {
  const d = fresh();
  put(session(d, "a.jsonl"), claude({ id: "m1" }) + claude({ id: "m2", at: T0 + 30 * 60_000 }) + claude({ id: "m3", at: T0 + H }));
  scan(d, NOW);
  expect(rows(d).map((r) => [r.hour, r.replies, r.input])).toEqual([
    [Math.floor(T0 / H), 2, 20],
    [Math.floor(T0 / H) + 1, 1, 10],
  ]);
});

test("tier: Haiku 5.5 with a prompt over 100,000 tokens is long; speed fast is fast", () => {
  const d = fresh();
  put(
    session(d, "a.jsonl"),
    claude({ id: "m1", model: "claude-haiku-5-5", usage: { input_tokens: 120_000 } }) +
      claude({ id: "m2", model: "claude-haiku-5-5" }) +
      claude({ id: "m3", speed: "fast" }) +
      claude({ id: "m4", model: "claude-opus-5-5", usage: { input_tokens: 120_000 } }),
  );
  scan(d, NOW);
  expect(rows(d).map((r) => [r.model, r.tier])).toEqual([
    ["claude-haiku-5-5", ""],
    ["claude-haiku-5-5", "long"],
    ["claude-opus-5-5", ""],
    ["claude-opus-5-5", "fast"],
  ]);
});

test("account: by the log (before its first line nobody, after a switch the new one); a model not Claude's is other", () => {
  const d = fresh();
  put(join(d.accounts, "log.jsonl"), [{ at: T0, event: "login", account: "A" }, { at: T0 + H, event: "switch", from: "A", to: "B" }].map((l) => JSON.stringify(l)).join("\n") + "\n");
  put(join(d.record), JSON.stringify({ oauthAccount: { accountUuid: "R", emailAddress: "r@x.com" } }));
  put(
    session(d, "a.jsonl"),
    claude({ id: "m1", at: T0 - 1 }) + claude({ id: "m2", at: T0 + 10 }) + claude({ id: "m3", at: T0 + H + 10 }) + claude({ id: "m4", model: "GLM-5.3", at: T0 + H + 10 }),
  );
  scan(d, NOW);
  expect(rows(d).map((r) => [r.hour - Math.floor(T0 / H), r.account, r.model])).toEqual([
    [0, "", "claude-opus-5-5"],
    [0, "A", "claude-opus-5-5"],
    [1, "B", "claude-opus-5-5"],
    [1, "other", "GLM-5.3"],
  ]);
});

test("account with no log: the one .claude.json names", () => {
  const d = fresh();
  put(join(d.record), JSON.stringify({ oauthAccount: { accountUuid: "R", emailAddress: "r@x.com" } }));
  put(session(d, "a.jsonl"), claude());
  scan(d, NOW);
  expect(rows(d)[0].account).toBe("R");
});

type Totals = [number, number, number];
const codexLine = (type: string, payload: object, at = T0) => JSON.stringify({ timestamp: iso(at), type, payload }) + "\n";
const tokenCount = ([input, cached, output]: Totals, at = T0, limits?: object) =>
  codexLine(
    "event_msg",
    {
      type: "token_count",
      info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, total_tokens: input + output } },
      ...(limits && { rate_limits: limits }),
    },
    at,
  );
const codexFile = (d: ScanDirs, name = "rollout-a.jsonl") => join(d.codex!, "sessions", "2026", "11", "19", name);
const limits = (used: number) => ({ primary: { used_percent: used, window_minutes: 300, resets_at: 1795047637 }, secondary: { used_percent: 3, window_minutes: 10080, resets_at: 1795500000 }, plan_type: "pro" });

test("Codex: each growth of the totals is one turn, cached input taken out of input, under the turn's model", () => {
  const d = fresh();
  const f = codexFile(d);
  put(
    f,
    codexLine("session_meta", { cwd: "/home/u/cx" }) +
      codexLine("turn_context", { cwd: "/home/u/cx", model: "gpt-6-astra" }) +
      tokenCount([100, 40, 10]) +
      tokenCount([100, 40, 10]) +
      tokenCount([250, 90, 30], T0 + H),
  );
  expect(scan(d, NOW)).toEqual({ files: 1, replies: 2 });
  expect(rows(d)).toEqual([
    { hour: Math.floor(T0 / H), account: "codex", model: "gpt-6-astra", project: "/home/u/cx", helper: 0, tier: "", replies: 1, input: 60, output: 10, cache_read: 40, write_5m: 0, write_1h: 0 },
    { hour: Math.floor(T0 / H) + 1, account: "codex", model: "gpt-6-astra", project: "/home/u/cx", helper: 0, tier: "", replies: 1, input: 100, output: 20, cache_read: 50, write_5m: 0, write_1h: 0 },
  ]);
  // 250 − 100 = 150 more input, of which 90 − 40 = 50 came from cache: 100.
  // The kept totals carry over to the next scan: the same token_count again adds nothing, a growth adds one.
  appendFileSync(f, tokenCount([250, 90, 30], T0 + H) + tokenCount([300, 90, 35], T0 + H));
  expect(scan(d, NOW)).toEqual({ files: 1, replies: 1 });
  expect(rows(d)[1]).toMatchObject({ replies: 2, input: 150, cache_read: 50, output: 25 });
});

test("Codex: a total that went down counts nothing, and the smaller totals are kept", () => {
  const d = fresh();
  put(codexFile(d), codexLine("turn_context", { cwd: "/c", model: "gpt-5.6-terra" }) + tokenCount([100, 40, 10]) + tokenCount([50, 20, 5]) + tokenCount([60, 20, 6]));
  expect(scan(d, NOW).replies).toBe(2);
  expect(rows(d)[0]).toMatchObject({ replies: 2, input: 70, cache_read: 40, output: 11 });
});

test("Codex's limit: the newest rate_limits lands in meta.codexLimit; an older line doesn't replace it", () => {
  const d = fresh();
  put(codexFile(d, "rollout-b.jsonl"), tokenCount([10, 0, 1], T0 + H, limits(40)));
  scan(d, NOW);
  expect(JSON.parse(meta(d, "codexLimit")!)).toEqual({ at: T0 + H, plan: "pro", primary: limits(40).primary, secondary: limits(40).secondary });
  put(codexFile(d, "rollout-a.jsonl"), tokenCount([10, 0, 1], T0, limits(12)));
  scan(d, NOW);
  expect(JSON.parse(meta(d, "codexLimit")!).primary.used_percent).toBe(40);
  appendFileSync(codexFile(d, "rollout-a.jsonl"), tokenCount([20, 0, 2], T0 + 2 * H, limits(55)));
  scan(d, NOW);
  expect(JSON.parse(meta(d, "codexLimit")!)).toMatchObject({ at: T0 + 2 * H, primary: { used_percent: 55 } });
});

test("a file gone from disk leaves the files table and its totals stay; a file that shrank is left alone", () => {
  const d = fresh();
  const a = session(d, "a.jsonl");
  const b = session(d, "b.jsonl");
  put(a, claude({ id: "m1" }));
  put(b, claude({ id: "m2" }) + claude({ id: "m3" }));
  scan(d, NOW);
  rmSync(a);
  truncateSync(b, 10);
  expect(scan(d, NOW)).toEqual({ files: 0, replies: 0 });
  expect(filesTable(d)).toEqual([{ path: b, at: 2 * claude({ id: "m2" }).length }]);
  expect(rows(d)[0].replies).toBe(3);
});

test("scanEnded is set, and seen keys older than 40 days go", () => {
  const d = fresh();
  const old = NOW - 41 * 86_400_000;
  put(session(d, "a.jsonl"), claude({ id: "m-old", at: old }) + claude({ id: "m-new" }));
  scan(d, NOW);
  expect(meta(d, "scanEnded")).toBe(String(NOW));
  const db = openUsage(d.usage, true)!;
  expect(db.query("select key from seen").all()).toEqual([{ key: "m-new:req_1" }]);
  db.close();
});

test("no Claude or Codex folder at all: nothing read, and the scan still ends", () => {
  const d = fresh();
  expect(scan(d, NOW)).toEqual({ files: 0, replies: 0 });
  expect(meta(d, "scanEnded")).toBe(String(NOW));
});

test("a reply across the 8 MB read boundary, and one after a line longer than a read, are each counted once", () => {
  const d = fresh();
  const filler = (bytes: number) => JSON.stringify({ type: "user", text: "x".repeat(bytes - 30) }) + "\n";
  put(session(d, "a.jsonl"), filler(8 * 1024 * 1024 - 100) + claude({ id: "m1" }) + filler(9 * 1024 * 1024) + claude({ id: "m2" }));
  expect(scan(d, NOW)).toEqual({ files: 1, replies: 2 });
  expect(rows(d)[0].replies).toBe(2);
});
