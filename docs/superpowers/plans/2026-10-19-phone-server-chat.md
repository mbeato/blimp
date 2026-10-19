# Phone app, part 1: blimpd chat features — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** blimpd can show a Claude session as chat messages and take typed messages, answers and interrupts over one WebSocket, so a phone app can drive a session without a terminal.

**Architecture:** A pure transcript-to-messages parser (`src/chat.ts`), waiting-prompt details recorded by the existing hook and completed from the screen (`src/prompt.ts`), terminal-size tracking added to `src/terminal.ts`, and a new `/sessions/<name>/chat` WebSocket (`src/chatsocket.ts`) that streams messages and keeps one zmx client attached at the Mac's size for typing.

**Tech Stack:** Bun + TypeScript, `bun test`, zmx 0.5.0, Claude Code 2.1.300.

**Spec:** `docs/superpowers/specs/2026-10-19-phone-app-design.md` (sections 2 and "What the probe found").

## Global Constraints

- Package manager: bun. Tests: `bun test` in the repo root. Never npm.
- Comments explain *why*, short, in the style of the surrounding code (see `src/sessions.ts`).
- Every zmx call gets `zmxEnv()`; every zmx session name a test makes starts with the file's tag (`blimptest-<pid>`) and is killed after.
- Chat works only for sessions where Claude Code runs: `Session.sessionId` is set. Others get `{ "type": "unreadable" }` and accept no input.
- Text typed into a session never contains ESC (`\x1b`): blimpd strips it, so a message can't end the bracketed paste early or send keys.
- `input`/`answer`/`interrupt` ids: client-made strings, 1–100 chars; blimpd remembers the last 100 per session.
- Caps: `input.text` ≤ 100 000 chars; tool `input`/`output` ≤ 20 000 chars each; `history` = last 200 messages.
- No `Co-Authored-By` lines in commits (Max's rule).

---

### Task 1: Transcript → chat messages (`src/chat.ts`)

**Files:**
- Create: `src/chat.ts`
- Test: `test/chat.test.ts`

**Interfaces:**
- Produces:
  - `type ChatMessage` (exactly as in the spec)
  - `type ChatScan = { offset: number; dir: string; tools: Map<string, ToolMessage> }`, `newScan(dir: string): ChatScan`
  - `messagesFromLine(line: string, s: ChatScan): ChatMessage[]`
  - `readAppended(file: string, s: ChatScan): ChatMessage[]` (reads complete lines added since `s.offset`)
  - `toolSummary(name: string, input: any, dir: string): string`
  - `mergeById(list: ChatMessage[], add: ChatMessage[]): ChatMessage[]` (replace by id, else append)

- [ ] **Step 1: Write the failing test**

```ts
// test/chat.test.ts
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeById, messagesFromLine, newScan, readAppended, toolSummary } from "../src/chat";

const tmp = mkdtempSync(join(tmpdir(), "blimp-chat-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const T = "2026-10-19T12:00:00.000Z";
const at = Date.parse(T);
const line = (o: object) => JSON.stringify({ timestamp: T, ...o });
const user = (uuid: string, content: unknown, extra = {}) => line({ type: "user", uuid, message: { role: "user", content }, ...extra });
const assistant = (uuid: string, content: unknown[]) => line({ type: "assistant", uuid, message: { role: "assistant", content } });

describe("messagesFromLine", () => {
  test("typed prompts and assistant text become bubbles; thinking, meta and wrappers are skipped", () => {
    const s = newScan("/home/u/p");
    expect(messagesFromLine(user("u1", "fix the bug"), s)).toEqual([{ id: "u1", at, role: "user", text: "fix the bug" }]);
    expect(messagesFromLine(user("u2", "<command-name>/clear</command-name>"), s)).toEqual([]);
    expect(messagesFromLine(user("u3", "caveat", { isMeta: true }), s)).toEqual([]);
    expect(messagesFromLine(user("u4", [{ type: "text", text: "<system-reminder>x</system-reminder>" }]), s)).toEqual([]);
    expect(messagesFromLine(assistant("a1", [{ type: "thinking", thinking: "hmm" }]), s)).toEqual([]);
    expect(messagesFromLine(assistant("a2", [{ type: "text", text: "Done. **All** green." }]), s)).toEqual([
      { id: "a2#0", at, role: "assistant", text: "Done. **All** green." },
    ]);
    expect(messagesFromLine("not json", s)).toEqual([]);
    expect(messagesFromLine(line({ type: "ai-title", aiTitle: "x" }), s)).toEqual([]);
  });

  test("a tool call is one line, and its result fills it in under the same id", () => {
    const s = newScan("/home/u/p");
    const call = messagesFromLine(assistant("a1", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "bun test\necho more" } }]), s);
    expect(call).toEqual([{ id: "a1#0", at, role: "tool", name: "Bash", summary: "Ran `bun test`", input: "bun test\necho more" }]);
    const result = messagesFromLine(user("u9", [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "3 pass" }], is_error: true }]), s);
    expect(result).toEqual([{ ...call[0], output: "3 pass", error: true }]);
  });

  test("tool input and output are capped at 20 000 characters", () => {
    const s = newScan("/");
    const [m] = messagesFromLine(assistant("a1", [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: "/x", content: "y".repeat(30000) } }]), s);
    expect((m as any).input.length).toBeLessThan(20100);
    const [r] = messagesFromLine(user("u1", [{ type: "tool_result", tool_use_id: "t1", content: "z".repeat(30000) }]), s);
    expect((r as any).output.length).toBeLessThan(20100);
  });
});

test("toolSummary", () => {
  const d = "/home/u/p";
  expect(toolSummary("Edit", { file_path: "/home/u/p/src/a.ts" }, d)).toBe("Edited src/a.ts");
  expect(toolSummary("Write", { file_path: "/etc/x" }, d)).toBe("Wrote /etc/x");
  expect(toolSummary("Read", { file_path: "/home/u/p/README.md" }, d)).toBe("Read README.md");
  expect(toolSummary("Grep", { pattern: "TODO" }, d)).toBe("Searched for TODO");
  expect(toolSummary("Glob", { pattern: "**/*.ts" }, d)).toBe("Searched for **/*.ts");
  expect(toolSummary("Task", { description: "find callers" }, d)).toBe("Agent: find callers");
  expect(toolSummary("Agent", { description: "review" }, d)).toBe("Agent: review");
  expect(toolSummary("Bash", { command: "x".repeat(200) }, d)).toBe("Ran `" + "x".repeat(80) + "`");
  expect(toolSummary("WebFetch", {}, d)).toBe("WebFetch");
});

test("readAppended reads only complete lines added since the last read", () => {
  const file = join(tmp, "t.jsonl");
  writeFileSync(file, user("u1", "one") + "\n" + user("u2", "tw"));
  const s = newScan("/");
  expect(readAppended(file, s).map((m) => m.id)).toEqual(["u1"]); // u2's line isn't finished
  // Claude finishes writing the line.
  writeFileSync(file, user("u1", "one") + "\n" + user("u2", "two") + "\n");
  expect(readAppended(file, s).map((m) => m.id)).toEqual(["u2"]);
  expect(readAppended(file, s)).toEqual([]);
});

test("mergeById replaces by id and appends new ones", () => {
  const a = { id: "1", at: 0, role: "user" as const, text: "a" };
  const b = { id: "2", at: 0, role: "user" as const, text: "b" };
  expect(mergeById([a, b], [{ ...a, text: "A" }, { id: "3", at: 0, role: "user", text: "c" }]).map((m: any) => m.text)).toEqual(["A", "b", "c"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/chat.test.ts`
Expected: FAIL, "Cannot find module '../src/chat'"

- [ ] **Step 3: Write the implementation**

```ts
// src/chat.ts
// A Claude transcript as chat messages, for the phone (docs/DESIGN.md, Chat). The transcript is
// Claude Code's internal format: each content block is its own entry, tool results come back as
// user entries. Only what a person would see in a chat app is kept: what you typed, what Claude
// said, and one line per tool call.

import { closeSync, openSync, readSync, statSync } from "node:fs";

export type ToolMessage = { id: string; at: number; role: "tool"; name: string; summary: string; input: string; output?: string; error?: boolean };
export type ChatMessage =
  | { id: string; at: number; role: "user"; text: string }
  | { id: string; at: number; role: "assistant"; text: string }
  | ToolMessage;

// tools: tool_use id -> its message, so a later result can fill it in.
export type ChatScan = { offset: number; dir: string; tools: Map<string, ToolMessage> };
export const newScan = (dir: string): ChatScan => ({ offset: 0, dir, tools: new Map() });

const CAP = 20_000;
const cap = (s: string) => (s.length > CAP ? s.slice(0, CAP) + "\n… (cut)" : s);
const str = (v: unknown) => (typeof v === "string" ? v : "");

// Command wrappers (<command-name>), command output and system reminders all start with a tag;
// what a person types doesn't (the same rule titles use).
const typed = (t: unknown): t is string => typeof t === "string" && t.trim() !== "" && !t.startsWith("<");

const rel = (p: string, dir: string) => (dir && p.startsWith(dir + "/") ? p.slice(dir.length + 1) : p);

export function toolSummary(name: string, input: any, dir: string): string {
  switch (name) {
    case "Bash":
      return `Ran \`${str(input?.command).split("\n")[0].slice(0, 80)}\``;
    case "Edit":
    case "MultiEdit":
      return `Edited ${rel(str(input?.file_path), dir)}`;
    case "NotebookEdit":
      return `Edited ${rel(str(input?.notebook_path), dir)}`;
    case "Write":
      return `Wrote ${rel(str(input?.file_path), dir)}`;
    case "Read":
      return `Read ${rel(str(input?.file_path), dir)}`;
    case "Grep":
    case "Glob":
      return `Searched for ${str(input?.pattern)}`;
    case "Task":
    case "Agent":
      return `Agent: ${str(input?.description)}`;
    default:
      return name;
  }
}

