// Kinds of session: the ways to start one (docs/DESIGN.md, "Kinds"). Claude Code, Claude Code on
// Z.ai's GLM, Codex, a plain shell, and the user's own from <socket dir>/kinds.json.
// Sessions run here, so keys live here too: the Z.ai key in ~/.config/zai/key (600, the same file
// Max's claude-glm script reads). It goes to Claude in the environment, never on a command line,
// and no route ever returns it.

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { HttpError } from "./files";
import { browserReady } from "./browser/service";
import { mcpConfigPath, selfCommand } from "./browser/mcp";
import { blimpDir, loginShell } from "./sessions";

// What GET /kinds lists. note: why one can't start, or a status (Codex signed in or not).
export type Kind = { id: string; label: string; available: boolean; note?: string };

// How start() runs a kind in the login shell: `$SHELL -l -i -c <script> <args…>` (no script: the
// shell itself). Arguments go to the script as "$@", never pasted into it.
export type Launch = { script?: string; args: string[]; env?: Record<string, string> };

type Custom = { id: string; label: string; command: string[]; env: Record<string, string> };
type KindsFile = { kinds: Custom[]; glm: { model?: string; fast?: string }; note?: string };

const BUILT_IN = ["claude", "claude-glm", "codex", "shell", "codex-login"];

// Only these two are Claude Code: they can resume a conversation.
export const CLAUDE_KINDS = ["claude", "claude-glm"];

// The small label a session row shows (none for Claude Code and a shell).
const SHORT: Record<string, string> = { "claude-glm": "GLM", codex: "Codex", "codex-login": "Codex sign-in" };

export const kindsFile = () => join(blimpDir(), "kinds.json");
export const zaiKeyFile = (home = homedir()) => join(home, ".config", "zai", "key");
const codexAuth = (home = homedir()) => join(process.env.CODEX_HOME || join(home, ".codex"), "auth.json");

// The user's kinds. A file that's there but wrong is ignored as a whole, with a note saying why.
export function readKindsFile(file = kindsFile()): KindsFile {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { kinds: [], glm: {} };
  }
  try {
    return parseKinds(JSON.parse(text));
  } catch (e) {
    return { kinds: [], glm: {}, note: `~/.blimp/kinds.json is ignored: ${(e as Error).message}` };
  }
}

const isStrings = (v: unknown): v is Record<string, string> =>
  !!v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string");

function parseKinds(f: any): KindsFile {
  if (!f || typeof f !== "object" || Array.isArray(f)) throw new Error("not a JSON object");
  const kinds: Custom[] = [];
  for (const k of f.kinds ?? []) {
    const what = typeof k?.id === "string" ? `kind "${k.id}"` : "a kind";
    if (typeof k?.id !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(k.id)) throw new Error(`${what} needs a plain id (letters, digits, - and _)`);
    if (BUILT_IN.includes(k.id)) throw new Error(`${what} has a built-in kind's id`);
    if (kinds.some((x) => x.id === k.id)) throw new Error(`${what} is there twice`);
    if (typeof k.label !== "string" || !k.label.trim()) throw new Error(`${what} needs a label`);
    if (!Array.isArray(k.command) || !k.command.length || !k.command.every((a: unknown) => typeof a === "string" && a))
      throw new Error(`${what} needs a command: a list of words, like ["aider", "--model", "x"]`);
    if (k.env !== undefined && (!isStrings(k.env) || !Object.keys(k.env).every((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n))))
      throw new Error(`${what} has an env that isn't names and text`);
    kinds.push({ id: k.id, label: k.label.trim(), command: k.command, env: k.env ?? {} });
  }
  const glm = f.glm ?? {};
  if (!isStrings(glm) || Object.keys(glm).some((n) => n !== "model" && n !== "fast")) throw new Error('glm takes only "model" and "fast", as text');
  return { kinds, glm };
}

