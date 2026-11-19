// The usage database (docs/superpowers/specs/2026-11-19-usage-design.md, "Counting"):
// <socket dir>/usage/usage.db, folder 700, file 600. SQLite, so a scan stopped half way counts no line
// twice: a file's rows and how far it was read are saved in one transaction. WAL, so blimpd reads while
// the scan writes.

import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { blimpDir } from "../sessions";

export const usageDir = (dir = blimpDir()) => join(dir, "usage");

const TABLES = `
create table if not exists files (path text primary key, at integer not null, extra text) without rowid;
create table if not exists seen (key text primary key, day integer not null) without rowid;
create table if not exists rows (
  hour integer not null, account text not null, model text not null, project text not null,
  helper integer not null, tier text not null,
  replies integer not null, input integer not null, output integer not null,
  cache_read integer not null, write_5m integer not null, write_1h integer not null,
  primary key (hour, account, model, project, helper, tier)
) without rowid;
create table if not exists meta (key text primary key, value text not null) without rowid;
`;

// Read only, and no file yet or a first scan that hasn't made the tables yet: undefined.
export function openUsage(dir = usageDir(), readonly = false): Database | undefined {
  const file = join(dir, "usage.db");
  if (readonly) {
    if (!existsSync(file)) return;
    const db = new Database(file, { readonly: true });
    db.run("pragma busy_timeout = 5000");
    if (db.query("select 1 from sqlite_master where name = 'meta'").get()) return db;
    db.close();
    return;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700); // mode only applies to a new folder
  // Made 600 before SQLite opens it; its -wal and -shm files take the same mode.
  writeFileSync(file, "", { flag: "a", mode: 0o600 });
  chmodSync(file, 0o600);
  const db = new Database(file);
  db.run("pragma journal_mode = WAL");
  db.run("pragma busy_timeout = 5000");
  // All at once, so a reader sees all four tables or none.
  db.transaction(() => db.run(TABLES))();
  return db;
}
