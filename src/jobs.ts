// The assistant's jobs (docs/superpowers/specs/2026-10-26-assistant-design.md, section 3): the sessions it started or
// messaged with an act command, each with a few words on why. <socket dir>/assistant-jobs.json:
// { "<session name>": { reason, at, reported? } }: at, when the assistant last acted on it; reported, the end of the
// last turn blimpd told the assistant about (reports.ts). 600, through a temp file. Jobs whose session ended go.

import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { blimpDir } from "./sessions";

export type Job = { reason: string; at: number; reported?: number };
export type Jobs = Record<string, Job>;

export const jobsFile = () => join(blimpDir(), "assistant-jobs.json");

// Missing, unreadable or not an object: none. Entries that aren't jobs are left out.
export function readJobs(file = jobsFile()): Jobs {
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
  const out: Jobs = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [name, j] of Object.entries(raw as Record<string, any>))
    if (typeof j?.reason === "string" && typeof j.at === "number")
      out[name] = { reason: j.reason, at: j.at, ...(typeof j.reported === "number" && { reported: j.reported }) };
  return out;
}

function writeJobs(jobs: Jobs, file: string) {
  writeFileSync(file + ".tmp", JSON.stringify(jobs), { mode: 0o600 });
  chmodSync(file + ".tmp", 0o600);
  renameSync(file + ".tmp", file);
}

// The assistant acted on name (again): a new reason and time, and what was reported was about before.
export function saveJob(name: string, reason: string, at: number, file = jobsFile()) {
  writeJobs({ ...readJobs(file), [name]: { reason, at } }, file);
}

// blimpd told the assistant about name's turn that ended at end.
export function markReported(name: string, end: number, file = jobsFile()) {
  const jobs = readJobs(file);
  if (!jobs[name]) return;
  jobs[name].reported = end;
  writeJobs(jobs, file);
}

// Jobs whose session no longer runs go. An empty live list is more likely a zmx list that failed: then none go.
export function dropEnded(live: string[], file = jobsFile()) {
  if (!live.length) return;
  const jobs = readJobs(file);
  const kept = Object.fromEntries(Object.entries(jobs).filter(([n]) => live.includes(n)));
  if (Object.keys(kept).length !== Object.keys(jobs).length) writeJobs(kept, file);
}
