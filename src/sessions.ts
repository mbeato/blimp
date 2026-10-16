// Sessions are zmx sessions. Claude Code's own files say what each one is doing:
//   <claude dir>/sessions/<pid>.json        status, keyed by the claude process id
//   <claude dir>/projects/*/<sessionId>.jsonl  transcript, where the title lives
// Both are internal Claude Code formats, not a public API.

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, join } from "node:path";

export type ZmxSession = { name: string; pid: number; clients: number; created: number; dir: string; cmd: string };

export type Session = ZmxSession & {
  sessionId?: string;
  title: string;
  status: string; // busy | idle | waiting | shell, or "" when Claude isn't running
  waitingFor?: string;
  updatedAt?: number; // ms
};

export const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

export const zmxPath = () => Bun.which("zmx") ?? join(homedir(), ".local", "bin", "zmx");

// `zmx list` prints tab-separated key=value lines. The session you're in starts with "→".
// zmx 0.5 calls the folder start_dir, 0.8 calls it cwd and may give it as a file:// URL.
export function parseZmxList(out: string): ZmxSession[] {
  const rows: ZmxSession[] = [];
  for (const line of out.split("\n")) {
    const f: Record<string, string> = {};
    for (const part of line.split("\t")) {
      const m = part.match(/(\w+)=(.*)/);
      if (m) f[m[1]] = m[2];
    }
    if (!f.name) continue;
    let dir = f.cwd ?? f.start_dir ?? "";
    if (dir.startsWith("file://")) dir = decodeURIComponent(new URL(dir).pathname);
    rows.push({
      name: f.name,
      pid: Number(f.pid),
      clients: Number(f.clients ?? 0),
      created: Number(f.created ?? 0),
      dir,
      cmd: f.cmd ?? "",
    });
  }
  return rows.sort((a, b) => a.created - b.created);
}

// Title order matches Claude's own: last /rename, else last AI title, else the first thing typed.
export function titleFromTranscript(text: string): string {
  let custom: string | undefined;
  let ai: string | undefined;
  let prompt: string | undefined;
  for (const line of text.split("\n")) {
    const interesting =
      line.includes('"custom-title"') || line.includes('"ai-title"') || (!prompt && line.includes('"type":"user"'));
    if (!interesting) continue;
    let r: any;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r.type === "custom-title" && r.customTitle) custom = r.customTitle;
    else if (r.type === "ai-title" && r.aiTitle) ai = r.aiTitle;
    else if (r.type === "user" && !prompt) {
      const c = r.message?.content;
      if (typeof c === "string" && !c.startsWith("<")) prompt = cut(c.replace(/\s+/g, " "), 70);
    }
  }
  return custom ?? ai ?? prompt ?? "(new session)";
}

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function transcriptPath(dir: string, sessionId: string): string | undefined {
  const projects = join(dir, "projects");
  if (!existsSync(projects)) return;
  const hits = readdirSync(projects)
    .map((p) => join(projects, p, `${sessionId}.jsonl`))
    .filter((p) => existsSync(p));
  return hits.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

export function listSessions(dir = claudeDir(), zmxOut = runZmxList()): Session[] {
  return parseZmxList(zmxOut).map((z) => {
    const info = readJson(join(dir, "sessions", `${z.pid}.json`));
    const file = info.sessionId ? transcriptPath(dir, info.sessionId) : undefined;
    return {
      ...z,
      dir: realDir(info.cwd || z.dir || "/"),
      sessionId: info.sessionId,
      title: file ? titleFromTranscript(readFileSync(file, "utf8")) : "(new session)",
      status: info.status ?? "",
      waitingFor: info.waitingFor,
      updatedAt: info.updatedAt,
    };
  });
}

function runZmxList(): string {
  const r = Bun.spawnSync([zmxPath(), "list"], { env: zmxEnv() });
  return r.stdout.toString();
}

// Inside a zmx session, ZMX_SESSION makes `zmx attach` switch sessions instead of creating one.
function zmxEnv() {
  const env = { ...process.env };
  delete env.ZMX_SESSION;
  return env;
}

// Same names as the claude1 shell helper: <folder>-<HHMMSS>, or <folder>-<NAME>.
export function newSessionName(dir: string, at: Date, taken: string[], custom?: string): string {
  const folder = basename(dir).replace(/[^A-Za-z0-9_-]/g, "_");
  const two = (n: number) => String(n).padStart(2, "0");
  const base = `${folder}-${custom ?? two(at.getHours()) + two(at.getMinutes()) + two(at.getSeconds())}`;
  let name = base;
  for (let i = 2; taken.includes(name); i++) name = `${base}-${i}`;
  return name;
}

// Starts `claude` in dir inside a new zmx session and returns its name. Claude is started
// through the user's login shell so it gets the same environment as typing `claude` there,
// and the shell execs it so the session's pid is Claude's (that's how the status file is found).
export function startSession(dir: string, custom?: string): string {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`not a folder: ${dir}`);
  const name = newSessionName(dir, new Date(), parseZmxList(runZmxList()).map((s) => s.name), custom);
  const shell = process.env.SHELL || userInfo().shell || "/bin/sh";
  // With stdin at /dev/null the zmx client creates the session, then detaches right away.
  // No pipes: the session daemon inherits them and would keep them open forever.
  Bun.spawnSync([zmxPath(), "attach", name, shell, "-l", "-i", "-c", "exec claude"], {
    cwd: dir,
    env: zmxEnv(),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  if (!parseZmxList(runZmxList()).some((s) => s.name === name)) throw new Error(`zmx didn't start ${name}`);
  return name;
}

// Resolve symlinks so a session shows under the folder Claude really runs in.
function realDir(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function cut(s: string, n: number): string {
  return Array.from(s).slice(0, n).join("");
}

function ago(ms: number | undefined, now: number): string {
  if (!ms) return "";
  const s = (now - ms) / 1000;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// The same columns `claude1 ls` prints, so the two can be compared line by line.
export function formatList(rows: Session[], now = Date.now(), home = realDir(homedir())): string {
  return rows
    .map((s, i) => {
      const title = cut(s.title, 60);
      const status = s.waitingFor || s.status;
      const where = s.dir.startsWith(home) ? "~" + s.dir.slice(home.length) : s.dir;
      return `${String(i + 1).padStart(2)}  ${title}${" ".repeat(60 - Array.from(title).length)}  ${status.padEnd(12)} ${ago(s.updatedAt, now).padStart(8)}  ${s.name}  ${where}`;
    })
    .join("\n");
}
