// Sessions are zmx sessions. Claude Code's own files say what each one is doing:
//   <claude dir>/sessions/<pid>.json        status, keyed by the claude process id
//   <claude dir>/projects/*/<sessionId>.jsonl  transcript, where the title lives
// Both are internal Claude Code formats, not a public API, so blimp's own hooks also write
//   ~/.blimp/status/<zmx name>.json         see hooks.ts
// and a session's state comes from whichever of the two is newer.

import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";

export type ZmxSession = { name: string; pid: number; clients: number; created: number; dir: string; cmd: string };

export type Session = ZmxSession & {
  sessionId?: string;
  title: string;
  status: string; // busy | idle | waiting | shell, or "" when Claude isn't running
  waitingFor?: string;
  updatedAt?: number; // ms
  state: State;
  stateSince?: number; // ms
};

export type State = "working" | "waiting" | "done" | "unknown";

export const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

export const zmxPath = () => Bun.which("zmx") ?? join(homedir(), ".local", "bin", "zmx");

export const socketPath = () => process.env.BLIMPD_SOCKET || join(homedir(), ".blimp", "blimpd.sock");

// Where blimpd keeps its token and the hook status files: next to the socket, ~/.blimp by default.
export const blimpDir = () => dirname(socketPath());

// zmx names become file names (zmx's own sockets, blimp's status files), so only allow plain ones.
export const isSafeName = (name: string) => /^[A-Za-z0-9_.-]+$/.test(name) && name !== "." && name !== "..";

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
// skipping: offset is inside a line longer than a chunk, which is read past without parsing.
type TitleScan = { offset: number; skipping?: boolean; custom?: string; ai?: string; prompt?: string };

function scanTitle(s: TitleScan, text: string) {
  for (const line of text.split("\n")) {
    const interesting =
      line.includes('"custom-title"') || line.includes('"ai-title"') || (!s.prompt && line.includes('"type":"user"'));
    if (!interesting) continue;
    let r: any;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r.type === "custom-title" && r.customTitle) s.custom = r.customTitle;
    else if (r.type === "ai-title" && r.aiTitle) s.ai = r.aiTitle;
    else if (r.type === "user" && !s.prompt) {
      const c = r.message?.content;
      if (typeof c === "string" && !c.startsWith("<")) s.prompt = cut(c.replace(/\s+/g, " "), 70);
    }
  }
}

const pickTitle = (s: TitleScan) => s.custom ?? s.ai ?? s.prompt ?? "(new session)";

export function titleFromTranscript(text: string): string {
  const s: TitleScan = { offset: 0 };
  scanTitle(s, text);
  return pickTitle(s);
}

// Transcripts only grow and can be tens of MB, and the session list is rebuilt every second.
// So each file is scanned once, then only the complete lines appended since are read,
// at most one chunk in memory at a time however long a line is (huge tool output, pasted images).
const titles = new Map<string, TitleScan>();
const TITLE_CHUNK = 16 << 20;

export function transcriptTitle(file: string): string {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return "(new session)";
  }
  try {
    const size = statSync(file).size;
    let s = titles.get(file);
    if (!s || size < s.offset) titles.set(file, (s = { offset: 0 })); // new, or rewritten shorter
    let tail = "";
    while (s.offset < size) {
      const buf = Buffer.alloc(Math.min(TITLE_CHUNK, size - s.offset));
      const n = readSync(fd, buf, 0, buf.length, s.offset);
      if (n === 0) break;
      let start = 0;
      if (s.skipping) {
        const nl = buf.subarray(0, n).indexOf(10);
        if (nl < 0) {
          s.offset += n;
          continue;
        }
        start = nl + 1;
        s.skipping = false;
      }
      const end = buf.lastIndexOf(10, n - 1);
      if (end < start) {
        // No complete line in this chunk. Either a skipped line just ended (read again from the next one),
        // or one line fills a whole chunk (title records are small, so it can't be one: skip it),
        // or the last line is still being written.
        if (start > 0) s.offset += start;
        else if (s.offset + n < size) {
          s.skipping = true;
          s.offset += n;
        } else {
          tail = buf.toString("utf8", 0, n);
          break;
        }
        continue;
      }
      scanTitle(s, buf.toString("utf8", start, end + 1));
      s.offset += end + 1;
    }
    if (!tail) return pickTitle(s);
    // Count an unterminated last line now, but read it again next time in case it grows.
    const t = { ...s };
    scanTitle(t, tail);
    return pickTitle(t);
  } finally {
    closeSync(fd);
  }
}

