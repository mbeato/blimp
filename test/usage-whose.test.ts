// Which account was in use when (src/usage/whose.ts), from blimp's accounts log, and the usage
// database's folder and tables (src/usage/db.ts). Temp folders only.

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openUsage, usageDir } from "../src/usage/db";
import { accountAt, readTimeline } from "../src/usage/whose";

const root = mkdtempSync(join(tmpdir(), "blimp-whose-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = () => {
  const d = join(root, `t${++n}`);
  mkdirSync(d, { recursive: true });
  return d;
};
const lines = (...l: (object | string)[]) => l.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join("\n") + "\n";

test("no log files: undefined", () => {
  expect(readTimeline(fresh())).toBeUndefined();
  expect(readTimeline(join(root, "not-there"))).toBeUndefined();
});

test("login, switch, unknown and renewal say who was in use; a broken line and other events are skipped", () => {
  const dir = fresh();
  writeFileSync(
    join(dir, "log.jsonl"),
    lines(
      { at: 100, event: "login", account: "A" },
      "{not json",
      { at: 150, event: "stop", account: "A", session: "s" },
      { at: 200, event: "switch", from: "A", to: "B" },
      { at: 300, event: "unknown" },
      { at: 400, event: "renewal", account: "B" },
    ),
  );
  const t = readTimeline(dir)!;
  expect(t).toEqual([
    { at: 100, id: "A" },
    { at: 200, id: "B" },
    { at: 300, id: "" },
    { at: 400, id: "B" },
  ]);
  expect([50, 150, 250, 350, 450].map((ms) => accountAt(t, ms))).toEqual(["", "A", "B", "", "B"]);
});

test("log.1.jsonl comes before log.jsonl; adopted names the account", () => {
  const dir = fresh();
  writeFileSync(join(dir, "log.jsonl"), lines({ at: 500, event: "switch", from: "A", to: "C" }));
  writeFileSync(join(dir, "log.1.jsonl"), lines({ at: 10, event: "adopted", account: "A" }));
  const t = readTimeline(dir)!;
  expect(t).toEqual([
    { at: 10, id: "A" },
    { at: 500, id: "C" },
  ]);
  expect(accountAt(t, 499)).toBe("A");
  expect(accountAt(t, 500)).toBe("C");
});

test("openUsage makes the folder 700 and the file 600 with the four tables; read only with no file is undefined", () => {
  const top = fresh();
  const dir = usageDir(top);
  expect(dir).toBe(join(top, "usage"));
  expect(openUsage(dir, true)).toBeUndefined();
  const db = openUsage(dir)!;
  const tables = db.query("select name from sqlite_master where type = 'table' order by name").all() as { name: string }[];
  expect(tables.map((t) => t.name)).toEqual(["files", "meta", "rows", "seen"]);
  expect((db.query("pragma journal_mode").get() as any).journal_mode).toBe("wal");
  db.run("insert into meta values ('k', 'v')");
  db.close();
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(statSync(join(dir, "usage.db")).mode & 0o777).toBe(0o600);
  const ro = openUsage(dir, true)!;
  expect(ro.query("select value from meta where key = 'k'").get()).toEqual({ value: "v" });
  expect(() => ro.run("insert into meta values ('k2', 'v')")).toThrow();
  ro.close();
});