const toolInput = (name: string, input: any) => cap(name === "Bash" ? str(input?.command) : JSON.stringify(input ?? {}, null, 2));

function resultText(c: unknown): string {
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c.map((b: any) => (b?.type === "text" ? str(b.text) : b?.type === "image" ? "[image]" : "")).join("\n");
}

export function messagesFromLine(line: string, s: ChatScan): ChatMessage[] {
  let r: any;
  try {
    r = JSON.parse(line);
  } catch {
    return [];
  }
  const at = Date.parse(r?.timestamp) || 0;
  const c = r?.message?.content;
  const out: ChatMessage[] = [];
  if (r?.type === "user" && !r.isMeta) {
    if (typeof c === "string") return typed(c) ? [{ id: r.uuid, at, role: "user", text: c }] : [];
    if (!Array.isArray(c)) return [];
    c.forEach((b: any, i: number) => {
      if (b?.type === "text" && typed(b.text)) out.push({ id: `${r.uuid}#${i}`, at, role: "user", text: b.text });
      if (b?.type === "tool_result") {
        const t = s.tools.get(b.tool_use_id);
        if (!t) return;
        t.output = cap(resultText(b.content));
        if (b.is_error) t.error = true;
        out.push({ ...t });
      }
    });
  } else if (r?.type === "assistant" && Array.isArray(c)) {
    c.forEach((b: any, i: number) => {
      const id = `${r.uuid}#${i}`;
      if (b?.type === "text" && str(b.text).trim()) out.push({ id, at, role: "assistant", text: b.text });
      if (b?.type === "tool_use") {
        const t: ToolMessage = { id, at, role: "tool", name: str(b.name), summary: toolSummary(str(b.name), b.input, s.dir), input: toolInput(b.name, b.input) };
        s.tools.set(b.id, t);
        out.push({ ...t });
      }
    });
  }
  return out;
}

// Transcripts only grow. Read the complete lines added since the last read; an unfinished last
// line is read next time, once it ends.
export function readAppended(file: string, s: ChatScan): ChatMessage[] {
  const size = statSync(file).size;
  if (size < s.offset) Object.assign(s, newScan(s.dir)); // rewritten shorter: start over
  if (size === s.offset) return [];
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(size - s.offset);
    const n = readSync(fd, buf, 0, buf.length, s.offset);
    const end = buf.lastIndexOf(10, n - 1);
    if (end < 0) return [];
    s.offset += end + 1;
    return buf
      .toString("utf8", 0, end)
      .split("\n")
      .flatMap((l) => messagesFromLine(l, s));
  } finally {
    closeSync(fd);
  }
}