// Which source says what a session is doing: Claude's status file or blimp's hook file, newest wins.
export function deriveState(info: any, hook: any, createdSec = 0): { state: State; stateSince?: number } {
  let claude: { state: State; at: number } | undefined;
  if (info.waitingFor || info.status === "waiting") claude = { state: "waiting", at: 0 };
  else if (info.status === "busy" || info.status === "shell") claude = { state: "working", at: 0 };
  else if (info.status === "idle") claude = { state: "done", at: 0 };
  if (claude) claude.at = info.statusUpdatedAt ?? info.updatedAt ?? 0;

  let mine: { state: State; at: number } | undefined;
  // A hook file older than the session was left by an earlier session with the same name.
  if (["working", "waiting", "done"].includes(hook.state) && typeof hook.at === "number" && hook.at >= createdSec * 1000)
    mine = { state: hook.state, at: hook.at };

  const best = claude && mine ? (mine.at > claude.at ? mine : claude) : (claude ?? mine);
  return best ? { state: best.state, stateSince: best.at || undefined } : { state: "unknown" };
}

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

// sessionId -> transcript, so finding it doesn't list every project folder every second.
const transcripts = new Map<string, string>();

function transcriptPath(dir: string, sessionId: string): string | undefined {
  const known = transcripts.get(dir + "\0" + sessionId);
  if (known && existsSync(known)) return known;
  const found = findTranscript(dir, sessionId);
  if (found) transcripts.set(dir + "\0" + sessionId, found);
  return found;
}

function findTranscript(dir: string, sessionId: string): string | undefined {
  const projects = join(dir, "projects");
  if (!existsSync(projects)) return;
  const hits = readdirSync(projects)
    .map((p) => join(projects, p, `${sessionId}.jsonl`))
    .filter((p) => existsSync(p));
  return hits.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

export function listSessions(
  dir = claudeDir(),
  zmxOut = runZmxList(),
  statusDir = join(blimpDir(), "status"),
): Session[] {
  return parseZmxList(zmxOut).map((z) => {
    const info = readJson(join(dir, "sessions", `${z.pid}.json`));
    const hook = isSafeName(z.name) ? readJson(join(statusDir, `${z.name}.json`)) : {};
    const file = info.sessionId ? transcriptPath(dir, info.sessionId) : undefined;
    return {
      ...z,
      dir: realDir(info.cwd || z.dir || "/"),
      sessionId: info.sessionId,
      title: file ? transcriptTitle(file) : "(new session)",
      status: info.status ?? "",
      waitingFor: info.waitingFor,
      updatedAt: info.updatedAt,
      ...deriveState(info, hook, z.created),
    };
  });
}

function runZmxList(): string {
  const r = Bun.spawnSync([zmxPath(), "list"], { env: zmxEnv() });
  return r.stdout.toString();
}

// The server's version: doesn't block terminals streaming on the same thread while zmx answers.
export async function zmxListAsync(): Promise<string> {
  const p = Bun.spawn([zmxPath(), "list"], { env: zmxEnv(), stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  return await new Response(p.stdout).text();
}

// zmx lists a session it can't reach as `err=… status=unreachable`, with no pid. That's either one that
// just ended (that same list cleans up its socket) or one too busy to answer in time. Asking again tells which.
export async function sessionExists(name: string): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    const s = parseZmxList(await zmxListAsync()).find((s) => s.name === name);
    if (!s) return false;
    if (s.pid > 0) return true;
  }
  return true; // still there, just busy
}

// The folder zmx keeps every session's socket in, found the way zmx finds it.
export function zmxDir(env: Record<string, string | undefined> = process.env): string {
  if (env.ZMX_DIR) return env.ZMX_DIR;
  if (env.XDG_RUNTIME_DIR) return join(env.XDG_RUNTIME_DIR, "zmx");
  return join(env.TMPDIR || "/tmp", `zmx-${process.getuid!()}`);
}

// Whoever can write that folder can swap a session's socket for their own, and `zmx attach` then sends
// them what you type. Without XDG_RUNTIME_DIR it's /tmp/zmx-<uid>, a name another user can make first,
// and zmx doesn't check who owns it. Making it here (700) leaves no gap for them to make it in between.
export function checkZmxDir(dir = zmxDir()) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.uid !== process.getuid!())
    throw new Error(`zmx's socket folder ${dir} isn't a folder you own. Set ZMX_DIR to a private folder.`);
  if (st.mode & 0o022)
    throw new Error(`zmx's socket folder ${dir} is writable by others. Run: chmod 700 ${dir}`);
}