// Which commands the login shell finds: claude, codex and the first word of each of the user's
// kinds. nvm and ~/.local/bin often join PATH only there, so blimpd's own PATH can't tell. It runs
// as sessions do (-l -i): Debian's .bashrc stops early unless the shell is interactive, and that's
// where nvm is set up. One shell for all of them, kept 30 s. Finding nothing (a profile that hung or
// failed) isn't kept: the next call asks again.
// npx runs the browser MCP (browser/mcp.ts).
const LOOK_FOR = ["claude", "codex", "npx"];
let found: { at: number; key: string; names: Promise<Set<string>> } | undefined;

export function installed(file = kindsFile()): Promise<Set<string>> {
  const look = [...new Set([...LOOK_FOR, ...readKindsFile(file).kinds.map((k) => k.command[0])])];
  const key = look.join("\0");
  if (!found || found.key !== key || Date.now() - found.at > 30_000) {
    const names = lookUp(look);
    const mine = (found = { at: Date.now(), key, names });
    names.then((s) => {
      if (!s.size && found === mine) found = undefined;
    });
  }
  return found.names;
}

async function lookUp(look: string[]): Promise<Set<string>> {
  // A profile may print things, so only marked lines count.
  const script = 'for n in "$@"; do command -v "$n" >/dev/null 2>&1 && echo "blimp-found:$n"; done';
  let timedOut = false;
  try {
    const p = Bun.spawn([loginShell(), "-l", "-i", "-c", script, "blimp", ...look], { cwd: homedir(), stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => ((timedOut = true), p.kill()), 5000); // a profile that hangs
    try {
      const out = await new Response(p.stdout).text();
      if (timedOut) return new Set();
      return new Set([...out.matchAll(/^blimp-found:(.+)$/gm)].map((m) => m[1]));
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return new Set(); // no such shell
  }
}

// The Z.ai key, or "" when there is none.
export function zaiKey(home = homedir()): string {
  try {
    return readFileSync(zaiKeyFile(home), "utf8").trim();
  } catch {
    return "";
  }
}

// Written to a temp file (600) beside it, then renamed into place, so it's never half there.
export function setZaiKey(key: unknown, home = homedir()) {
  if (typeof key !== "string" || !/^[\x21-\x7e]{10,500}$/.test(key))
    throw new HttpError(400, "a key is 10 to 500 printable characters, with no spaces");
  const file = zaiKeyFile(home);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  chmodSync(dirname(file), 0o700);
  const tmp = join(dirname(file), `.key-${randomBytes(6).toString("hex")}`);
  writeFileSync(tmp, key, { mode: 0o600, flag: "wx" });
  renameSync(tmp, file);
}

export const removeZaiKey = (home = homedir()) => rmSync(zaiKeyFile(home), { force: true });

// Every kind, in menu order: built-in ones, the user's, then Shell.
export function listKinds(have: Set<string>, home = homedir(), file = kindsFile()): Kind[] {
  const custom = readKindsFile(file);
  const missing = (cmd: string) => `${cmd} isn't installed`;
  const key = !!zaiKey(home);
  const kinds: Kind[] = [
    { id: "claude", label: "Claude Code", available: have.has("claude"), ...(!have.has("claude") && { note: missing("claude") }) },
    {
      id: "claude-glm",
      label: "Claude Code on GLM",
      available: key && have.has("claude"),
      ...(!key ? { note: "Add a Z.ai key in Settings" } : !have.has("claude") && { note: missing("claude") }),
    },
    {
      id: "codex",
      label: "Codex",
      available: have.has("codex"),
      note: !have.has("codex") ? missing("codex") : existsSync(codexAuth(home)) ? "signed in" : "not signed in",
    },
    ...custom.kinds.map((k) => ({ id: k.id, label: k.label, available: have.has(k.command[0]), ...(!have.has(k.command[0]) && { note: missing(k.command[0]) }) })),
  ];
  // A bad kinds.json shows where its kinds would be, greyed, saying what's wrong.
  if (custom.note) kinds.push({ id: "kinds.json", label: "Your kinds", available: false, note: custom.note });
  kinds.push({ id: "shell", label: "Shell", available: true });
  return kinds;
}

// How to start kind `id`, or 400 if it's unknown or can't start here. resume: Claude Code only.
// Claude Code and Codex get the server browser's MCP when there's a Chrome to run and npx to run
// the MCP with (browser: whether the first holds; a parameter for tests).
export async function launchFor(id: string, resume?: string, home = homedir(), file = kindsFile(), browser = browserReady): Promise<Launch> {
  const have = await installed(file);
  const resumeArgs = resume ? ["--resume", resume] : [];
  const mcp = have.has("npx") && browser();
  const claudeArgs = ["claude", ...(mcp ? ["--mcp-config", mcpConfigPath()] : []), ...resumeArgs];
  // The login shell found nothing at all, so it couldn't tell: Claude Code is tried anyway, as
  // before kinds. A missing claude then shows in the session itself.
  if (id === "claude" && !have.size) return { script: 'exec claude "$@"', args: ["claude", ...resumeArgs] };
  // Settings' Codex sign-in: the user finishes it in the terminal (a code to type in a browser).
  if (id === "codex-login") {
    if (!have.has("codex")) throw new HttpError(400, "codex isn't installed");
    return { script: 'exec codex "$@"', args: ["codex", "login", "--device-auth"] };
  }
  const kind = listKinds(have, home, file).find((k) => k.id === id && k.id !== "kinds.json");
  if (!kind) throw new HttpError(400, `no kind of session called ${id}`);
  if (!kind.available) throw new HttpError(400, `${kind.label} can't start here: ${kind.note}`);
  if (id === "shell") return { args: [] };
  if (id === "claude") return { script: 'exec claude "$@"', args: claudeArgs };
  if (id === "codex") {
    // Codex takes MCP servers as config overrides; values are TOML, which JSON strings and arrays are.
    const [cmd, ...rest] = selfCommand();
    const server = mcp ? ["-c", `mcp_servers.blimp-browser.command=${JSON.stringify(cmd)}`, "-c", `mcp_servers.blimp-browser.args=${JSON.stringify([...rest, "browser-mcp"])}`] : [];
    return { script: 'exec codex "$@"', args: ["codex", ...server] };
  }
  if (id === "claude-glm") {
    // What claude-glm sets. The login profile runs before the script, so these are set in the script,
    // after it: a profile's own ANTHROPIC_BASE_URL can't send the Z.ai key elsewhere. The key itself
    // comes in the environment (never on a command line) under a name no profile sets.
    const { glm } = readKindsFile(file);
    const model = glm.model || "GLM-5.3";
    const set = {
      ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
      ANTHROPIC_MODEL: model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: glm.fast || "GLM-5.3-Flash",
      CLAUDE_CODE_SUBAGENT_MODEL: model,
      API_TIMEOUT_MS: "3000000",
    };
    const exports = Object.entries(set).map(([n, v]) => `${n}=${quote(v)}`).join(" ");
    return {
      script: `export ${exports}; export ANTHROPIC_AUTH_TOKEN="$BLIMP_ZAI_TOKEN"; unset BLIMP_ZAI_TOKEN ANTHROPIC_API_KEY; exec claude "$@"`,
      args: claudeArgs,
      env: { BLIMP_ZAI_TOKEN: zaiKey(home) },
    };
  }
  const custom = readKindsFile(file).kinds.find((k) => k.id === id)!;
  return { script: 'exec "$@"', args: ["blimp", ...custom.command], env: custom.env };
}

// Text as one shell word, whatever is in it.
const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

// The small label for a session of this kind (a kind no longer in kinds.json: its id).
// custom: the user's kinds, read once by whoever labels a whole list.
export function kindLabel(kind: string, custom: { id: string; label: string }[]): string | undefined {
  if (kind === "claude" || kind === "shell") return;
  return SHORT[kind] ?? custom.find((k) => k.id === kind)?.label ?? kind;
}