export function mergeById(list: ChatMessage[], add: ChatMessage[]): ChatMessage[] {
  const out = [...list];
  const at = new Map(out.map((m, i) => [m.id, i]));
  for (const m of add) {
    const i = at.get(m.id);
    if (i === undefined) at.set(m.id, out.push(m) - 1);
    else out[i] = m;
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/chat.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add src/chat.ts test/chat.test.ts
git commit -m "blimpd reads a Claude transcript as chat messages"
```

---

### Task 2: Waiting prompts (`src/prompt.ts`, `src/hooks.ts`, `src/sessions.ts`)

**Files:**
- Create: `src/prompt.ts`
- Modify: `src/hooks.ts` (`writeHookStatus`)
- Modify: `src/sessions.ts` (`Session` type, `listSessions`)
- Test: `test/prompt.test.ts`, `test/hooks.test.ts` (new tests in `describe("writeHookStatus")`)

**Interfaces:**
- Consumes: `toolSummary` from Task 1.
- Produces:
  - `type Prompt = { kind: "permission"; tool: string; summary: string; options: string[]; keys: string[]; answerable: true } | { kind: "question"; questions: Question[]; answerable: boolean } | { kind: "other"; answerable: false }` (`keys`: what blimpd presses for each option; the app ignores it)
  - `promptFromHook(ev: any): Prompt | undefined`
  - `parseScreenOptions(screen: string): string[]`
  - `answerKeys(p: Prompt, pick: number): string | undefined`
  - `Session.prompt?: Prompt & { at: number }`, present only while `state === "waiting"` and blimp's hook file says waiting. `at` is the hook's `at`: when this wait started. The phone sends it back with an answer, so an answer can't land on a later question. (It is not `stateSince`: Claude's own status file can be newer than the hook's and set `stateSince` to another time.)
  - `transcriptPath(dir: string, sessionId: string): string | undefined` exported from `sessions.ts` (it exists, unexported)

- [ ] **Step 1: Write the failing tests**

```ts
// test/prompt.test.ts
import { expect, test } from "bun:test";
import { answerKeys, parseScreenOptions, promptFromHook, withScreenOptions } from "../src/prompt";

// What Claude Code 2.1.300 drew for a Bash permission prompt (from the probe, 2026-10-19).
const SCREEN = ` Bash command
 rm -f nothing-here.txt && date > probe2.txt
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for rm -f nothing-here.txt and date commands in /Users/mbeato/x
   3. Yes, and switch to auto mode · auto mode handles these prompts for you
   4. No

 Esc to cancel · Tab to amend`;

test("parseScreenOptions reads the numbered options after the question", () => {
  expect(parseScreenOptions(SCREEN)).toEqual([
    "Yes",
    "Yes, and don't ask again for rm -f nothing-here.txt and date commands in /Users/mbeato/x",
    "Yes, and switch to auto mode · auto mode handles these prompts for you",
    "No",
  ]);
  expect(parseScreenOptions("no prompt here\n❯ ")).toEqual([]);
});

test("promptFromHook", () => {
  const perm = promptFromHook({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "git push" }, cwd: "/p" });
  expect(perm).toEqual({ kind: "permission", tool: "Bash", summary: "Ran `git push`", options: ["Yes", "No"], keys: ["1", "\x1b"], answerable: true });

  const one = { question: "Color?", header: "Color", multiSelect: false, options: [{ label: "Red", description: "r" }, { label: "Green" }] };
  expect(promptFromHook({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: { questions: [one] } })).toEqual({
    kind: "question",
    questions: [{ question: "Color?", header: "Color", multiSelect: false, options: [{ label: "Red", description: "r" }, { label: "Green" }] }],
    answerable: true,
  });
  const multi = { ...one, multiSelect: true };
  expect(promptFromHook({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: { questions: [multi] } })?.answerable).toBe(false);
  expect(promptFromHook({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: { questions: [one, one] } })?.answerable).toBe(false);
  expect(promptFromHook({ hook_event_name: "Elicitation" })).toEqual({ kind: "other", answerable: false });
  expect(promptFromHook({ hook_event_name: "Stop" })).toBeUndefined();
});

test("withScreenOptions swaps in the options the screen shows, as digits", () => {
  const p = promptFromHook({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "x" } })!;
  const q = withScreenOptions(p, SCREEN);
  expect(q.kind === "permission" && q.options.length).toBe(4);
  expect(q.kind === "permission" && q.keys).toEqual(["1", "2", "3", "4"]);
  expect(withScreenOptions(p, "nothing")).toEqual(p);
});

