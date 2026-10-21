import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isUnread, markSeen, readSeen, startSeen } from "../src/seen";

const dir = mkdtempSync(join(tmpdir(), "blimp-seen-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("before blimpd made the file nothing is unread; after, a reply newer than what was seen is", () => {
  const f = join(dir, "seen.json");
  expect(isUnread(readSeen(f), "c1", 5000)).toBe(false);
  expect(markSeen("c1", 5000, f)).toBe(false);
  startSeen(f, 1000);
  startSeen(f, 9999); // made once: a restart doesn't make everything read
  expect(statSync(f).mode & 0o777).toBe(0o600);
  const s = readSeen(f);
  expect(s.since).toBe(1000);
  expect(isUnread(s, "c1", 900)).toBe(false); // from before blimpd kept track
  expect(isUnread(s, "c1", 5000)).toBe(true);
  expect(isUnread(s, undefined, 5000)).toBe(false);
  expect(isUnread(s, "c1", undefined)).toBe(false);
  expect(markSeen("c1", 5000, f)).toBe(true);
  expect(markSeen("c1", 4000, f)).toBe(false); // an older reply doesn't go back
  expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ since: 1000, seen: { c1: 5000 } });
  expect(isUnread(readSeen(f), "c1", 5000)).toBe(false);
  expect(isUnread(readSeen(f), "c1", 6000)).toBe(true);
});
