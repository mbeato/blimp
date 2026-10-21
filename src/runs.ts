// Runs: a command Claude handed over (runnable.ts), run when you click Run in an app, never before.
// Each run is a zmx session of its own, of kind "run", started in the folder its Claude session works in
// (the folder of its latest line, so a `cd` into a worktree counts), through your login shell, as typing
// it there would. The command goes to the shell as an argument and runs with `eval "$1"`, never pasted
// into the script. Ctrl-C stops the command, not the run. When it ends, the shell writes its exit code,
// prints "── exit N ──" and stays on as a login shell (in the run's folder again, as the command runs in
// a subshell), so the output stays on screen and the session lives until you close it.
//   <socket dir>/runs/<name>.json      what blimpd started: command, parent, folders, startedAt (600)
//   <socket dir>/runs/<name>.end.json  what the shell wrote when it ended: exit, endedAt (600)
// "Send result to Claude" types the exit code and the output's last lines into the Claude session.

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ANSI, redact } from "./activity";
import { guard, HttpError } from "./files";
import { cleanText } from "./prompt";
import { blimpDir, loginShell, parseZmxList, type Session, sessionExists, startSession, zmxEnv, zmxListAsync, zmxPath } from "./sessions";
import { Asking, findSession, typeInto } from "./typing";

export type Run = { command: string; parent: string; dir: string; cwd: string; startedAt: number; endedAt?: number; exit?: number };

export const runsDir = () => join(blimpDir(), "runs");

const MAX_COMMAND = 4000;

// $1 the command, $2 the runs folder, $3 the shell to stay on in. ZMX_SESSION is the run's zmx name
// (zmx sets it). The command runs in a subshell, so an `exit` in it ends only the command. While it runs
// the wrapper catches SIGINT with a handler that does nothing (not ignores it: the subshell then gets
// Ctrl-C's default), so Ctrl-C ends the command and the wrapper goes on. "── output ──" after the
// echoed command marks where its output starts, however the echo wrapped (runOutput).
const WRAPPER = [
  `trap : INT`,
  `printf '$ %s\\n── output ──\\n' "$1"`,
  `(eval "$1")`,
  `c=$?`,
  `trap - INT`,
  `f="$2/$ZMX_SESSION.end.json"`,
  `(umask 077; printf '{"exit":%s,"endedAt":%s000}\\n' "$c" "$(date +%s)" > "$f.tmp") && mv -f "$f.tmp" "$f"`,
  `printf '\\n── exit %s ──\\n' "$c"`,
  `exec "$3" -l -i`,
].join("; ");

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

// A run session's run, from its two files; undefined if blimpd didn't start it (or it's still starting).
export function readRun(name: string, dir = runsDir()): Run | undefined {
  const r = readJson(join(dir, `${name}.json`));
  if (typeof r.command !== "string" || typeof r.parent !== "string" || typeof r.startedAt !== "number") return;
  const run: Run = { command: r.command, parent: r.parent, dir: String(r.dir ?? ""), cwd: String(r.cwd ?? ""), startedAt: r.startedAt };
  const end = readJson(join(dir, `${name}.end.json`));
  // The shell knows the time to the second only: never before it started.
  if (typeof end.exit === "number" && typeof end.endedAt === "number") Object.assign(run, { endedAt: Math.max(end.endedAt, r.startedAt), exit: end.exit });
  return run;
}

// What a command is checked against: text, 1 to 4000 characters, control characters out.
export function checkCommand(command: unknown): string {
  if (typeof command !== "string" || command.length > MAX_COMMAND || !cleanText(command).trim())
    throw new HttpError(400, `command must be text of 1 to ${MAX_COMMAND} characters`);
  return cleanText(command);
}

const two = (n: number) => String(n).padStart(2, "0");