test("answerKeys", () => {
  const p = promptFromHook({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "x" } })!;
  expect(answerKeys(p, 0)).toBe("1");
  expect(answerKeys(p, 1)).toBe("\x1b"); // "No" without screen options: Esc cancels the prompt
  expect(answerKeys(p, 2)).toBeUndefined();
  const q = promptFromHook({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "?", multiSelect: false, options: [{ label: "a" }, { label: "b" }] }] } })!;
  expect(answerKeys(q, 1)).toBe("2");
  expect(answerKeys({ kind: "other", answerable: false }, 0)).toBeUndefined();
});
```

Add to `test/hooks.test.ts` inside `describe("writeHookStatus", …)` (it already has a `dir` and a `read` helper there; check the top of that block and use its names):

```ts
  test("records what Claude asked, and a later Notification keeps it", () => {
    writeHookStatus(JSON.stringify({ hook_event_name: "PermissionRequest", session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" } }), "p1", dir);
    const first = JSON.parse(readFileSync(join(dir, "p1.json"), "utf8"));
    expect(first.prompt).toMatchObject({ kind: "permission", summary: "Ran `ls`" });
    writeHookStatus(JSON.stringify({ hook_event_name: "Notification", session_id: "s1", notification_type: "permission_prompt" }), "p1", dir);
    expect(JSON.parse(readFileSync(join(dir, "p1.json"), "utf8")).prompt).toEqual(first.prompt);
    writeHookStatus(JSON.stringify({ hook_event_name: "PostToolUse", session_id: "s1" }), "p1", dir);
    expect(JSON.parse(readFileSync(join(dir, "p1.json"), "utf8")).prompt).toBeUndefined();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/prompt.test.ts test/hooks.test.ts`
Expected: FAIL, "Cannot find module '../src/prompt'", and the new hooks test fails on `first.prompt` being undefined.

- [ ] **Step 3: Write `src/prompt.ts`**

```ts
// What a waiting Claude is asking, so the phone can show it as buttons. The hook knows the
// question; for permission prompts only the screen shows the options (they vary by command), so
// blimpd reads them from `zmx history` once per wait. Answers are key presses, decided here only.

import { toolSummary } from "./chat";

export type Question = { question: string; header?: string; multiSelect: boolean; options: { label: string; description?: string }[] };
export type Prompt =
  | { kind: "permission"; tool: string; summary: string; options: string[]; keys: string[]; answerable: true }
  | { kind: "question"; questions: Question[]; answerable: boolean }
  | { kind: "other"; answerable: false };

const str = (v: unknown) => (typeof v === "string" ? v : "");

export function promptFromHook(ev: any): Prompt | undefined {
  const e = ev?.hook_event_name;
  if (e === "PermissionRequest") {
    const tool = str(ev.tool_name);
    // Without the screen: Yes is the first option, and Esc says no.
    return { kind: "permission", tool, summary: toolSummary(tool, ev.tool_input, str(ev.cwd)), options: ["Yes", "No"], keys: ["1", "\x1b"], answerable: true };
  }
  if (e === "PreToolUse" && ev.tool_name === "AskUserQuestion") {
    const questions: Question[] = (Array.isArray(ev.tool_input?.questions) ? ev.tool_input.questions : []).map((q: any) => ({
      question: str(q?.question),
      ...(typeof q?.header === "string" && { header: q.header }),
      multiSelect: q?.multiSelect === true,
      options: (Array.isArray(q?.options) ? q.options : []).map((o: any) => ({ label: str(o?.label), ...(typeof o?.description === "string" && { description: o.description }) })),
    }));
    // Digits pick and submit one single-choice question; anything more took the wrong boxes in the probe.
    return { kind: "question", questions, answerable: questions.length === 1 && !questions[0].multiSelect && questions[0].options.length <= 9 };
  }
  if (e === "Elicitation") return { kind: "other", answerable: false };
}

// The numbered lines after "Do you want to proceed?": "❯ 1. Yes", "  2. …".
export function parseScreenOptions(screen: string): string[] {
  const lines = screen.split("\n");
  const start = lines.findLastIndex((l) => l.includes("Do you want to proceed?"));
  if (start < 0) return [];
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    const m = l.match(/^\s*(?:❯\s*)?(\d)\.\s+(.*\S)\s*$/);
    if (m && Number(m[1]) === out.length + 1) out.push(m[2]);
    else if (out.length && l.trim()) break;
  }
  return out;
}

export function withScreenOptions(p: Prompt, screen: string): Prompt {
  if (p.kind !== "permission") return p;
  const options = parseScreenOptions(screen);
  return options.length ? { ...p, options, keys: options.map((_, i) => String(i + 1)) } : p;
}

export function answerKeys(p: Prompt, pick: number): string | undefined {
  if (!Number.isInteger(pick) || pick < 0 || !p.answerable) return;
  if (p.kind === "permission") return p.keys[pick];
  if (p.kind === "question" && pick < p.questions[0].options.length) return String(pick + 1);
}
```

- [ ] **Step 4: Change `writeHookStatus` in `src/hooks.ts`**

Replace the last four lines of `writeHookStatus` (from `mkdirSync(statusDir…` to `renameSync(tmp, file);`) with the block below, and add `import { promptFromHook } from "./prompt";` to its imports.

```ts
  mkdirSync(statusDir, { recursive: true, mode: 0o700 });
  const file = join(statusDir, `${session}.json`);
  // What Claude asks, for the phone. The Notification that follows a permission prompt seconds
  // later carries no details, so it keeps the prompt, and the time the wait started, already
  // recorded for this wait (the phone's answer names the wait by that time).
  let prompt = codex ? undefined : promptFromHook(ev);
  let at = Date.now();
  if (!prompt && state === "waiting") {
    try {
      const prev = JSON.parse(readFileSync(file, "utf8"));
      if (prev.state === "waiting" && prev.sessionId === ev.session_id && prev.prompt) ({ prompt, at } = prev);
    } catch {}
  }
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ state, at, sessionId: ev.session_id, event: ev.hook_event_name, ...(prompt && { prompt }) }));
  renameSync(tmp, file); // the server never reads half a file
```

And extend the hooks test with: `expect(JSON.parse(readFileSync(join(dir, "p1.json"), "utf8")).at).toBe(first.at)` after the Notification.

- [ ] **Step 5: Add `prompt` to `listSessions` in `src/sessions.ts`**

1. `export` the existing `function transcriptPath`.
2. In `type Session`, after `stateSince?: number; // ms`, add: `prompt?: Prompt & { at: number }; // what a waiting Claude asks (prompt.ts), and when the wait started`. Import the type: `import { type Prompt, withScreenOptions } from "./prompt";`
3. Add above `listSessions`:

```ts
// A permission prompt's options come from the screen, read once per wait (keyed by the hook's `at`).
const screenPrompts = new Map<string, Prompt>();
function promptFor(name: string, hook: any): Prompt | undefined {
  const p = hook.prompt as Prompt | undefined;
  if (!p || p.kind !== "permission") return p;
  const key = `${name}\0${hook.at}`;
  let done = screenPrompts.get(key);
  if (!done) {
    const r = Bun.spawnSync([zmxPath(), "history", name], { env: zmxEnv(), stdout: "pipe", stderr: "ignore" });
    done = withScreenOptions(p, r.stdout.toString().split("\n").slice(-40).join("\n"));
    if (screenPrompts.size > 200) screenPrompts.clear();
    screenPrompts.set(key, done);
  }
  return done;
}
```

4. In `listSessions`'s map callback, before `return {`, add:

```ts
    const st = deriveState(info, hook, z.created);
    // Only the hook knows what's asked. Claude's own status file may be the newer of the two, so
    // don't require the hook to be what set the state, only that both say waiting.
    const asked = st.state === "waiting" && hook.state === "waiting" && hook.at >= z.created * 1000 ? promptFor(z.name, hook) : undefined;
    const prompt = asked && { ...asked, at: hook.at as number };
```

and replace `...deriveState(info, hook, z.created),` in the returned object with `...st, ...(prompt && { prompt }),`. (`hook` is `{}` for an unsafe name, so `promptFor` never sees one.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test test/prompt.test.ts test/hooks.test.ts test/sessions.test.ts`
Expected: PASS. `sessions.test.ts` must still pass unchanged (sessions without a hook prompt get no `prompt` key).

- [ ] **Step 7: Commit**

```bash
git add src/prompt.ts src/hooks.ts src/sessions.ts test/prompt.test.ts test/hooks.test.ts
git commit -m "Sessions say what a waiting Claude asks: the command, or the question and its options"
```

---

### Task 3: Terminal sizes blimpd has seen (`src/terminal.ts`)

**Files:**
- Modify: `src/terminal.ts`
- Test: covered in Task 4's server test ("the chat client doesn't change the viewer's size"); this task adds a unit test only for the map.
- Test: `test/sessions.test.ts` is not touched. Create `test/terminal.test.ts`.

**Interfaces:**
- Produces: `lastSize(name: string): { cols: number; rows: number }` (120×36 if none seen), `setSize(name, cols, rows): void`, `followSize(name, f: (cols, rows) => void): () => void` (returns unfollow).

- [ ] **Step 1: Write the failing test**

```ts
// test/terminal.test.ts
import { expect, test } from "bun:test";
import { followSize, lastSize, setSize } from "../src/terminal";

test("lastSize defaults to 120x36, follows setSize, and tells followers", () => {
  expect(lastSize("blimpunit-x")).toEqual({ cols: 120, rows: 36 });
  const seen: number[][] = [];
  const off = followSize("blimpunit-x", (c, r) => seen.push([c, r]));
  setSize("blimpunit-x", 101, 33);
  expect(lastSize("blimpunit-x")).toEqual({ cols: 101, rows: 33 });
  off();
  setSize("blimpunit-x", 90, 20);
  expect(seen).toEqual([[101, 33]]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/terminal.test.ts`
Expected: FAIL, "lastSize is not a function" or an export error.

- [ ] **Step 3: Implement in `src/terminal.ts`**

Add after `termSize`:

```ts
// The size each session was last shown at, from the terminals blimpd proxies. A chat client
// attaches at this size: a client of another size resizes the session for everyone (zmx 0.5).
const sizes = new Map<string, { cols: number; rows: number }>();
const followers = new Map<string, Set<(cols: number, rows: number) => void>>();

export const lastSize = (name: string) => sizes.get(name) ?? { cols: 120, rows: 36 };

export function setSize(name: string, cols: number, rows: number) {
  sizes.set(name, { cols, rows });
  for (const f of followers.get(name) ?? []) f(cols, rows);
}

export function followSize(name: string, f: (cols: number, rows: number) => void): () => void {
  let set = followers.get(name);
  if (!set) followers.set(name, (set = new Set()));
  set.add(f);
  return () => {
    set.delete(f);
    if (!set.size) followers.delete(name);
  };
}
```

In `openAttach`, as the first line after `const d = ws.data;`: `setSize(d.name, d.cols, d.rows);`
In `attachMessage`'s resize branch, after `term.resize(cols, rows);`: `setSize(ws.data.name, cols, rows);`

- [ ] **Step 4: Run tests**

Run: `bun test test/terminal.test.ts test/server.test.ts -t terminal`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/terminal.ts test/terminal.test.ts
git commit -m "blimpd remembers the size each session's terminal is shown at"
```

---

### Task 4: The `/sessions/<name>/chat` WebSocket (`src/chatsocket.ts`, `src/server.ts`)

**Files:**
- Create: `src/chatsocket.ts`
- Modify: `src/server.ts` (route + websocket dispatch)
- Test: `test/server.test.ts` (new `describe("chat", …)`)

**Interfaces:**
- Consumes: `newScan`, `readAppended`, `mergeById`, `ChatMessage` (Task 1); `answerKeys`, `Prompt` (Task 2); `transcriptPath`, `listSessions`, `zmxListAsync`, `zmxPath`, `zmxEnv`, `claudeDir` (sessions.ts); `lastSize`, `followSize` (Task 3).
- Produces: `type ChatData = { kind: "chat"; name: string; … }`, `chatData(name: string): ChatData`, `openChat(ws)`, `chatMessage(ws, msg)`, `closeChat(ws)`; wire protocol exactly as in the spec ("Input (on the chat socket)" and "Messages").

- [ ] **Step 1: Write the failing tests**

Add to `test/server.test.ts`, after `describe("terminal", …)`. They use the file's helpers (`shSession`, `socket`, `type`, `until`, `api`, `zmx`, `tmp`, `clients`).

```ts
describe("chat", () => {
  // A stand-in Claude: reads lines, answers `size` with its terminal size, echoes the rest with
  // ESC shown as ~ (zmx draws output through a terminal emulator, which would swallow a raw ESC).
  const LOOP = `while IFS= read -r l; do case "$l" in size) echo "sz=$(stty size)";; *) printf 'got:%s\\n' "$(printf %s "$l" | tr '\\033' '~')";; esac; done`;
  const claudeDir = join(tmp, "claude");
  const T = new Date().toISOString();
  const tline = (o: object) => JSON.stringify({ timestamp: T, ...o }) + "\n";

  // A session that looks like Claude to blimpd: its pid has a status file naming a transcript.
  async function fakeClaude(suffix: string, sessionId: string, lines: string[]) {
    const name = await shSession(suffix, ["sh", "-c", LOOP]);
    const pid = parseZmxList(zmx("list").stdout.toString()).find((s) => s.name === name)!.pid;
    mkdirSync(join(claudeDir, "sessions"), { recursive: true });
    mkdirSync(join(claudeDir, "projects", "p"), { recursive: true });
    const transcript = join(claudeDir, "projects", "p", `${sessionId}.jsonl`);
    writeFileSync(transcript, lines.join(""));
    writeFileSync(join(claudeDir, "sessions", `${pid}.json`), JSON.stringify({ sessionId, cwd: tmp, status: "idle" }));
    return { name, pid, transcript };
  }
  const user = (uuid: string, text: string) => tline({ type: "user", uuid, message: { role: "user", content: text } });
  const said = (uuid: string, text: string) => tline({ type: "assistant", uuid, message: { role: "assistant", content: [{ type: "text", text }] } });

  test("history on connect, appends as the transcript grows, reset on a new conversation", async () => {
    const sid = "11111111-1111-1111-1111-111111111111";
    const { pid, transcript, name } = await fakeClaude("chat1", sid, [user("u1", "hello"), said("a1", "hi there")]);
    const c = await socket(`/sessions/${name}/chat`);
    await until(() => c.messages.find((m) => m.type === "history"), "history");
    expect(c.messages[0].messages.map((m: any) => [m.role, m.text])).toEqual([["user", "hello"], ["assistant", "hi there"]]);

    appendFileSync(transcript, said("a2", "more"));
    await until(() => c.messages.find((m) => m.type === "append"), "append", 3000);
    expect(c.messages.find((m) => m.type === "append").messages[0].text).toBe("more");

    const sid2 = "22222222-2222-2222-2222-222222222222";
    writeFileSync(join(claudeDir, "projects", "p", `${sid2}.jsonl`), user("u9", "fresh"));
    writeFileSync(join(claudeDir, "sessions", `${pid}.json`), JSON.stringify({ sessionId: sid2, cwd: tmp, status: "idle" }));
    await until(() => c.messages.some((m) => m.type === "reset"), "reset", 4000);
    await until(() => c.messages.filter((m) => m.type === "history").length === 2, "second history");
    expect(c.messages.at(-1).messages.map((m: any) => m.text)).toEqual(["fresh"]);
    c.ws.close();
  });

  test("input is typed as a paste plus Enter, once per id, at the viewer's size", async () => {
    const { name } = await fakeClaude("chat2", "33333333-3333-3333-3333-333333333333", []);
    const viewer = await socket(`/sessions/${name}/attach?cols=101&rows=33`);
    const c = await socket(`/sessions/${name}/chat`);
    await until(() => c.messages.find((m) => m.type === "history"), "history");
    c.ws.send(JSON.stringify({ type: "input", id: "m1", text: "hel\x1blo\nworld" }));
    await until(() => c.messages.find((m) => m.type === "ack" && m.id === "m1"), "ack");
    // ESC is stripped from the text, the paste markers wrap it, and the newline stays inside the paste.
    await until(() => viewer.text.includes("got:~[200~hello"), "pasted text reached the session");
    c.ws.send(JSON.stringify({ type: "input", id: "m1", text: "again" }));
    await until(() => c.messages.filter((m) => m.type === "ack" && m.id === "m1").length === 2, "second ack");
    await Bun.sleep(300);
    expect(viewer.text).not.toContain("again");
    // The chat client attached at the viewer's size, so the session's size is unchanged.
    type(viewer.ws, "size\r");
    await until(() => viewer.text.includes("sz=33 101"), "size unchanged");
    c.ws.close();
    viewer.ws.close();
  });

  test("answer presses the option's key while that prompt is up; a stale one is refused", async () => {
    const { name } = await fakeClaude("chat3", "44444444-4444-4444-4444-444444444444", []);
    const at = Date.now();
    mkdirSync(join(tmp, "status"), { recursive: true });
    writeFileSync(
      join(tmp, "status", `${name}.json`),
      JSON.stringify({ state: "waiting", at, sessionId: "44444444-4444-4444-4444-444444444444", event: "PermissionRequest",
        prompt: { kind: "permission", tool: "Bash", summary: "Ran `ls`", options: ["Yes", "No"], keys: ["1", "\x1b"], answerable: true } }),
    );
    const viewer = await socket(`/sessions/${name}/attach?cols=80&rows=24`);
    const c = await socket(`/sessions/${name}/chat`);
    await until(() => c.messages.find((m) => m.type === "history"), "history");
    c.ws.send(JSON.stringify({ type: "answer", id: "q1", at: at - 1, pick: 0 }));
    await until(() => c.messages.find((m) => m.id === "q1"), "reply");
    expect(c.messages.find((m) => m.id === "q1")).toEqual({ type: "error", id: "q1", error: "the question changed" });
    c.ws.send(JSON.stringify({ type: "answer", id: "q2", at, pick: 0 }));
    await until(() => c.messages.find((m) => m.type === "ack" && m.id === "q2"), "ack");
    type(viewer.ws, "\r");
    await until(() => viewer.text.includes("got:1"), "the digit reached the session");
    c.ws.close();
    viewer.ws.close();
  });

  test("interrupt sends Esc", async () => {
    const { name } = await fakeClaude("chat4", "55555555-5555-5555-5555-555555555555", []);
    const viewer = await socket(`/sessions/${name}/attach?cols=80&rows=24`);
    const c = await socket(`/sessions/${name}/chat`);
    await until(() => c.messages.find((m) => m.type === "history"), "history");
    c.ws.send(JSON.stringify({ type: "interrupt", id: "i1" }));
    await until(() => c.messages.find((m) => m.type === "ack" && m.id === "i1"), "ack");
    type(viewer.ws, "\r");
    await until(() => viewer.text.includes("got:~"), "Esc reached the session");
    c.ws.close();
    viewer.ws.close();
  });

  test("a session that isn't Claude is unreadable and takes no input; an ended one closes with 4000", async () => {
    const name = await shSession("chat5");
    const c = await socket(`/sessions/${name}/chat`);
    await until(() => c.messages.find((m) => m.type === "unreadable"), "unreadable");
    c.ws.send(JSON.stringify({ type: "input", id: "x", text: "ls" }));
    await until(() => c.messages.find((m) => m.id === "x"), "reply");
    expect(c.messages.find((m) => m.id === "x").type).toBe("error");
    zmx("kill", name);
    await until(() => c.closed, "socket to close", 5000);
    expect(c.closed?.code).toBe(4000);
  });

  test("404 for an unknown session", async () => {
    expect((await api(`/sessions/${tag}-none/chat?token=${token}`)).status).toBe(404);
  });
});
```

Add `appendFileSync` to the file's `node:fs` import. `parseZmxList` is already imported. The status folder for this test blimpd is `join(tmp, "status")` (next to the socket).

- [ ] **Step 2: Run to verify they fail**

Run: `bun test test/server.test.ts -t chat`
Expected: FAIL: the `/chat` route returns 404 for known sessions, so `socket()` rejects with "websocket … failed".

- [ ] **Step 3: Write `src/chatsocket.ts`**

```ts
// The chat socket (docs/DESIGN.md, Chat): a session's conversation as messages, and a way to type
// into it, for the phone. Each socket keeps one zmx client attached while it's open, at the size
// the session is shown at elsewhere: a client per message, or one of another size, upsets Claude's
// screen (the probe in the phone spec).

import type { ServerWebSocket, Subprocess } from "bun";
import { type ChatMessage, type ChatScan, mergeById, newScan, readAppended } from "./chat";
import { answerKeys } from "./prompt";
import { claudeDir, listSessions, type Session, transcriptPath, zmxEnv, zmxListAsync, zmxPath } from "./sessions";
import { followSize, lastSize } from "./terminal";

export type ChatData = {
  kind: "chat";
  name: string;
  closed?: boolean;
  session?: Session;
  file?: string;
  scan?: ChatScan;
  proc?: Subprocess;
  unfollow?: () => void;
  timer?: ReturnType<typeof setInterval>;
  ticks: number;
  busy?: boolean;
};

export const chatData = (name: string): ChatData => ({ kind: "chat", name, ticks: 0 });

const HISTORY = 200;
const seen = new Map<string, string[]>(); // session -> last 100 input ids, across sockets

const send = (ws: ServerWebSocket<ChatData>, m: object) => ws.data.closed || ws.send(JSON.stringify(m));

async function find(name: string): Promise<Session | undefined> {
  return listSessions(claudeDir(), await zmxListAsync()).find((s) => s.name === name);
}

// The current conversation from the start: the last 200 messages.
function loadHistory(ws: ServerWebSocket<ChatData>) {
  const d = ws.data;
  const s = d.session!;
  d.file = s.sessionId ? transcriptPath(claudeDir(), s.sessionId) : undefined;
  if (!d.file) {
    d.scan = undefined;
    return send(ws, { type: "unreadable" });
  }
  d.scan = newScan(s.dir);
  try {
    const all = mergeById([], readAppended(d.file, d.scan));
    send(ws, { type: "history", messages: all.slice(-HISTORY) });
  } catch {
    d.scan = undefined;
    send(ws, { type: "unreadable" });
  }
}

// Every 250 ms: new transcript lines. Every 4th: is the session still there, still the same conversation?
async function tick(ws: ServerWebSocket<ChatData>) {
  const d = ws.data;
  if (d.busy || d.closed) return;
  d.busy = true;
  try {
    if (d.ticks++ % 4 === 0) {
      const s = await find(d.name);
      if (d.closed) return;
      if (!s) {
        d.closed = true;
        return ws.close(4000, "ended");
      }
      const changed = s.sessionId !== d.session?.sessionId;
      d.session = s;
      if (changed) {
        send(ws, { type: "reset" });
        loadHistory(ws);
      }
    }
    if (d.file && d.scan) {
      const add: ChatMessage[] = readAppended(d.file, d.scan);
      if (add.length) send(ws, { type: "append", messages: add });
    }
  } catch {
  } finally {
    d.busy = false;
  }
}

export async function openChat(ws: ServerWebSocket<ChatData>) {
  const d = ws.data;
  d.session = await find(d.name);
  if (!d.session) {
    d.closed = true;
    return ws.close(4000, "ended");
  }
  if (d.session.sessionId) loadHistory(ws);
  else send(ws, { type: "unreadable" });
  d.timer = setInterval(() => tick(ws), 250);
}

// The zmx client is started on the first input, not on open: a phone that only reads adds no client.
function client(ws: ServerWebSocket<ChatData>) {
  const d = ws.data;
  if (d.proc && d.proc.exitCode === null) return d.proc;
  const { cols, rows } = lastSize(d.name);
  d.proc = Bun.spawn([zmxPath(), "attach", d.name], {
    env: { ...zmxEnv(), TERM: "xterm-256color", COLORTERM: "truecolor" },
    terminal: { cols, rows, data() {} }, // its output is the same screen the viewers see; nobody needs it here
  });
  d.unfollow?.();
  d.unfollow = followSize(d.name, (c, r) => d.proc?.terminal?.resize(c, r));
  return d.proc;
}

// Typing too soon after the client attaches can land before zmx has connected it.
async function write(ws: ServerWebSocket<ChatData>, parts: string[]) {
  const fresh = !ws.data.proc || ws.data.proc.exitCode !== null;
  const term = client(ws).terminal!;
  if (fresh) await Bun.sleep(150);
  for (const [i, p] of parts.entries()) {
    if (i) await Bun.sleep(50); // Enter apart from the paste, as a person would press it
    term.write(p);
  }
}

export async function chatMessage(ws: ServerWebSocket<ChatData>, msg: string | Buffer) {
  if (typeof msg !== "string") return;
  let m: any;
  try {
    m = JSON.parse(msg);
  } catch {
    return;
  }
  const id = m?.id;
  if (typeof id !== "string" || !id || id.length > 100) return;
  const fail = (error: string) => send(ws, { type: "error", id, error });
  const d = ws.data;
  if (!d.session?.sessionId) return fail("open this session on the Mac");
  try {
    if (m.type === "input") {
      if (typeof m.text !== "string" || m.text.length > 100_000) return fail("text must be a string of at most 100 000 characters");
      const ids = seen.get(d.name) ?? [];
      if (ids.includes(id)) return send(ws, { type: "ack", id });
      seen.set(d.name, [...ids, id].slice(-100));
      // No ESC from the phone: it would end the paste early and turn the rest into key presses.
      await write(ws, ["\x1b[200~" + m.text.replaceAll("\x1b", "") + "\x1b[201~", "\r"]);
      return send(ws, { type: "ack", id });
    }
    if (m.type === "answer") {
      const s = await find(d.name);
      const keys = s?.state === "waiting" && s.prompt && s.prompt.at === m.at ? answerKeys(s.prompt, m.pick) : undefined;
      if (!keys) return fail("the question changed");
      await write(ws, [keys]);
      return send(ws, { type: "ack", id });
    }
    if (m.type === "interrupt") {
      await write(ws, ["\x1b"]);
      return send(ws, { type: "ack", id });
    }
    fail("unknown message");
  } catch (e) {
    fail((e as Error).message);
  }
}

export function closeChat(ws: ServerWebSocket<ChatData>) {
  const d = ws.data;
  d.closed = true;
  clearInterval(d.timer);
  d.unfollow?.();
  d.proc?.kill("SIGTERM");
  d.proc?.exited.then(() => d.proc?.terminal?.close());
}
```

- [ ] **Step 4: Wire it into `src/server.ts`**

1. Import: `import { type ChatData, chatData, chatMessage, closeChat, openChat } from "./chatsocket";`
2. `type WsData = AttachData | EventsData | ChatData;`
3. After the `attach` route block, add:

```ts
  const chat = path.match(/^\/sessions\/([^/]+)\/chat$/);
  if (chat && get) {
    const name = decodeURIComponent(chat[1]);
    if (!isSafeName(name) || !(await sessionExists(name))) throw new HttpError(404, `no session named ${name}`);
    if (server.upgrade(req, { data: chatData(name) })) return;
    throw new HttpError(400, "expected a WebSocket");
  }
```

4. In `websocket`, dispatch `chat` before the `else` for events in each of `open`, `message`, `close`:

```ts
      open(ws) {
        if (ws.data.kind === "attach") openAttach(ws as any);
        else if (ws.data.kind === "chat") openChat(ws as any);
        else openEvents(ws as any, server);
      },
      message(ws, msg) {
        if (ws.data.kind === "attach") attachMessage(ws as any, msg);
        else if (ws.data.kind === "chat") chatMessage(ws as any, msg);
        else eventsMessage(ws as any, msg);
      },
      close(ws) {
        if (ws.data.kind === "attach") closeAttach(ws as any);
        else if (ws.data.kind === "chat") closeChat(ws as any);
        else closeEvents(ws as any);
      },
```

- [ ] **Step 5: Run the chat tests, then the whole suite**

Run: `bun test test/server.test.ts -t chat`
Expected: PASS (6 tests)
Run: `bun test`
Expected: PASS, every file.

If "input … at the viewer's size" fails with `sz=36 120`, the chat client attached before the viewer's size was recorded: check `setSize` is called in `openAttach` (Task 3).

- [ ] **Step 6: Commit**

```bash
git add src/chatsocket.ts src/server.ts test/server.test.ts
git commit -m "A chat socket per session: its conversation as messages, and typing, answers and Stop from the phone"
```

---

### Task 5: Against a real Claude (opt-in)

**Files:**
- Create: `test/real-claude.test.ts`

**Interfaces:**
- Consumes: the `/chat` protocol (Task 4), `Session.prompt` (Task 2), `POST /sessions` with a custom kind (`~/.blimp/kinds.json` format, DESIGN.md Kinds).

This runs only with `BLIMP_REAL_CLAUDE=1` and uses Max's Claude account (a few cents). It's the check that the keys in `prompt.ts` and the paste in `chatsocket.ts` work on the real Claude Code, not just the stand-in.

- [ ] **Step 1: Write the test**

```ts
// test/real-claude.test.ts
// The chat socket against a real Claude Code: a message, a permission prompt, and a question, all
// answered through /chat. Opt-in (BLIMP_REAL_CLAUDE=1): it uses your Claude account.
// Its folder and Claude's saved conversation for it are removed afterwards.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { zmxPath } from "../src/sessions";

const on = process.env.BLIMP_REAL_CLAUDE === "1";
const tmp = mkdtempSync(join(tmpdir(), "blimp-real-"));
const sock = join(tmp, "blimpd.sock");
const dir = realpathSync(mkdtempSync(join(homedir(), ".blimptest-real-")));
// From inside a Claude session, CLAUDE_* variables would turn off the child's transcript.
const env: Record<string, string | undefined> = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE") && k !== "ZMX_SESSION"));
env.BLIMPD_SOCKET = sock;
let server: ReturnType<typeof Bun.spawn>;
let token = "";
let name = "";

async function until<T>(f: () => T | Promise<T>, what: string, ms = 60000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(200);
  }
}
const api = (path: string, init: RequestInit = {}) => fetch(`http://blimpd${path}`, { ...init, unix: sock, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } } as any);
const session = async () => ((await (await api("/sessions")).json()) as any[]).find((s) => s.name === name);

beforeAll(async () => {
  if (!on) return;
  // Permission prompts need the default mode: Max's settings run auto mode, which asks nothing.
  // The hooks in ~/.claude/settings.json run the installed blimpd, not this code, so this session
  // gets this code's hook through --settings, and the installed one writes to a decoy folder
  // (it finds its folder from BLIMPD_SOCKET; ours is told the real one).
  const hook = `BLIMPD_SOCKET='${sock}' '${process.execPath}' '${join(import.meta.dir, "..", "src", "main.ts")}' hook`;
  const ours = { hooks: [{ type: "command", command: hook, timeout: 5 }] };
  const settings = join(tmp, "test-settings.json");
  writeFileSync(settings, JSON.stringify({ hooks: {
    Notification: [ours], Stop: [ours], UserPromptSubmit: [ours], PostToolUse: [ours], PermissionRequest: [ours],
    PreToolUse: [{ matcher: "AskUserQuestion", ...ours }], Elicitation: [ours] } }));
  writeFileSync(join(tmp, "kinds.json"), JSON.stringify({ kinds: [{ id: "ask", label: "Ask",
    command: ["claude", "--permission-mode", "default", "--settings", settings],
    env: { BLIMPD_SOCKET: join(tmp, "decoy", "blimpd.sock") } }] }));
  server = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "main.ts"), "serve"], { env, stdout: "ignore", stderr: "inherit" });
  await until(() => existsSync(sock) && statSync(sock).isSocket() && (token = readFileSync(join(tmp, "token"), "utf8").trim()), "blimpd", 10000);
});

afterAll(() => {
  if (!on) return;
  if (name) Bun.spawnSync([zmxPath(), "kill", name], { env });
  server?.kill();
  rmSync(tmp, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
  rmSync(join(homedir(), ".claude", "projects", dir.replace(/[^A-Za-z0-9]/g, "-")), { recursive: true, force: true });
});

test.if(on)("a message, a permission and a question, all through /chat", async () => {
  name = ((await (await api("/sessions", { method: "POST", body: JSON.stringify({ dir, kind: "ask" }) })).json()) as any).name;

  // A new folder asks whether to trust it, and no hook says so: answer it on a raw terminal.
  const term = new WebSocket(`ws+unix://${sock}:/sessions/${name}/attach?cols=120&rows=36&token=${token}`);
  let screen = "";
  term.binaryType = "arraybuffer";
  term.onmessage = (e) => (screen += new TextDecoder().decode(e.data as ArrayBuffer));
  await until(() => screen.includes("trust this folder") || screen.includes("❯"), "Claude's first screen", 30000);
  if (screen.includes("trust this folder")) term.send(new TextEncoder().encode("\x1b[B\r"));
  await until(async () => (await session())?.sessionId, "Claude's session id", 30000);

  const got: any[] = [];
  const chat = new WebSocket(`ws+unix://${sock}:/sessions/${name}/chat?token=${token}`);
  chat.onmessage = (e) => got.push(JSON.parse(e.data as string));
  await until(() => got.some((m) => m.type === "history"), "history", 10000);
  const send = (m: object) => chat.send(JSON.stringify(m));
  const texts = () => got.flatMap((m) => m.messages ?? []);

  send({ type: "input", id: "m1", text: "Run this exact shell command with the Bash tool: date > real.txt" });
  await until(() => texts().some((m) => m.role === "user" && m.text.includes("date > real.txt")), "my message in the transcript");

  const perm = await until(async () => {
    const s = await session();
    return s?.prompt?.kind === "permission" && s;
  }, "a permission prompt");
  expect(perm.prompt.options[0]).toBe("Yes");
  send({ type: "answer", id: "a1", at: perm.prompt.at, pick: 0 });
  await until(() => existsSync(join(dir, "real.txt")), "the command to run");

  await until(async () => (await session())?.state === "done", "the turn to end", 90000);
  send({ type: "input", id: "m2", text: "Use the AskUserQuestion tool to ask me which color I like, with options red, green and blue." });
  const q = await until(async () => {
    const s = await session();
    return s?.prompt?.kind === "question" && s;
  }, "a question");
  expect(q.prompt.answerable).toBe(true);
  const green = q.prompt.questions[0].options.findIndex((o: any) => /green/i.test(o.label));
  send({ type: "answer", id: "a2", at: q.prompt.at, pick: green });
  await until(() => texts().some((m) => m.role === "tool" && m.name === "AskUserQuestion" && /green/i.test(m.output ?? "")), "the answer in the transcript", 90000);

  chat.close();
  term.close();
}, 300000);
```

- [ ] **Step 2: Run it**

Run: `BLIMP_REAL_CLAUDE=1 bun test test/real-claude.test.ts`
Expected: PASS within about 2 minutes. Run without the variable: `bun test test/real-claude.test.ts` → the test is skipped.

If the permission step times out with the prompt on screen but `prompt` missing: the hook may have recorded `Notification` first. Read `<tmp>/status/<name>.json`, and fix `writeHookStatus` (Task 2) so a waiting event without a prompt doesn't block a later `PermissionRequest` from adding one. If the question was answered but the transcript shows another color: the option order on screen differs from `tool_input`. Stop and report: don't guess at keys.

- [ ] **Step 3: Commit**

```bash
git add test/real-claude.test.ts
git commit -m "An opt-in test of the chat socket against a real Claude Code"
```

---

### Task 6: Docs

**Files:**
- Modify: `docs/DESIGN.md` (blimpd API: `Session.prompt`, a new `### Chat` section after `### Events`)
- Modify: `docs/SECURITY.md` (one row)
- Modify: `docs/superpowers/specs/2026-10-19-phone-app-design.md` (an "As built" line under section 2)

- [ ] **Step 1: DESIGN.md**

In the `type Session` block, after `stateSince?: number;   // ms`, add:

```ts
  prompt?: Prompt & { at: number };  // while waiting: what Claude asks, and when the wait started (see Chat)
```

Add after the Events section:

```markdown
### Chat

For the phone: a Claude session as chat messages, and a way to type into it. Only for sessions where Claude Code runs (`sessionId` is known).

`GET /sessions/<name>/chat?token=…` upgrades to a WebSocket (404 for an unknown session). Server → client: `{ "type": "history", "messages": ChatMessage[] }` on connect (the last 200), `{ "type": "append", "messages" }` as the transcript grows (checked every 250 ms; a tool message comes again with its output under the same `id`), `{ "type": "reset" }` then a new `history` when the conversation changes, `{ "type": "unreadable" }` when there's no transcript to read. Close 4000 when the session ends.

`ChatMessage` (`src/chat.ts`): `user` (typed prompts only: no tool results, meta entries, command wrappers or system reminders), `assistant` (text blocks; thinking is skipped), `tool` (`name`, a one-line `summary`, `input`, later `output` and `error`; input and output at most 20 000 characters).

Client → server: `{ "type": "input", "id", "text" }` (pasted as a bracketed paste, then Enter; ESC is removed; at most 100 000 characters; an `id` seen in the last 100 is acknowledged and not typed again), `{ "type": "answer", "id", "at", "pick" }` (`at` = the prompt's `at`, when that wait started; presses the option's key, or replies "the question changed"), `{ "type": "interrupt", "id" }` (Esc). Replies: `{ "type": "ack", "id" }` or `{ "type": "error", "id", "error" }`.

While a socket has sent input, it keeps one zmx client attached for it, at the size the session was last shown at through blimpd (120×36 if never), and resized with it: a client of another size would resize the session for everyone.

`Prompt` (`src/prompt.ts`), from the hook's input: `permission` (`tool`, `summary`, `options`, `keys`), `question` (AskUserQuestion's `questions`), `other` (Elicitation). Permission options vary by command and only the screen shows them, so blimpd reads them from `zmx history` once per wait; without them they are Yes (`1`) and No (Esc). `answerable` is true for permissions and for one single-choice question, where a digit picks and submits; several questions or multi-select aren't answerable from the phone yet.
```

- [ ] **Step 2: SECURITY.md**

Add a row to the table, after "A crafted session name, folder or path":

```markdown
| Text sent from the phone | Send keys to a session (Esc, arrows, a fake end of paste) | `input` is pasted as a bracketed paste with every ESC removed, so it can't end the paste or press keys. Only `answer` (a digit for a known option, or Esc for No) and `interrupt` (Esc) send keys, and only those. |
```

- [ ] **Step 3: Spec "As built"**

Under section 2 of the spec, add `As built (part 1): <one line per deviation from this section, or "as written">`.

- [ ] **Step 4: Run all tests, commit**

Run: `bun test`
Expected: PASS

```bash
git add docs/DESIGN.md docs/SECURITY.md docs/superpowers/specs/2026-10-19-phone-app-design.md
git commit -m "Docs: the chat socket and waiting prompts"
```

---

## After this plan

- Release is not part of this plan: the Mac app doesn't use these routes, and part 2 (the iPhone app) is what makes them reachable. Release both together.
- Next plan: `docs/superpowers/plans/2026-10-19-phone-app-ios.md` (part 2, the iPhone app), written once this one is merged, against the protocol as built.
