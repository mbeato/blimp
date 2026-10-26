# Assistant, part 1 (the server) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One Claude session, named `assistant`, that blimpd keeps running in its own folder; it can look at
every project freely (`blimpd overview`, `blimpd read`) and must get the user's Allow before it acts on another
session (`blimpd start`, `blimpd send`, `blimpd answer`). Switched on with `blimpd assistant on`.

**Architecture:** `src/assistant.ts` owns the folder (`<socket dir>/assistant`), the files blimpd writes there
(`blimp.md` every start, `CLAUDE.md` once, `.claude/settings.json` with `allow`/`ask` rules every start), the
on/off switch in `config.json`, and a 5 s keep-alive tick that starts the session (with `--permission-mode
default`, and `--continue` once the folder has a conversation). `src/overview.ts` holds the look commands,
`src/act.ts` the new act commands, and `src/client.ts` the small helper both use to reach the running blimpd on
its socket. Parts 2 (jobs and reports) and 3 (the apps) get their own plans later.

**Tech Stack:** Bun + TypeScript (blimpd), `bun test`, real zmx in the server tests (a private socket folder,
`test/setup.ts`), a fake `claude` that prints its arguments.

**Spec:** `docs/superpowers/specs/2026-10-26-assistant-design.md` (sections 1 and 2, build step 1).

## Global Constraints

- Work in the worktree `/Users/mbeato/blimp-assistant`, branch `assistant`. Never in `/Users/mbeato/blimp`
  (another session works there on `phone-feed`).
- Commits: plain sentences with an area prefix (`blimpd: …`, `Docs: …`). Never a `Co-Authored-By` line or any
  Claude attribution.
- bun is at `~/.bun/bin/bun` and not on PATH. Run tests as `PATH=$HOME/.bun/bin:$PATH bun test <files>` (some
  tests start bun as a subprocess).
- Exact values (from the spec): session name `assistant`; folder `<socket dir>/assistant`; config key
  `"assistant": true` in `<socket dir>/config.json`; keep-alive every 5 s; 3 starts within 2 minutes → wait
  10 minutes; `--permission-mode default` and `permissions.defaultMode: "default"`; `read` default 20 messages.
- Comments and messages follow the repo's voice: plain sentences, say what a thing does, no marketing words.
  Error output is `blimpd <command>: <error>` on stderr, exit 1.
- `blimp.md` is written for any blimp user (the repo is open source): it says "the user", never "Max", and
  names no tool only Max has (no recense).
- Not in this part: `--job`, the jobs file, reports, push changes, `GET`/`PUT /assistant`, the events message,
  anything in `app/` or `ios/`.

## File map

- Modify `src/names.ts`: `readConfig` knows `assistant`; new `saveConfig`.
- Create `src/assistant.ts`: folder, files, switch, keep-alive, `blimpd assistant`.
- Modify `src/sessions.ts`: `StartOptions.exact`.
- Modify `src/server.ts`: `startAssistant()` in `serve()`.
- Create `src/client.ts`: `callBlimpd`, `getJson`.
- Modify `src/widget.ts`: export `widgetState`.
- Create `src/overview.ts`: `overviewText`, `messagesText`, `runOverview`, `runRead`.
- Create `src/act.ts`: `runStart`, `runAnswer`.
- Modify `src/main.ts`: the five new commands and the usage line.
- Tests: `test/assistant.test.ts` (new), `test/overview.test.ts` (new), `test/real-claude-assistant.test.ts`
  (new, opt-in), `test/server.test.ts`.
- Docs: `docs/DESIGN.md`, `docs/SECURITY.md`, `README.md`.

---

### Task 1: The assistant's folder, files and switch

**Files:**
- Modify: `src/names.ts:29-31` (readConfig, namesOn)
- Create: `src/assistant.ts`
- Test: `test/assistant.test.ts`

**Interfaces:**
- Consumes: `configFile()`, `readConfig()` from `src/names.ts`; `blimpDir()`, `realDir()` from
  `src/sessions.ts`; `projectFolderName()` from `src/folders.ts`.
- Produces:
  - `saveConfig(patch: Record<string, unknown>, file?: string): void` (in `src/names.ts`)
  - `ASSISTANT = "assistant"`
  - `assistantDir(): string`
  - `assistantOn(file?: string): boolean`
  - `blimpMd(cmd: string): string`
  - `CLAUDE_MD: string`
  - `assistantSettings(cmd: string): { permissions: { defaultMode: "default"; allow: string[]; ask: string[] } }`
  - `writeAssistantFiles(dir: string, self: string[]): void`
  - `hasConversation(dir: string, claude: string): boolean`

- [ ] **Step 1: Write the failing test**

Create `test/assistant.test.ts`:

```ts
// The assistant (src/assistant.ts): its folder's files, its permission rules, the switch, and the keep-alive.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assistantOn, assistantSettings, blimpMd, CLAUDE_MD, hasConversation, writeAssistantFiles } from "../src/assistant";
import { projectFolderName } from "../src/folders";
import { readConfig, saveConfig } from "../src/names";

const fresh = () => realpathSync(mkdtempSync(join(tmpdir(), "blimp-assistant-")));

describe("assistantSettings", () => {
  test("act commands and send tools ask, under the bare name and blimpd's own path; look commands and home reads are allowed", () => {
    const s = assistantSettings("/opt/blimpd");
    expect(s.permissions.defaultMode).toBe("default");
    for (const sub of ["start:*", "send:*", "answer:*"]) {
      expect(s.permissions.ask).toContain(`Bash(blimpd ${sub})`);
      expect(s.permissions.ask).toContain(`Bash(/opt/blimpd ${sub})`);
    }
    expect(s.permissions.ask).toContain("mcp__claude_ai_Gmail__send_message");
    expect(s.permissions.ask).toContain("mcp__claude_ai_Slack__slack_send_message");
    expect(s.permissions.allow).toEqual(["Bash(blimpd overview)", "Bash(/opt/blimpd overview)", "Bash(blimpd read:*)", "Bash(/opt/blimpd read:*)", "Read(~/**)"]);
    expect(s.permissions.allow.filter((r) => s.permissions.ask.includes(r))).toEqual([]);
  });

  test("blimpd on PATH as plain blimpd: each rule once", () => {
    const s = assistantSettings("blimpd");
    expect(s.permissions.ask.filter((r) => r === "Bash(blimpd send:*)")).toHaveLength(1);
    expect(s.permissions.allow.filter((r) => r === "Bash(blimpd overview)")).toHaveLength(1);
  });
});

describe("blimpMd", () => {
  test("names every command with blimpd's own path, says which ones ask, and the browser rule; for any user", () => {
    const md = blimpMd("/opt/blimpd");
    for (const c of ["overview", "read <session or conversation id>", "start <folder> <message>", "send <session> <message>", "answer <session> <option number>"])
      expect(md).toContain(`\`/opt/blimpd ${c}`);
    // The file wraps its lines; the sentences are checked with the line breaks taken out.
    const flat = md.replace(/\s+/g, " ");
    expect(flat).toContain("each one shows the user a permission prompt first");
    expect(flat).toContain("Before anything that buys, books, sends, posts, signs up or accepts terms, stop and ask in the chat");
    expect(md).not.toContain("Max");
    expect(md).not.toContain("recense");
  });
});