// Starts command for Claude session `parent` (a live session) and returns the run's zmx name.
export async function startRun(parent: Session, command: string, dir = runsDir()): Promise<string> {
  // Where Claude is now, when that's still a folder in your home; else where the session started.
  let cwd = guard(parent.dir);
  try {
    const now = parent.git?.cwd && guard(parent.git.cwd);
    if (now && statSync(now).isDirectory()) cwd = now;
  } catch {}
  if (!statSync(cwd).isDirectory()) throw new HttpError(400, `not a folder: ${cwd}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  prune(parseZmxList(await zmxListAsync()).map((s) => s.name), dir);
  const at = new Date();
  const shell = loginShell();
  const name = await startSession(cwd, {
    name: `run-${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`,
    kind: "run",
    run: { script: WRAPPER, args: ["blimp", command, dir, shell] },
  });
  const file = join(dir, `${name}.json`);
  writeFileSync(file + ".tmp", JSON.stringify({ command, parent: parent.name, dir: parent.dir, cwd, startedAt: at.getTime() }), { mode: 0o600 });
  renameSync(file + ".tmp", file);
  return name;
}

// Runs whose sessions are gone. An empty live list is more likely a zmx list that failed: nothing goes.
function prune(live: string[], dir: string) {
  if (!live.length) return;
  for (const f of readdirSync(dir)) {
    const name = f.replace(/(\.end)?\.json(\.tmp)?$/, "");
    if (!live.includes(name)) rmSync(join(dir, f), { force: true });
  }
}

// The command's output from the run's screen and scrollback: what's between the wrapper's
// "── output ──" and "── exit N ──" lines, at most the last 40 lines and 4000 characters, as plain text,
// with what looks like a secret taken out (it's typed into Claude's conversation).
// A line as a terminal shows it: colors out, and of a line a \r rewrote (a progress bar) its last state.
const plain = (line: string) => (line.replace(ANSI, "").split("\r").filter((p) => p.trim()).at(-1) ?? "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").trimEnd();

export function runOutput(history: string): string {
  let lines = history.split("\n").map(plain);
  const end = lines.findLastIndex((l) => /^── exit -?\d+ ──$/.test(l.trim()));
  if (end >= 0) lines = lines.slice(0, end);
  // The first: nothing before the wrapper prints it, and the command's own output may.
  const start = lines.findIndex((l) => l === "── output ──");
  if (start >= 0) lines = lines.slice(start + 1);
  while (lines.length && !lines[0]) lines.shift();
  while (lines.length && !lines.at(-1)) lines.pop();
  lines = lines.slice(-40);
  while (lines.length > 1 && lines.join("\n").length > 4000) lines.shift();
  return lines.join("\n").slice(-4000);
}

// What "Send result to Claude" types into the Claude session.
export function resultMessage(run: Run, output: string): string {
  const lines = run.command.split("\n");
  const shown = Array.from(lines[0]).length > 100 ? Array.from(lines[0]).slice(0, 100).join("") + "…" : lines[0] + (lines.length > 1 ? " …" : "");
  // An inline span with more backticks than any run in the command, so the command can't end it.
  const ticks = "`".repeat(Math.max(0, ...[...shown.matchAll(/`+/g)].map((m) => m[0].length)) + 1);
  const head = `[blimp run] ${ticks.length > 1 ? `${ticks} ${shown} ${ticks}` : `\`${shown}\``} finished with exit ${run.exit}.`;
  if (!output) return `${head} It printed nothing.`;
  // A fence longer than any run of backticks in the output, so the output can't end it.
  const fence = "`".repeat(Math.max(3, ...[...output.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return `${head} Last lines of its output:\n${fence}\n${output}\n${fence}`;
}

// Types the run's result into its Claude session. Refused (409) while Claude asks something.
export async function sendResult(name: string, dir = runsDir()): Promise<void> {
  const run = readRun(name, dir);
  if (!run || !(await sessionExists(name))) throw new HttpError(404, `no run named ${name}`);
  if (run.exit === undefined) throw new HttpError(400, "the run hasn't ended yet");
  const parent = await findSession(run.parent);
  if (!parent?.sessionId) throw new HttpError(404, "its Claude session has ended");
  const p = Bun.spawn([zmxPath(), "history", name], { env: zmxEnv(), stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const history = await new Response(p.stdout).text();
  try {
    await typeInto(run.parent, resultMessage(run, redact(runOutput(history))), { enter: true });
  } catch (e) {
    if (e instanceof Asking) throw new HttpError(409, e.message);
    if ((e as Error).message === "the session ended") throw new HttpError(404, "its Claude session has ended");
    throw e;
  }
}
