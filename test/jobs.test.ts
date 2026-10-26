// The assistant's jobs file (src/jobs.ts): the sessions it started or messaged, why, and what blimpd last told it.

import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dropEnded, markReported, readJobs, saveJob } from "../src/jobs";

const file = () => join(mkdtempSync(join(tmpdir(), "blimp-jobs-")), "assistant-jobs.json");

test("none when the file is missing, unreadable or not an object; entries that aren't jobs are left out", () => {
  const f = file();
  expect(readJobs(f)).toEqual({});
  writeFileSync(f, "not json");
  expect(readJobs(f)).toEqual({});
  writeFileSync(f, "[1]");
  expect(readJobs(f)).toEqual({});
  writeFileSync(f, JSON.stringify({ a: { reason: "fix CI", at: 5, reported: 7 }, b: { reason: 3, at: 5 }, c: { reason: "x" }, d: { reason: "y", at: 1, reported: "z" } }));
  expect(readJobs(f)).toEqual({ a: { reason: "fix CI", at: 5, reported: 7 }, d: { reason: "y", at: 1 } });
});

test("saveJob writes 600 through a temp file; saving again replaces the reason and time and forgets what was reported", () => {
  const f = file();
  saveJob("blimp-1", "fix CI", 100, f);
  expect(readJobs(f)).toEqual({ "blimp-1": { reason: "fix CI", at: 100 } });
  expect(statSync(f).mode & 0o777).toBe(0o600);
  markReported("blimp-1", 150, f);
  expect(readJobs(f)["blimp-1"]).toEqual({ reason: "fix CI", at: 100, reported: 150 });
  saveJob("blimp-1", "and the docs", 200, f);
  saveJob("api-1", "tests", 210, f);
  expect(readJobs(f)).toEqual({ "blimp-1": { reason: "and the docs", at: 200 }, "api-1": { reason: "tests", at: 210 } });
});

test("markReported does nothing for a session that isn't a job", () => {
  const f = file();
  saveJob("blimp-1", "fix CI", 100, f);
  const before = readFileSync(f, "utf8");
  markReported("other", 150, f);
  expect(readFileSync(f, "utf8")).toBe(before);
});

test("dropEnded keeps the jobs whose session still runs; an empty list (a failed zmx list) drops nothing", () => {
  const f = file();
  saveJob("blimp-1", "fix CI", 100, f);
  saveJob("api-1", "tests", 110, f);
  dropEnded([], f);
  expect(Object.keys(readJobs(f))).toEqual(["blimp-1", "api-1"]);
  dropEnded(["api-1", "assistant"], f);
  expect(readJobs(f)).toEqual({ "api-1": { reason: "tests", at: 110 } });
});