// Inside a zmx session, ZMX_SESSION makes `zmx attach` switch sessions instead of creating one.
// Every zmx call gets its env here, so the socket folder is checked before each one.
export function zmxEnv() {
  checkZmxDir();
  const env = { ...process.env };
  delete env.ZMX_SESSION;
  return env;
}

// Same names as the claude1 shell helper: <folder>-<HHMMSS>, or <folder>-<NAME>.
// Names end up in file paths, so a custom name is cleaned the same way as the folder.
export function newSessionName(dir: string, at: Date, taken: string[], custom?: string): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");
  const two = (n: number) => String(n).padStart(2, "0");
  const base = `${clean(basename(dir))}-${custom ? clean(custom) : two(at.getHours()) + two(at.getMinutes()) + two(at.getSeconds())}`;
  let name = base;
  for (let i = 2; taken.includes(name); i++) name = `${base}-${i}`;
  return name;
}

// Starts `claude` in dir inside a new zmx session and returns its name. Claude is started
// through the user's login shell so it gets the same environment as typing `claude` there,
// and the shell execs it so the session's pid is Claude's (that's how the status file is found).
// Claude's arguments go to the shell as "$@", never pasted into the command string.
//
// The creating zmx client runs in a 120x36 PTY, not with stdin at /dev/null: the session then has a real
// size from the start, so Claude draws its first screen properly and the first viewer sees it.
// Once the session is listed, that client is killed; the session keeps running.
//
// One start at a time: two in the same second would pick the same name, and the second would just attach.
let starting: Promise<unknown> = Promise.resolve();
export function startSession(dir: string, custom?: string, resume?: string): Promise<string> {
  const p = starting.then(() => start(dir, custom, resume));
  starting = p.catch(() => {});
  return p;
}

async function start(dir: string, custom?: string, resume?: string): Promise<string> {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`not a folder: ${dir}`);
  const name = newSessionName(dir, new Date(), parseZmxList(await zmxListAsync()).map((s) => s.name), custom);
  const shell = process.env.SHELL || userInfo().shell || "/bin/sh";
  const args = resume ? ["--resume", resume] : [];
  const proc = Bun.spawn([zmxPath(), "attach", name, shell, "-l", "-i", "-c", 'exec claude "$@"', "claude", ...args], {
    cwd: dir,
    env: { ...zmxEnv(), TERM: "xterm-256color", COLORTERM: "truecolor" },
    terminal: { cols: 120, rows: 36, data() {} }, // nobody watches this client; zmx keeps the screen
  });
  try {
    // Listed with this client attached. Killed any sooner, zmx 0.5 shows the first viewer an empty screen.
    const end = Date.now() + 5000;
    while (!parseZmxList(await zmxListAsync()).some((s) => s.name === name && s.clients > 0)) {
      if (proc.exitCode !== null || Date.now() > end) throw new Error(`zmx didn't start ${name}`);
      await Bun.sleep(25);
    }
  } finally {
    proc.kill("SIGTERM");
    proc.exited.then(() => proc.terminal?.close());
  }
  return name;
}

// Resolve symlinks so a session shows under the folder Claude really runs in.
export function realDir(p: string): string {
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