describe("writeAssistantFiles", () => {
  test("blimp.md and the settings every time, CLAUDE.md only when missing, settings.local.json never", () => {
    const dir = join(fresh(), "assistant");
    writeAssistantFiles(dir, ["/opt/blimpd"]);
    expect(readFileSync(join(dir, "blimp.md"), "utf8")).toBe(blimpMd("/opt/blimpd"));
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe(CLAUDE_MD);
    expect(CLAUDE_MD).toStartWith("@blimp.md\n");
    expect(JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"))).toEqual(assistantSettings("/opt/blimpd"));
    expect(statSync(dir).mode & 0o777).toBe(0o700);

    writeFileSync(join(dir, "CLAUDE.md"), "@blimp.md\nmine\n");
    writeFileSync(join(dir, "blimp.md"), "old");
    writeFileSync(join(dir, ".claude", "settings.local.json"), '{"mine":true}');
    writeAssistantFiles(dir, ["/usr/bin/bun", "/src/main.ts"]);
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe("@blimp.md\nmine\n");
    expect(readFileSync(join(dir, "blimp.md"), "utf8")).toBe(blimpMd("/usr/bin/bun /src/main.ts"));
    expect(readFileSync(join(dir, ".claude", "settings.local.json"), "utf8")).toBe('{"mine":true}');
    expect(existsSync(join(dir, "blimp.md.tmp"))).toBe(false);
  });
});

describe("hasConversation", () => {
  test("only once Claude's projects folder for it has a transcript", () => {
    const root = fresh();
    const dir = join(root, "assistant");
    mkdirSync(dir);
    const claude = join(root, "claude");
    expect(hasConversation(dir, claude)).toBe(false);
    const folder = join(claude, "projects", projectFolderName(dir));
    mkdirSync(folder, { recursive: true });
    expect(hasConversation(dir, claude)).toBe(false);
    writeFileSync(join(folder, "notes.txt"), "");
    expect(hasConversation(dir, claude)).toBe(false);
    writeFileSync(join(folder, "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1.jsonl"), "");
    expect(hasConversation(dir, claude)).toBe(true);
  });
});

describe("the switch", () => {
  test("off unless config.json says assistant: true; saveConfig keeps the other settings, 600", () => {
    const file = join(fresh(), "config.json");
    expect(assistantOn(file)).toBe(false);
    writeFileSync(file, JSON.stringify({ names: false }));
    expect(assistantOn(file)).toBe(false);
    saveConfig({ assistant: true }, file);
    expect(readConfig(file)).toEqual({ names: false, assistant: true });
    expect(assistantOn(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    saveConfig({ assistant: "yes" }, file);
    expect(assistantOn(file)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/mbeato/blimp-assistant && PATH=$HOME/.bun/bin:$PATH bun test test/assistant.test.ts`
Expected: FAIL, `Cannot find module '../src/assistant'` (and `saveConfig` not exported).

- [ ] **Step 3: Add `saveConfig` to `src/names.ts`**

Replace lines 29-31 (`readConfig` and `namesOn`) with:

```ts
// <socket dir>/config.json: blimpd's settings. Missing or not a JSON object: all defaults.
export const readConfig = (file = configFile()): { names?: unknown; assistant?: unknown } => readJson(file);
export const namesOn = (file = configFile()) => readConfig(file).names !== false;

// Changes some settings and keeps the rest: through a temp file and a rename, 600.
export function saveConfig(patch: Record<string, unknown>, file = configFile()) {
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify({ ...readJson(file), ...patch }), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}
```

(`chmodSync`, `renameSync` and `writeFileSync` are already imported in `src/names.ts`.)

- [ ] **Step 4: Create `src/assistant.ts`**

```ts
// The assistant (docs/superpowers/specs/2026-10-26-assistant-design.md): one Claude session, named `assistant`, that
// blimpd keeps running in <socket dir>/assistant, a folder that isn't a project. It looks at every project with
// `blimpd overview` and `blimpd read`, and acts on another session only with `blimpd start`, `send` or `answer`,
// each of which its folder's settings make Claude ask the user about first. Off unless config.json says
// {"assistant": true}.

import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectFolderName } from "./folders";
import { configFile, readConfig } from "./names";
import { blimpDir, realDir } from "./sessions";

export const ASSISTANT = "assistant";
export const assistantDir = () => join(blimpDir(), "assistant");
export const assistantOn = (file = configFile()) => readConfig(file).assistant === true;

// What the assistant is told, written on every start so a new blimpd can change it. cmd: this blimpd, as the
// session runs it. For any blimp user: no names, no tools only some people have.
export const blimpMd = (cmd: string) => `# The blimp assistant

You are the user's assistant in blimp, the app they use to run Claude Code sessions on this server. You aren't
tied to a project: they come here for general questions, errands in the browser, and anything across their
projects. blimp keeps this session running, so this one chat carries on and there's no need to wrap up.

## Look freely

- \`${cmd} overview\`: every project, its running sessions (name, title, state, note), what each waiting
  session asks with its numbered options, and unread past conversations with their ids.
- \`${cmd} read <session or conversation id> [--last N]\`: its latest messages (20 unless you say).
- Any file in the home folder, with your normal tools.

Use these whenever a question is about the user's sessions or projects, rather than guessing.

## Ask before you act

These change another session, so each one shows the user a permission prompt first:

- \`${cmd} start <folder> <message>\`: a new Claude session in that folder (give its full path), with that first
  message.
- \`${cmd} send <session> <message>\`: type a message into a running session.
- \`${cmd} answer <session> <option number>\`: pick one of a session's options, numbered as overview shows them.

Don't get around the prompt with other commands that do the same thing (curl to blimpd's socket, zmx, typing
into a terminal). Hand bigger work to a project session with \`start\` instead of doing it here, so this chat
stays quick.

## The browser

Your browser tabs are yours, but they share the user's logins with every blimp tab. When a site needs a login,
ask the user to sign in themselves in your tab; never ask for a password in the chat. Before anything that buys,
books, sends, posts, signs up or accepts terms, stop and ask in the chat, saying exactly what you'll do.

## Memory

If your instructions give you a memory tool, keep what's worth remembering there: this chat is compacted as it
grows, and older details fade.
`;

// Written once; the rest of the file is the user's.
export const CLAUDE_MD = `@blimp.md

<!-- blimp wrote this file once and won't change it again. Add your own instructions for the assistant below. -->
`;

// Tools that send something as the user: connectors' send actions ask first, as the act commands do.
const SEND_TOOLS = [
  "mcp__claude_ai_Gmail__send_message",
  "mcp__claude_ai_Gmail__reply",
  "mcp__claude_ai_Gmail__forward",
  "mcp__claude_ai_Slack__slack_send_message",
  "mcp__claude_ai_Slack__slack_schedule_message",
  "mcp__claude_ai_Zapier__execute_zapier_write_action",
];

// The folder's Claude settings. Each command rule is there under the bare name (blimpd on PATH) and under the
// command blimpd runs from, since Claude matches the text it runs. ask beats allow, wherever an allow comes from.
export function assistantSettings(cmd: string) {
  const both = (rule: string) => [...new Set([`Bash(blimpd ${rule})`, `Bash(${cmd} ${rule})`])];
  return {
    permissions: {
      defaultMode: "default" as const,
      allow: [...both("overview"), ...both("read:*"), "Read(~/**)"],
      ask: [...both("start:*"), ...both("send:*"), ...both("answer:*"), ...SEND_TOOLS],
    },
  };
}

function writeAtomic(file: string, text: string) {
  writeFileSync(file + ".tmp", text, { mode: 0o600 });
  chmodSync(file + ".tmp", 0o600);
  renameSync(file + ".tmp", file);
}

// self: this blimpd as a command (selfCommand()). The user's own settings go in settings.local.json, which
// blimpd never touches.
export function writeAssistantFiles(dir: string, self: string[]) {
  mkdirSync(join(dir, ".claude"), { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const cmd = self.join(" ");
  writeAtomic(join(dir, "blimp.md"), blimpMd(cmd));
  writeAtomic(join(dir, ".claude", "settings.json"), JSON.stringify(assistantSettings(cmd), null, 2) + "\n");
  if (!existsSync(join(dir, "CLAUDE.md"))) writeAtomic(join(dir, "CLAUDE.md"), CLAUDE_MD);
}

// Whether Claude has a conversation in dir to --continue (it fails with none).
export function hasConversation(dir: string, claude: string): boolean {
  try {
    return readdirSync(join(claude, "projects", projectFolderName(realDir(dir)))).some((n) => n.endsWith(".jsonl"));
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /Users/mbeato/blimp-assistant && PATH=$HOME/.bun/bin:$PATH bun test test/assistant.test.ts test/names.test.ts`
Expected: PASS (all of `test/assistant.test.ts`; `test/names.test.ts` unchanged).

- [ ] **Step 6: Commit**

```bash
cd /Users/mbeato/blimp-assistant && git add src/names.ts src/assistant.ts test/assistant.test.ts && git commit -m "blimpd: the assistant's folder and files (blimp.md each start, CLAUDE.md once, settings that allow the look commands and ask before the act commands and send tools), and its switch in config.json"
```

---

### Task 2: Keep the assistant running, and `blimpd assistant on | off | status`

**Files:**
- Modify: `src/sessions.ts:456` (StartOptions) and `src/sessions.ts:465-468` (start)
- Modify: `src/assistant.ts` (add the keep-alive and the command)
- Modify: `src/server.ts` (import, and `startAssistant()` in `serve()`)
- Modify: `src/main.ts` (the `assistant` command, header comment, usage)
- Test: `test/assistant.test.ts` (keep-alive), `test/server.test.ts` (new `describe("assistant")`)

**Interfaces:**
- Consumes: Task 1's `ASSISTANT`, `assistantDir`, `assistantOn`, `writeAssistantFiles`, `hasConversation`,
  `saveConfig`; `launchFor` (`src/kinds.ts`, returns `Launch = { script?: string; args: string[]; env? }`);
  `selfCommand` (`src/browser/mcp.ts`); `startSession`, `StartOptions`, `parseZmxList`, `zmxListAsync`,
  `sessionExists`, `killSession`, `claudeDir` (`src/sessions.ts`).
- Produces:
  - `StartOptions.exact?: boolean` (the name as given, not `<folder>-<name>`)
  - `type KeepDeps = { on: () => boolean; running: () => Promise<boolean>; launch: () => Promise<Launch>; start: (dir: string, opts: StartOptions) => Promise<string>; dir: string; claude: string; self: string[]; now: () => number; log: (m: string) => void }`
  - `type KeepState = { tries: number[]; pausedUntil: number; busy: boolean }`
  - `newKeepState(): KeepState`
  - `assistantTick(deps?: KeepDeps, state?: KeepState): Promise<void>`
  - `startAssistant(every?: number): void`
  - `runAssistant(args: string[]): Promise<number>`
  - In `test/server.test.ts`: `cli(args: string[], extra?: Record<string, string>): Promise<{ code: number; out: string; err: string }>`
    (runs `bun src/main.ts <args>` against the test's blimpd; Tasks 3 and 4 use it)

- [ ] **Step 1: Write the failing unit test**

Append to `test/assistant.test.ts` (and add `assistantTick, type KeepDeps, newKeepState` to the import from
`../src/assistant`):

```ts
describe("assistantTick", () => {
  const T = 1_800_000_000_000;
  function deps(o: Partial<KeepDeps> = {}) {
    const root = fresh();
    const started: { dir: string; opts: any }[] = [];
    const logs: string[] = [];
    let now = T;
    const d: KeepDeps = {
      on: () => true,
      running: async () => false,
      launch: async () => ({ script: 'exec claude "$@"', args: ["claude", "--mcp-config", "/m.json"] }),
      start: async (dir, opts) => (started.push({ dir, opts }), "assistant"),
      dir: join(root, "assistant"),
      claude: join(root, "claude"),
      self: ["/opt/blimpd"],
      now: () => now,
      log: (m) => void logs.push(m),
      ...o,
    };
    return { d, started, logs, later: (ms: number) => void (now += ms) };
  }

  test("off, or already running: nothing starts", async () => {
    const off = deps({ on: () => false });
    await assistantTick(off.d, newKeepState());
    const up = deps({ running: async () => true });
    await assistantTick(up.d, newKeepState());
    expect([off.started, up.started]).toEqual([[], []]);
  });

  test("on and not running: its files, then a Claude session named exactly assistant in its folder, in default mode", async () => {
    const t = deps();
    await assistantTick(t.d, newKeepState());
    expect(t.started).toEqual([
      { dir: t.d.dir, opts: { name: "assistant", exact: true, kind: "claude", run: { script: 'exec claude "$@"', args: ["claude", "--mcp-config", "/m.json", "--permission-mode", "default"] } } },
    ]);
    expect(existsSync(join(t.d.dir, "blimp.md"))).toBe(true);
  });

  test("with a conversation in its folder, it continues it", async () => {
    const t = deps();
    mkdirSync(t.d.dir, { recursive: true });
    const folder = join(t.d.claude, "projects", projectFolderName(realpathSync(t.d.dir)));
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2.jsonl"), "");
    await assistantTick(t.d, newKeepState());
    expect(t.started[0].opts.run.args.slice(-3)).toEqual(["--permission-mode", "default", "--continue"]);
  });

  test("three starts within 2 minutes: it waits 10 minutes, then tries again", async () => {
    const t = deps();
    const state = newKeepState();
    for (let i = 0; i < 3; i++) {
      await assistantTick(t.d, state);
      t.later(5000);
    }
    expect(t.started).toHaveLength(3);
    await assistantTick(t.d, state);
    expect(t.started).toHaveLength(3);
    expect(t.logs).toEqual(["assistant: it stopped 3 times in 2 minutes; trying again in 10 minutes"]);
    t.later(9 * 60_000);
    await assistantTick(t.d, state);
    expect(t.started).toHaveLength(3);
    t.later(60_000);
    await assistantTick(t.d, state);
    expect(t.started).toHaveLength(4);
  });

  test("a start that fails is logged and counts as a try", async () => {
    const t = deps({ start: async () => { throw new Error("zmx didn't start assistant"); } });
    const state = newKeepState();
    await assistantTick(t.d, state);
    expect(t.logs).toEqual(["assistant: couldn't start it: zmx didn't start assistant"]);
    expect(state.tries).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/mbeato/blimp-assistant && PATH=$HOME/.bun/bin:$PATH bun test test/assistant.test.ts`
Expected: FAIL, `assistantTick` / `newKeepState` not exported.

- [ ] **Step 3: Let `startSession` take an exact name**

In `src/sessions.ts`, change line 456:

```ts
// exact: name as given (the assistant's), not <folder>-<name>; it must be a plain name no session has.
export type StartOptions = { name?: string; exact?: boolean; kind?: string; run?: Launch };
```

and in `start` (lines 465-468) replace the two lines that compute `taken` and `name`:

```ts
async function start(dir: string, { name: custom, exact, kind = "claude", run = CLAUDE }: StartOptions): Promise<string> {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`not a folder: ${dir}`);
  const taken = parseZmxList(await zmxListAsync()).map((s) => s.name);
  if (exact && (!custom || !isSafeName(custom))) throw new Error(`not a session name: ${custom}`);
  if (exact && taken.includes(custom!)) throw new Error(`a session named ${custom} is already running`);
  const name = exact ? custom! : newSessionName(dir, new Date(), taken, custom);
```

(The rest of `start` is unchanged.)

- [ ] **Step 4: Add the keep-alive and the command to `src/assistant.ts`**

Change the imports at the top of `src/assistant.ts` to:

```ts
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { selfCommand } from "./browser/mcp";
import { projectFolderName } from "./folders";
import { launchFor, type Launch } from "./kinds";
import { configFile, readConfig, saveConfig } from "./names";
import { blimpDir, claudeDir, killSession, parseZmxList, realDir, sessionExists, startSession, type StartOptions, zmxListAsync } from "./sessions";
```

Append:

```ts
// The keep-alive: every 5 s, while it's on, a session named assistant is started if there's none, continuing the
// folder's latest conversation once there is one. One that keeps stopping (3 starts within 2 minutes) waits
// 10 minutes before the next try, so a broken claude doesn't start every 5 s.
export type KeepDeps = {
  on: () => boolean;
  running: () => Promise<boolean>;
  launch: () => Promise<Launch>;
  start: (dir: string, opts: StartOptions) => Promise<string>;
  dir: string;
  claude: string;
  self: string[];
  now: () => number;
  log: (m: string) => void;
};
export type KeepState = { tries: number[]; pausedUntil: number; busy: boolean };
export const newKeepState = (): KeepState => ({ tries: [], pausedUntil: 0, busy: false });

const TRIES = 3;
const WINDOW = 2 * 60_000;
const PAUSE = 10 * 60_000;

const live = (): KeepDeps => ({
  on: () => assistantOn(),
  running: async () => parseZmxList(await zmxListAsync()).some((s) => s.name === ASSISTANT),
  launch: () => launchFor("claude"),
  start: startSession,
  dir: assistantDir(),
  claude: claudeDir(),
  self: selfCommand(),
  now: Date.now,
  log: (m) => console.log(m),
});

const keep = newKeepState();

export async function assistantTick(deps: KeepDeps = live(), state = keep): Promise<void> {
  if (state.busy || !deps.on()) return;
  state.busy = true;
  try {
    if (await deps.running()) return;
    const t = deps.now();
    if (t < state.pausedUntil) return;
    state.tries = state.tries.filter((at) => t - at < WINDOW);
    if (state.tries.length >= TRIES) {
      state.tries = [];
      state.pausedUntil = t + PAUSE;
      deps.log("assistant: it stopped 3 times in 2 minutes; trying again in 10 minutes");
      return;
    }
    state.tries.push(t);
    writeAssistantFiles(deps.dir, deps.self);
    const run = await deps.launch();
    // Default mode, whatever the user's settings say: auto mode asks nothing, and the act commands must ask.
    run.args.push("--permission-mode", "default");
    if (hasConversation(deps.dir, deps.claude)) run.args.push("--continue");
    await deps.start(deps.dir, { name: ASSISTANT, exact: true, kind: "claude", run });
  } catch (e) {
    deps.log(`assistant: couldn't start it: ${(e as Error).message}`);
  } finally {
    state.busy = false;
  }
}

export function startAssistant(every = 5000) {
  setInterval(() => void assistantTick(), every);
}

// blimpd assistant on | off | status. Off ends the session; its folder and conversations stay, and on again
// continues the latest.
export async function runAssistant(args: string[]): Promise<number> {
  const [what, ...rest] = args;
  const dir = assistantDir();
  if (rest.length || (what !== undefined && !["on", "off", "status"].includes(what))) {
    console.error("blimpd assistant: usage: blimpd assistant on | off | status");
    return 1;
  }
  if (what === "on") {
    saveConfig({ assistant: true });
    console.log(`The assistant is on. blimpd starts it within a few seconds, in ${dir}.`);
  } else if (what === "off") {
    saveConfig({ assistant: false });
    if (await sessionExists(ASSISTANT)) await killSession(ASSISTANT);
    console.log("The assistant is off. Its folder and conversations stay; turning it on again continues the latest.");
  } else {
    const running = parseZmxList(await zmxListAsync()).some((s) => s.name === ASSISTANT);
    console.log(
      !assistantOn() ? "The assistant is off." : running ? `The assistant is on and running (session ${ASSISTANT}, in ${dir}).` : "The assistant is on, but not running yet. blimpd starts it within a few seconds while blimpd runs.",
    );
  }
  return 0;
}
```

- [ ] **Step 5: Run the unit test to verify it passes**

Run: `cd /Users/mbeato/blimp-assistant && PATH=$HOME/.bun/bin:$PATH bun test test/assistant.test.ts test/sessions.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing server test**

In `test/server.test.ts`:

Add `import { projectFolderName } from "../src/folders";` to the imports.

Add after the `clients` helper (line 86):

```ts
// blimpd's commands, as a session runs them, against this test's blimpd.
const mainTs = join(import.meta.dir, "..", "src", "main.ts");
async function cli(args: string[], extra: Record<string, string> = {}) {
  const p = Bun.spawn(["bun", mainTs, ...args], { env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out: out.trim(), err: err.trim() };
}
```

Add a new describe block before `describe("hidden folders", () => {`:

```ts
describe("assistant", () => {
  const dir = join(tmp, "assistant");
  const screen = () => zmx("history", "assistant").stdout.toString();

  test("on: blimpd starts a session named assistant in its folder, in default mode; killed, it's back, continuing once there's a conversation; off ends it", async () => {
    made.push("assistant");
    expect((await cli(["assistant", "status"])).out).toBe("The assistant is off.");
    expect((await cli(["assistant", "on"])).code).toBe(0);
    await until(() => zmxNames().includes("assistant") && screen().includes("--permission-mode default]"), "the assistant session", 15000);
    expect(screen()).not.toContain("--continue");
    expect(JSON.parse(readFileSync(join(tmp, "config.json"), "utf8"))).toMatchObject({ names: false, assistant: true });
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toStartWith("@blimp.md\n");
    expect(JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8")).permissions.defaultMode).toBe("default");
    expect((await cli(["assistant", "status"])).out).toBe(`The assistant is on and running (session assistant, in ${dir}).`);

    // A conversation now, the user's own CLAUDE.md, and an old blimp.md: then it stops.
    const folder = join(tmp, "claude", "projects", projectFolderName(realpathSync(dir)));
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3.jsonl"), "");
    writeFileSync(join(dir, "CLAUDE.md"), "@blimp.md\nmine\n");
    writeFileSync(join(dir, "blimp.md"), "old");
    zmx("kill", "assistant", "--force");
    await until(() => zmxNames().includes("assistant") && screen().includes("--permission-mode default --continue]"), "the assistant back, continuing", 15000);
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe("@blimp.md\nmine\n");
    expect(readFileSync(join(dir, "blimp.md"), "utf8")).toStartWith("# The blimp assistant");

    expect((await cli(["assistant", "off"])).code).toBe(0);
    expect(zmxNames()).not.toContain("assistant");
    await Bun.sleep(6000); // more than a tick: it stays off
    expect(zmxNames()).not.toContain("assistant");
    expect((await cli(["assistant", "status"])).out).toBe("The assistant is off.");
    expect(await cli(["assistant", "maybe"])).toMatchObject({ code: 1, err: "blimpd assistant: usage: blimpd assistant on | off | status" });
  }, 45000);
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `cd /Users/mbeato/blimp-assistant && PATH=$HOME/.bun/bin:$PATH bun test test/server.test.ts -t "assistant"`
Expected: FAIL at the first `expect`: `blimpd assistant status` prints the usage line, since main.ts doesn't know
the command yet.

- [ ] **Step 8: Wire it into blimpd**

In `src/server.ts`, add to the imports, after `import { answerOnce } from "./answer";`:

```ts
import { startAssistant } from "./assistant";
```

and in `serve()`, after `startHandoffs();`:

```ts
  startAssistant(); // off unless {"assistant": true} in <socket dir>/config.json
```

In `src/main.ts`, add to the header comment after the `blimpd send` line:

```ts
//   blimpd assistant on|off|status  the assistant: one Claude session blimpd keeps running (assistant.ts)
```

add the import before `import { findChrome } from "./browser/chrome";` (the local imports are sorted by path):

```ts
import { runAssistant } from "./assistant";
```

add a branch before `} else if (cmd === "--version" || cmd === "version") {`:

```ts
} else if (cmd === "assistant") {
  process.exit(await runAssistant(args));
```

and in the usage string, after `send <session> <message> | ` add `assistant on|off|status | `.

- [ ] **Step 9: Run the server test to verify it passes**

Run: `cd /Users/mbeato/blimp-assistant && PATH=$HOME/.bun/bin:$PATH bun test test/server.test.ts -t "assistant"`
Expected: PASS. The fake claude's `args:[…]` line has `--mcp-config <file>` before `--permission-mode` when npx
and a Chrome are found, and not otherwise; the test only looks at the end of the line.

- [ ] **Step 10: Run the whole suite**

Run: `cd /Users/mbeato/blimp-assistant && PATH=$HOME/.bun/bin:$PATH bun test`
Expected: PASS, the earlier count plus the new tests. The assistant is off in every other test: the config has no
`assistant` key until this block, and this block turns it off again.

- [ ] **Step 11: Commit**

```bash
cd /Users/mbeato/blimp-assistant && git add src/sessions.ts src/assistant.ts src/server.ts src/main.ts test/assistant.test.ts test/server.test.ts && git commit -m "blimpd: keeps the assistant running while it's on (a session named exactly assistant, in default permission mode, continuing its folder's latest conversation; three starts in 2 minutes wait 10), and blimpd assistant on | off | status"
```

---

### Task 3: The look commands, `blimpd overview` and `blimpd read`

**Files:**
- Create: `src/client.ts`
- Modify: `src/widget.ts:23` (export `widgetState`)
- Create: `src/overview.ts`
- Modify: `src/main.ts` (two commands)
- Test: `test/overview.test.ts` (new), `test/server.test.ts` (in `describe("chat")`)

**Interfaces:**
- Consumes: `assistantDir()` (Task 1); `widgetState(s: Session): WidgetState | undefined` from `src/widget.ts`;
  `Session` and `listSessionsLite`, `claudeDir`, `realDir`, `transcriptPath`, `zmxListAsync`, `blimpDir`,
  `socketPath` from `src/sessions.ts`; `ChatMessage`, `newScan`, `readLast` from `src/chat.ts`; `firstCwd` from
  `src/folders.ts`; `Prompt` from `src/prompt.ts`; `ShownNote` from `src/notes.ts`. Routes `GET /sessions`,
  `GET /folders/recent` (`{ dir, lastUsed }[]`), `GET /folders/hidden` (`string[]`), `GET /conversations?dir=`.
- Produces:
  - `callBlimpd(path: string, init?: RequestInit): Promise<Response>` (throws `Error("blimpd isn't set up here (no token)")` or `Error("blimpd isn't running")`)
  - `getJson<T>(path: string): Promise<T>` (throws blimpd's `error` text)
  - `type Past = { sessionId: string; title: string; updatedAt: number; unread: boolean; note?: ShownNote }`
  - `type OverviewInput = { sessions: Session[]; folders: string[]; earlier: Map<string, Past[]>; hidden: Set<string>; skip: string; home: string; now: number }`
  - `ago(ms: number, now: number): string`
  - `asks(p: Prompt): string`
  - `overviewText(o: OverviewInput): string`
  - `messagesText(list: ChatMessage[]): string`
  - `runOverview(): Promise<number>`, `runRead(args: string[]): Promise<number>`

- [ ] **Step 1: Write the failing unit test**

Create `test/overview.test.ts`:

```ts
// What the assistant's look commands print (src/overview.ts): every project's sessions and unread past
// conversations, and a conversation's messages.

import { expect, test } from "bun:test";
import type { ChatMessage } from "../src/chat";
import { ago, asks, messagesText, overviewText, type OverviewInput, type Past } from "../src/overview";
import { promptFromHook } from "../src/prompt";
import type { Session } from "../src/sessions";

const T = 1_800_000_000_000;
const s = (name: string, o: Partial<Session> = {}): Session => ({
  name, pid: 1, clients: 0, created: (T - 3_600_000) / 1000, dir: "/u/blimp", cmd: "claude", kind: "claude",
  title: name, status: "idle", state: "done", unread: false, ...o,
});
const input = (o: Partial<OverviewInput> = {}): OverviewInput => ({
  sessions: [], folders: [], earlier: new Map(), hidden: new Set(), skip: "/u/.blimp/assistant", home: "/u", now: T, ...o,
});

test("ago: just now, minutes, hours, days", () => {
  expect([ago(T - 30_000, T), ago(T - 5 * 60_000, T), ago(T - 3 * 3_600_000, T), ago(T - 2 * 86_400_000, T)]).toEqual(["just now", "5m ago", "3h ago", "2d ago"]);
});

test("each project under its folder (~ for home), each session with its state, how long, its label and its note", () => {
  const text = overviewText(input({
    folders: ["/u/blimp", "/u/api"],
    sessions: [
      s("blimp-1", { title: "phone feed", state: "working", stateSince: T - 120_000 }),
      s("blimp-2", { title: "brand", unread: true, stateSince: T - 600_000, note: { status: "done", text: "icons rendered", at: T } }),
      s("api-1", { dir: "/u/api", title: "tests", kind: "codex", label: "Codex", stateSince: T - 60_000 }),
    ],
  }));
  expect(text).toBe([
    "~/blimp",
    '  blimp-1  "phone feed"  working, 2m ago',
    '  blimp-2  "brand"  new reply, 10m ago | note: icons rendered',
    "",
    "~/api",
    '  api-1  "tests" (Codex)  idle, 1m ago',
  ].join("\n"));
});

test("a waiting session says what it asks, with numbered options", () => {
  const prompt = { ...promptFromHook({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "ls" }, cwd: "/u/blimp" })!, at: T };
  const text = overviewText(input({ sessions: [s("blimp-1", { title: "fix", state: "waiting", stateSince: T, prompt })] }));
  expect(text).toBe(`~/blimp\n  blimp-1  "fix"  needs you, just now\n    asks: ${asks(prompt)}`);
  expect(asks(prompt)).toEndWith("| options: 1. Yes  2. No");
  expect(asks({ kind: "trust", folder: "/u/x", options: ["Yes, I trust this folder", "No, exit"], answerable: true })).toBe("whether to trust the folder /u/x | options: 1. Yes, I trust this folder  2. No, exit");
  const two = { kind: "question" as const, answerable: true, questions: [
    { question: "Which?", multiSelect: false, options: [{ label: "A" }, { label: "B" }] },
    { question: "And?", multiSelect: false, options: [{ label: "C" }] },
  ] };
  expect(asks(two)).toBe("Which? | options: 1. A  2. B (answer it in the app: it has several parts or choices)");
  expect(asks({ kind: "other", answerable: false })).toBe("something only the terminal shows (answer it in the app)");
});

test("unread past conversations no running session has open, at most 5, with their ids; hidden projects, the assistant's folder and runs left out", () => {
  const past = (id: string, o: Partial<Past> = {}): Past => ({ sessionId: id, title: `t${id}`, updatedAt: T - 3_600_000, unread: true, ...o });
  const open = s("blimp-1", { sessionId: "open" });
  const earlier = new Map([
    ["/u/blimp", [past("open"), past("read", { unread: false }), past("1", { note: { status: "done", text: "shipped", at: T } }), past("2"), past("3"), past("4"), past("5"), past("6")]],
    ["/u/secret", [past("s")]],
  ]);
  const text = overviewText(input({
    folders: ["/u/blimp", "/u/secret", "/u/.blimp/assistant"],
    hidden: new Set(["/u/secret"]),
    earlier,
    sessions: [open, s("assistant", { dir: "/u/.blimp/assistant" }), s("blimp-run", { kind: "run" })],
  }));
  expect(text).toBe([
    "~/blimp",
    '  blimp-1  "blimp-1"  idle, 1h ago',
    '  earlier 1  "t1"  unread, 1h ago | note: shipped',
    '  earlier 2  "t2"  unread, 1h ago',
    '  earlier 3  "t3"  unread, 1h ago',
    '  earlier 4  "t4"  unread, 1h ago',
    '  earlier 5  "t5"  unread, 1h ago',
  ].join("\n"));
});

test("nothing at all", () => {
  expect(overviewText(input())).toBe("Nothing is running, and nothing is unread.");
});

test("messages as you:, claude:, tool: and !, a long one cut", () => {
  const list: ChatMessage[] = [
    { id: "1", at: T, role: "user", text: "fix it" },
    { id: "2", at: T, role: "tool", name: "Bash", summary: "Ran `bun test`", input: "", error: true },
    { id: "3", at: T, role: "assistant", text: "x".repeat(2500) },
    { id: "4", at: T, role: "shell", input: "git status" },
    { id: "5", at: T, role: "compacted" },
  ];
  expect(messagesText(list)).toBe(["you: fix it", "tool: Ran `bun test` (failed)", `claude: ${"x".repeat(2000)} … (cut)`, "! git status", "(the conversation was compacted here)"].join("\n\n"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/mbeato/blimp-assistant && PATH=$HOME/.bun/bin:$PATH bun test test/overview.test.ts`
Expected: FAIL, `Cannot find module '../src/overview'`.

- [ ] **Step 3: Export `widgetState`**

In `src/widget.ts`, change line 23 `function widgetState(s: Session): WidgetState | undefined {` to:

```ts
export function widgetState(s: Session): WidgetState | undefined {
```

- [ ] **Step 4: Create `src/client.ts`**

```ts
// For blimpd's commands that run inside a session (overview, start, answer): the running blimpd, on its socket,
// with the Mac's token, as `blimpd send` reaches it.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { blimpDir, socketPath } from "./sessions";

export async function callBlimpd(path: string, init: RequestInit = {}): Promise<Response> {
  let token: string;
  try {
    token = readFileSync(join(blimpDir(), "token"), "utf8").trim();
  } catch {
    throw new Error("blimpd isn't set up here (no token)");
  }
  try {
    return await fetch(`http://blimpd${path}`, { ...init, unix: socketPath(), headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } } as any);
  } catch {
    throw new Error("blimpd isn't running");
  }
}

// A GET's JSON, or blimpd's error as the thrown message.
export async function getJson<T>(path: string): Promise<T> {
  const r = await callBlimpd(path);
  const body: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.error ?? `blimpd answered ${r.status}`);
  return body as T;
}
```

- [ ] **Step 5: Create `src/overview.ts`**

```ts
// The assistant's look commands (docs/superpowers/specs/2026-10-26-assistant-design.md, section 2), plain text for
// Claude to read. blimpd overview: every project but the hidden ones and the assistant's own folder, its running
// sessions with their state by the inbox's rules (widget.ts), what a waiting one asks with its options numbered as
// blimpd answer takes them, and its unread past conversations with their ids. It asks the running blimpd, whose
// title scans are already warm. blimpd read: a running session's or a past conversation's latest messages, read
// here from the transcript.

import { homedir } from "node:os";
import { assistantDir } from "./assistant";
import { type ChatMessage, newScan, readLast } from "./chat";
import { getJson } from "./client";
import { firstCwd } from "./folders";
import type { ShownNote } from "./notes";
import type { Prompt } from "./prompt";
import { claudeDir, listSessionsLite, realDir, type Session, transcriptPath, zmxListAsync } from "./sessions";
import { type WidgetState, widgetState } from "./widget";

export type Past = { sessionId: string; title: string; updatedAt: number; unread: boolean; note?: ShownNote };
export type OverviewInput = { sessions: Session[]; folders: string[]; earlier: Map<string, Past[]>; hidden: Set<string>; skip: string; home: string; now: number };

const WORDS: Record<WidgetState, string> = { needs: "needs you", new: "new reply", working: "working" };
const PAST_MAX = 5; // unread past conversations per project
const EARLIER_FOLDERS = 10; // the most recent projects whose past conversations are looked at

export function ago(ms: number, now: number): string {
  const m = Math.floor((now - ms) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (m < 24 * 60) return `${Math.floor(m / 60)}h ago`;
  return `${Math.floor(m / (24 * 60))}d ago`;
}

const numbered = (list: string[]) => list.map((o, i) => `${i + 1}. ${o}`).join("  ");

// What a waiting session asks, in one line. Only what blimpd answer can pick gets options without a note.
export function asks(p: Prompt): string {
  if (p.kind === "permission") return `${p.tool}: ${p.summary} | options: ${numbered(p.options)}`;
  if (p.kind === "trust") return `whether to trust the folder ${p.folder} | options: ${numbered(p.options)}`;
  if (p.kind === "question") {
    const q = p.questions[0];
    if (!q) return "a question (answer it in the app)";
    const app = p.questions.length > 1 || q.multiSelect || !p.answerable;
    return `${q.question} | options: ${numbered(q.options.map((o) => o.label))}${app ? " (answer it in the app: it has several parts or choices)" : ""}`;
  }
  return "something only the terminal shows (answer it in the app)";
}

const where = (dir: string, home: string) => (dir === home ? "~" : dir.startsWith(home + "/") ? "~" + dir.slice(home.length) : dir);

function sessionLine(s: Session, now: number): string {
  const state = widgetState(s);
  const word = state ? WORDS[state] : s.kind === "shell" ? "shell" : s.state === "done" ? "idle" : s.state;
  let line = `${s.name}  "${s.title}"${s.label ? ` (${s.label})` : ""}  ${word}, ${ago(s.stateSince ?? s.updatedAt ?? s.created * 1000, now)}`;
  if (s.note) line += ` | note: ${s.note.text}`;
  if (s.state === "waiting" && s.prompt) line += `\n    asks: ${asks(s.prompt)}`;
  return line;
}

const pastLine = (c: Past, now: number) => `earlier ${c.sessionId}  "${c.title}"  unread, ${ago(c.updatedAt, now)}${c.note ? ` | note: ${c.note.text}` : ""}`;

// Projects in the order of folders (newest first), then any other folder a session runs in.
export function overviewText(o: OverviewInput): string {
  const shown = (dir: string) => dir !== o.skip && !o.hidden.has(dir);
  const live = o.sessions.filter((s) => shown(s.dir) && s.kind !== "run");
  const open = new Set(live.map((s) => s.sessionId));
  const blocks: string[] = [];
  for (const dir of new Set([...o.folders, ...live.map((s) => s.dir)])) {
    if (!shown(dir)) continue;
    const rows = live.filter((s) => s.dir === dir).map((s) => sessionLine(s, o.now));
    const past = (o.earlier.get(dir) ?? []).filter((c) => c.unread && !open.has(c.sessionId)).slice(0, PAST_MAX).map((c) => pastLine(c, o.now));
    if (rows.length || past.length) blocks.push([where(dir, o.home), ...[...rows, ...past].map((r) => "  " + r)].join("\n"));
  }
  return blocks.length ? blocks.join("\n\n") : "Nothing is running, and nothing is unread.";
}

const CLIP = 2000;
const clip = (s: string) => {
  const chars = Array.from(s);
  return chars.length > CLIP ? chars.slice(0, CLIP).join("") + " … (cut)" : s;
};

export function messagesText(list: ChatMessage[]): string {
  return list
    .map((m) => {
      if (m.role === "user") return `you: ${clip(m.text)}`;
      if (m.role === "assistant") return `claude: ${clip(m.text)}`;
      if (m.role === "tool") return `tool: ${m.summary}${m.error ? " (failed)" : ""}`;
      if (m.role === "shell") return `! ${m.input}`;
      return "(the conversation was compacted here)";
    })
    .join("\n\n");
}

export async function runOverview(): Promise<number> {
  try {
    const [sessions, folders, hidden] = await Promise.all([
      getJson<Session[]>("/sessions"),
      getJson<{ dir: string }[]>("/folders/recent"),
      getJson<string[]>("/folders/hidden"),
    ]);
    const recent = folders.map((f) => f.dir);
    const dirs = [...new Set([...recent.slice(0, EARLIER_FOLDERS), ...sessions.map((s) => s.dir)])];
    const earlier = new Map(await Promise.all(dirs.map(async (d) => [d, await getJson<Past[]>(`/conversations?dir=${encodeURIComponent(d)}`)] as const)));
    console.log(overviewText({ sessions, folders: recent, earlier, hidden: new Set(hidden), skip: realDir(assistantDir()), home: realDir(homedir()), now: Date.now() }));
    return 0;
  } catch (e) {
    console.error(`blimpd overview: ${(e as Error).message}`);
    return 1;
  }
}

export async function runRead(args: string[]): Promise<number> {
  const fail = (m: string) => (console.error(`blimpd read: ${m}`), 1);
  const [target, flag, count, ...rest] = args;
  const n = flag === undefined ? 20 : Number(count);
  if (!target || (flag !== undefined && flag !== "--last") || rest.length || !Number.isInteger(n) || n < 1 || n > 200)
    return fail("usage: blimpd read <session or conversation id> [--last N] (N from 1 to 200)");
  let file: string | undefined;
  let dir = "";
  if (/^[0-9a-f-]{36}$/.test(target)) {
    file = transcriptPath(claudeDir(), target);
    if (!file) return fail(`no conversation ${target}`);
    dir = firstCwd(file) ?? "";
  } else {
    const s = listSessionsLite(claudeDir(), await zmxListAsync()).find((x) => x.name === target);
    if (!s) return fail(`no session named ${target}`);
    if (!s.transcript) return fail(`${target} has no Claude conversation to read`);
    file = s.transcript;
    dir = s.dir;
  }
  const list = await readLast(file, newScan(dir), n);
  console.log(list.length ? messagesText(list) : "(no messages yet)");
  return 0;
}
```

- [ ] **Step 6: Run the unit test to verify it passes**

Run: `cd /Users/mbeato/blimp-assistant && PATH=$HOME/.bun/bin:$PATH bun test test/overview.test.ts test/widget.test.ts`
Expected: PASS.

- [ ] **Step 7: Wire the commands into `src/main.ts`**

Header comment, after the `blimpd assistant` line:

```ts
//   blimpd overview            every project's sessions and unread past conversations, for the assistant (overview.ts)
//   blimpd read <session or conversation id> [--last N]  its latest messages (overview.ts)
```

Import, after `import { CODEX_HOOKS, codexHooksFile, installHooks, runHook, uninstallHooks } from "./hooks";`:

```ts
import { runOverview, runRead } from "./overview";
```

Branches, after the `assistant` branch:

```ts
} else if (cmd === "overview") {
  process.exit(await runOverview());
} else if (cmd === "read") {
  process.exit(await runRead(args));
```

Usage string: after `assistant on|off|status | ` add `overview | read <session or conversation id> [--last N] | `.

- [ ] **Step 8: Write the server tests**

In `test/server.test.ts`, inside `describe("chat", () => {`, just before its closing `});` (the line before
`describe("starting sessions", () => {`), add:

```ts
  test("blimpd overview lists a project's sessions with their state, and what a waiting one asks, numbered", async () => {
    const sid = "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e";
    const { name } = await fakeClaude("ov1", sid, [user("u1", "fix the login"), said("a1", "fixed")]);
    mkdirSync(join(tmp, "status"), { recursive: true });
    const status = join(tmp, "status", `${name}.json`);
    const prompt = promptFromHook({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "ls" }, cwd: tmp });
    writeFileSync(status, JSON.stringify({ state: "waiting", at: Date.now(), sessionId: sid, event: "PermissionRequest", prompt }));
    await until(async () => (await listed(name))?.prompt?.options?.length === 2, "the prompt's options");
    const r = await cli(["overview"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`  ${name}  "fix the login"  needs you, `);
    expect(r.out).toContain("    asks: Bash: ");
    expect(r.out).toContain("| options: 1. Yes  2. No");
    rmSync(status);
  }, 20000);

  test("blimpd read prints a session's latest messages, and a past conversation's by its id", async () => {
    const sid = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";
    const { name } = await fakeClaude("read1", sid, [user("u1", "one"), said("a1", "two"), user("u2", "three")]);
    expect(await cli(["read", name, "--last", "2"])).toEqual({ code: 0, out: "claude: two\n\nyou: three", err: "" });
    expect((await cli(["read", sid])).out).toBe("you: one\n\nclaude: two\n\nyou: three");
    expect(await cli(["read", `${tag}-nope`])).toMatchObject({ code: 1, err: `blimpd read: no session named ${tag}-nope` });
    expect((await cli(["read", name, "--last", "0"])).code).toBe(1);
  }, 20000);
```

- [ ] **Step 9: Run them**

Run: `cd /Users/mbeato/blimp-assistant && PATH=$HOME/.bun/bin:$PATH bun test test/server.test.ts -t "blimpd overview|blimpd read"`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
cd /Users/mbeato/blimp-assistant && git add src/client.ts src/widget.ts src/overview.ts src/main.ts test/overview.test.ts test/server.test.ts && git commit -m "blimpd: the assistant's look commands: blimpd overview (every project's sessions by the inbox's rules, what a waiting one asks with numbered options, unread past conversations) and blimpd read (a session's or a past conversation's latest messages)"
```

---

### Task 4: The act commands, `blimpd start` and `blimpd answer`

**Files:**
- Create: `src/act.ts`
- Modify: `src/main.ts` (two commands)
- Test: `test/server.test.ts` (in `describe("chat")` and `describe("starting sessions")`)

**Interfaces:**
- Consumes: `callBlimpd`, `getJson` (Task 3); `cli` test helper (Task 2); `choiceLabel(p: Prompt, pick: number): string | undefined` from
  `src/prompt.ts` (pick is 0-based); routes `POST /sessions { dir, prompt }` → `201 { name }`,
  `POST /sessions/<name>/answer { at, pick, label }` → `200 { id }` or `409 { error }`, `GET /sessions`.
- Produces: `runStart(args: string[]): Promise<number>`, `runAnswer(args: string[]): Promise<number>`

- [ ] **Step 1: Write the failing server tests**

In `test/server.test.ts`, inside `describe("chat", () => {` after the Task 3 tests, add:

```ts
  test("blimpd answer picks a waiting session's option by its number, as the phone does; not when nothing is asked", async () => {
    const sid = "0d0d0d0d-0d0d-4d0d-8d0d-0d0d0d0d0d0d";
    const { name } = await fakeClaude("ans1", sid, []);
    const viewer = await socket(`/sessions/${name}/attach?cols=80&rows=24`);
    expect(await cli(["answer", name, "1"])).toMatchObject({ code: 1, err: `blimpd answer: ${name} isn't asking anything` });
    mkdirSync(join(tmp, "status"), { recursive: true });
    const status = join(tmp, "status", `${name}.json`);
    const prompt = promptFromHook({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "ls" }, cwd: tmp });
    writeFileSync(status, JSON.stringify({ state: "waiting", at: Date.now(), sessionId: sid, event: "PermissionRequest", prompt }));
    await until(async () => (await listed(name))?.prompt?.options?.length === 2, "the prompt's options");
    expect(await cli(["answer", name, "3"])).toMatchObject({ code: 1, err: `blimpd answer: ${name}'s question has no option 3` });
    expect(await cli(["answer", name, "x"])).toMatchObject({ code: 1, err: "blimpd answer: usage: blimpd answer <session> <option number>" });
    expect(await cli(["answer", name, "1"])).toMatchObject({ code: 0, out: `answered ${name}: Yes` });
    await enterUntil(viewer, "got:1", "the digit reached the session");
    rmSync(status);
    viewer.ws.close();
  }, 20000);
```

In `describe("starting sessions", () => {`, after the test "a first message goes to Claude as its prompt, cleaned,
after --", add:

```ts
  test("blimpd start starts a Claude session in a folder with its first message", async () => {
    const dir = join(homeDir, tag);
    mkdirSync(dir, { recursive: true });
    const r = await cli(["start", dir, "look", "at", "the", "logs"]);
    expect(r.code).toBe(0);
    const name = r.out.match(/^started (\S+) in /)![1];
    made.push(name);
    expect(r.out).toBe(`started ${name} in ${dir}`);
    const s = await socket(`/sessions/${name}/attach?cols=100&rows=30`);
    await until(() => s.text.includes("-- look at the logs]"), "the first message in Claude's arguments");
    s.ws.close();
    expect(await cli(["start", dir])).toMatchObject({ code: 1, err: "blimpd start: usage: blimpd start <folder> <first message>" });
    expect((await cli(["start", join(tmp, "elsewhere"), "hi"])).code).toBe(1);
  }, 15000);
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/mbeato/blimp-assistant && PATH=$HOME/.bun/bin:$PATH bun test test/server.test.ts -t "blimpd answer|blimpd start"`
Expected: FAIL (the usage line prints instead: unknown command, exit 1).

- [ ] **Step 3: Create `src/act.ts`**

```ts
// The assistant's act commands besides blimpd send (docs/superpowers/specs/2026-10-26-assistant-design.md,
// section 2). The assistant's folder settings make Claude ask the user before running either. They go through
// the running blimpd, so its rules hold: a folder inside home, a cleaned first message, and an answer only to the
// question still on screen, by its choice's text.

import { resolve } from "node:path";
import { callBlimpd, getJson } from "./client";
import { choiceLabel, type Prompt } from "./prompt";

const errorOf = async (r: Response) => ((await r.json().catch(() => ({}))) as any)?.error ?? `blimpd answered ${r.status}`;

// blimpd start <folder> <first message…>: a new Claude session there.
export async function runStart(args: string[]): Promise<number> {
  const fail = (m: string) => (console.error(`blimpd start: ${m}`), 1);
  const [folder, ...words] = args;
  const text = words.join(" ");
  if (!folder || !text.trim()) return fail("usage: blimpd start <folder> <first message>");
  const dir = resolve(folder);
  try {
    const r = await callBlimpd("/sessions", { method: "POST", body: JSON.stringify({ dir, prompt: text }) });
    if (!r.ok) return fail(await errorOf(r));
    console.log(`started ${((await r.json()) as { name: string }).name} in ${dir}`);
    return 0;
  } catch (e) {
    return fail((e as Error).message);
  }
}

// blimpd answer <session> <option number>: option N (from 1, as overview numbers them) of what it asks now.
export async function runAnswer(args: string[]): Promise<number> {
  const fail = (m: string) => (console.error(`blimpd answer: ${m}`), 1);
  const [name, option, ...rest] = args;
  const n = Number(option);
  if (!name || rest.length || !Number.isInteger(n) || n < 1) return fail("usage: blimpd answer <session> <option number>");
  try {
    const sessions = await getJson<{ name: string; state: string; prompt?: Prompt & { at: number } }[]>("/sessions");
    const s = sessions.find((x) => x.name === name);
    if (!s) return fail(`no session named ${name}`);
    const p = s.state === "waiting" ? s.prompt : undefined;
    if (!p) return fail(`${name} isn't asking anything`);
    if (!p.answerable || (p.kind === "question" && (p.questions.length > 1 || p.questions[0]?.multiSelect)))
      return fail(`${name}'s question needs the app: it has several parts or choices`);
    const label = choiceLabel(p, n - 1);
    if (label === undefined) return fail(`${name}'s question has no option ${n}`);
    const r = await callBlimpd(`/sessions/${encodeURIComponent(name)}/answer`, { method: "POST", body: JSON.stringify({ at: p.at, pick: n - 1, label }) });
    if (!r.ok) return fail(await errorOf(r));
    console.log(`answered ${name}: ${label}`);
    return 0;
  } catch (e) {
    return fail((e as Error).message);
  }
}
```

- [ ] **Step 4: Wire them into `src/main.ts`**

Header comment, after the `blimpd read` line:

```ts
//   blimpd start <folder> <message>  a new Claude session there with that first message (act.ts)
//   blimpd answer <session> <n>      pick option n of what a session asks (act.ts)
```

Import, before `import { runAssistant } from "./assistant";` (`./act` sorts first):

```ts
import { runAnswer, runStart } from "./act";
```

Branches, after the `read` branch:

```ts
} else if (cmd === "start") {
  process.exit(await runStart(args));
} else if (cmd === "answer") {
  process.exit(await runAnswer(args));
```

Usage string: after `read <session or conversation id> [--last N] | ` add
`start <folder> <message> | answer <session> <option number> | `.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/mbeato/blimp-assistant && PATH=$HOME/.bun/bin:$PATH bun test test/server.test.ts -t "blimpd answer|blimpd start"`
Expected: PASS.

- [ ] **Step 6: Run the whole suite**

Run: `cd /Users/mbeato/blimp-assistant && PATH=$HOME/.bun/bin:$PATH bun test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd /Users/mbeato/blimp-assistant && git add src/act.ts src/main.ts test/server.test.ts && git commit -m "blimpd: the assistant's act commands besides send: blimpd start (a Claude session in a folder with a first message) and blimpd answer (option N of what a session asks, by the phone's rules)"
```

---

### Task 5: Real Claude asks before an act command (opt-in)

This proves the settings do what the spec needs, against the real `claude` on this machine: a look command runs,
and an act command is refused even with a broad allow in force, alone or after `cd … &&`. In `-p` mode Claude
can't show a prompt, so a rule that asks becomes a refusal, listed in the result's `permission_denials`.

**Files:**
- Create: `test/real-claude-assistant.test.ts`

**Interfaces:**
- Consumes: `writeAssistantFiles(dir: string, self: string[])` (Task 1).

- [ ] **Step 1: Write the test**

```ts
// The assistant's permission rules against a real Claude Code (opt-in, BLIMP_REAL_CLAUDE=1: it uses your Claude
// account, three short haiku runs). In a folder with the assistant's files, in default mode, with a broad Bash allow
// passed in as the user's own settings might have one: a look command runs, and an act command is refused, alone
// and after `cd … &&`. In -p mode a rule that asks is a refusal (Claude can't show the prompt), listed in
// permission_denials.

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAssistantFiles } from "../src/assistant";

const on = process.env.BLIMP_REAL_CLAUDE === "1";
const root = realpathSync(mkdtempSync(join(tmpdir(), "blimp-assistant-real-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test.skipIf(!on)("a look command runs; an act command is refused, alone and after cd", async () => {
  const dir = join(root, "assistant");
  const self = [process.execPath, join(import.meta.dir, "..", "src", "main.ts")];
  writeAssistantFiles(dir, self);
  const cmd = self.join(" ");
  // From inside a Claude session, CLAUDE_* variables would change the child. A socket of its own, so a command
  // that does run reaches no live blimpd.
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE") && k !== "ZMX_SESSION")), BLIMPD_SOCKET: join(root, "blimpd.sock") };
  const run = async (command: string) => {
    const p = Bun.spawn(
      ["claude", "-p", "--model", "haiku", "--permission-mode", "default", "--output-format", "json", "--max-turns", "3",
        "--settings", JSON.stringify({ permissions: { allow: ["Bash(*)"] } }),
        `Run exactly this shell command with the Bash tool, once, and then stop: ${command}`],
      { cwd: dir, env, stdout: "pipe", stderr: "pipe" },
    );
    const [out] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    const r = JSON.parse(out);
    return (r.permission_denials ?? []).map((d: any) => String(d.tool_input?.command ?? ""));
  };
  expect(await run(`${cmd} overview`)).toEqual([]);
  expect((await run(`${cmd} send nobody hi`)).some((c: string) => c.includes(" send nobody hi"))).toBe(true);
  expect((await run(`cd /tmp && ${cmd} send nobody hi`)).some((c: string) => c.includes(" send nobody hi"))).toBe(true);
}, 180000);
```

- [ ] **Step 2: Check it's skipped by default**

Run: `cd /Users/mbeato/blimp-assistant && PATH=$HOME/.bun/bin:$PATH bun test test/real-claude-assistant.test.ts`
Expected: 1 skipped, 0 failed.

- [ ] **Step 3: Run it once for real**

Run: `cd /Users/mbeato/blimp-assistant && BLIMP_REAL_CLAUDE=1 PATH=$HOME/.bun/bin:$PATH bun test test/real-claude-assistant.test.ts`
Expected: PASS.

Stop and report if:
- the look command shows up in `permission_denials` (the project's `allow` rules aren't loaded in a folder
  Claude hasn't been trusted in, under `-p`). Report the JSON; don't loosen the test.
- either act command is missing from `permission_denials` (the `ask` rules don't beat the allow, or don't match
  the command as Claude ran it). Report the denials and Claude's `result` text. This is the case the whole design
  depends on: do not ship part 1 until it's understood.

- [ ] **Step 4: Commit**

```bash
cd /Users/mbeato/blimp-assistant && git add test/real-claude-assistant.test.ts && git commit -m "blimpd: an opt-in check against a real Claude Code that the assistant's folder settings let a look command run and refuse an act command, alone and after cd, even with a broad Bash allow"
```

---

### Task 6: Docs

**Files:**
- Modify: `docs/DESIGN.md` (new `### Assistant` after `### Sending between sessions`, before `### Files`)
- Modify: `docs/SECURITY.md` (a row in the attacker table, a bullet in Accepted)
- Modify: `README.md` (new `### The assistant` before `### Models and keys`)

- [ ] **Step 1: DESIGN.md**

Insert before the line `### Files` (the one after the `### Sending between sessions` paragraph):

```markdown
### Assistant

One Claude session, named `assistant`, that blimpd keeps running in `<socket dir>/assistant`, a folder that isn't a project (`src/assistant.ts`; design in `docs/superpowers/specs/2026-10-26-assistant-design.md`). Off unless `<socket dir>/config.json` has `"assistant": true`: `blimpd assistant on | off | status` sets it (`off` also ends the session; its folder and conversations stay).

- **Keep-alive:** every 5 s while it's on, if no session is named `assistant`, blimpd writes the folder's files and starts one: kind `claude`, the name exactly `assistant` (`startSession`'s `exact`), with `--permission-mode default` (the user's settings may run auto mode, which asks nothing), and `--continue` once Claude's projects folder for it has a transcript. Three starts within 2 minutes wait 10 minutes, logged.
- **Files:** `blimp.md` (what the assistant can do and its rules, naming this blimpd's own command) and `.claude/settings.json` are rewritten at every start; `CLAUDE.md` (`@blimp.md`, then the user's own) only when missing; `settings.local.json` never.
- **Settings:** `permissions.defaultMode: "default"`; `allow`: `blimpd overview`, `blimpd read`, `Read(~/**)`; `ask`: `blimpd start`, `send`, `answer`, and connectors' send tools (Gmail send, reply, forward; Slack send and schedule; Zapier write actions). Each command rule is there for `blimpd` and for the path blimpd runs from. `ask` beats any `allow`.
- **Look:** `blimpd overview` asks the running blimpd (`GET /sessions`, `/folders/recent`, `/folders/hidden`, `/conversations`) and prints every project but the hidden ones and the assistant's folder: each running session (not runs) with its state by the inbox's rules (`widgetState`: needs you, new reply, working; else idle or shell), how long, its kind's label and its note; what a waiting one asks, with options numbered from 1; and up to 5 unread past conversations per project (of the 10 newest projects) that no running session has open, with their ids. `blimpd read <session or conversation id> [--last N]` (20 by default, at most 200) reads the transcript here and prints `you:`, `claude:` (each cut at 2000 characters), `tool: <summary>` and `! <command>` lines.
- **Act:** `blimpd start <folder> <message…>` is `POST /sessions { dir, prompt }` (prints `started <name> in <dir>`). `blimpd answer <session> <n>` reads the session's prompt from `GET /sessions` and posts `{ at, pick: n - 1, label }` to `/sessions/<name>/answer`, so it's refused if the question changed; it takes a permission, a folder trust question or one single-choice question, and sends the rest to the app. `blimpd send` is as above. All three print `blimpd <command>: <error>` and exit 1 on failure.
- `src/client.ts` is how these reach blimpd: its socket, the Mac's token.
```

- [ ] **Step 2: SECURITY.md**

Add a row at the end of the attacker table (after the row starting `| Someone who sees your locked phone, with
blimp's rectangular widget`):

```markdown
| A hostile page, file or session output the assistant reads (prompt injection) | Get the assistant to act on your other sessions: type into one, start one, answer its question | The assistant's folder settings make Claude ask you before `blimpd start`, `send` and `answer` and before connectors' send tools, and blimpd starts it in default permission mode whatever your settings say. `ask` beats any `allow`. Read the command in the prompt before you allow it. This catches mistakes and tricks that use those commands; it isn't a wall (see Accepted). |
```

Add a bullet at the end of `## Accepted`'s list:

```markdown
- **The assistant can get around its own prompts.** It runs as you, like every session, so a command that does what `blimpd send` does another way (curl to blimpd's socket with the token, or `zmx`) wouldn't match the `ask` rules. Its instructions forbid that, and its permission prompts catch the commands it's told to use. A separate guard that checks everything it sends out is possible later. Buying, posting or signing up in its browser tabs is a rule in its instructions, not a prompt: a click on Buy looks like any other click.
```

- [ ] **Step 3: README.md**

Insert before the line `### Models and keys`:

~~~markdown
### The assistant

The assistant is one Claude chat that isn't tied to a project. Ask it general questions, send it on errands in the browser, or ask what's going on across your projects. It's off until you turn it on, on the server:

```sh
blimpd assistant on
```

- blimpd starts a Claude session named **assistant** in `~/.blimp/assistant` within a few seconds, and starts it again if it stops, carrying on the same chat. Open it like any session. The first time, Claude asks whether to trust its folder; answer Yes.
- It knows what Claude knows in every session (your own instructions and settings), and its browser tabs use the same logins as your other blimp tabs.
- It can look at every project freely: `blimpd overview` and `blimpd read`. Before it starts a session, types into one or answers one's question, Claude asks you, with the usual Allow prompt.
- Add your own instructions in `~/.blimp/assistant/CLAUDE.md`. blimp writes that file once and never changes it again.
- `blimpd assistant off` ends it. Its folder and chats stay, and turning it on again carries on the latest.
~~~

- [ ] **Step 4: Commit**

```bash
cd /Users/mbeato/blimp-assistant && git add docs/DESIGN.md docs/SECURITY.md README.md && git commit -m "Docs: the assistant (DESIGN.md's Assistant section, SECURITY.md's row and what's accepted, README's how to turn it on)"
```

---

### Task 7: Try it on this server

**Files:** none (a check of the built thing, on claude1).

- [ ] **Step 1: Full suite once more**

Run: `cd /Users/mbeato/blimp-assistant && PATH=$HOME/.bun/bin:$PATH bun test`
Expected: PASS.

- [ ] **Step 2: Report, and stop**

Don't install this blimpd over the running one, and don't run `blimpd assistant on` against the live
`~/.blimp`: the running blimpd is the released one, and turning the assistant on starts a real Claude session
on the user's account. Report to the user that part 1 is built and tested, and that trying it means running this
branch's blimpd (or a release with it), then `blimpd assistant on`. The user decides when.
