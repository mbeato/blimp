# Phone Live Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One Live Activity, "blimp", on the iPhone's lock screen and in the Dynamic Island: on top a turn Max started
from the phone (title, letters, timer, and "Step n of m" with a bar and the step in progress when Claude keeps a task
list), below it the widgets' overview of every session, started and kept up to date by blimpd's pushes.

**Architecture:** blimpd works out what the panel shows (`src/live.ts`) from the session list, the turn it follows
(`src/followed.ts`, marked when a prompt reaches a session with the phone's token) and that turn's task list
(`src/steps.ts`, read from the transcript as `activity.ts` reads jobs). A third tick beside the push watcher and the
widgets' pinger (`src/push/live.ts`) starts the panel (through the open app, else a push-to-start), updates it on
change, ends it after 10 quiet minutes and restarts it at 7 h 45 min, on the shared Apple connection. The app hands
blimpd its push-to-start and panel tokens (`POST /push/live`, with the widget key so it works while locked) and has the
Settings switch; the widget extension draws the panel; BlimpKit holds its content model and words.

**Tech Stack:** Bun + TypeScript (blimpd, `bun test`); SwiftUI + ActivityKit + WidgetKit, iOS 26, Swift 6 (app) /
Swift 5 mode (widget extension); BlimpKit (Swift package, Swift Testing, Foundation only, also tested on Linux);
XcodeGen; GitHub Actions `.github/workflows/ios.yml`.

**Spec:** `docs/superpowers/specs/2026-10-26-phone-live-activity-design.md`

## Global Constraints

- Commits: plain sentences with an area prefix (`blimpd: …`, `BlimpKit: …`, `iPhone: …`, `Docs: …`). Never a
  `Co-Authored-By` line or any Claude attribution.
- bun is at `~/.bun/bin/bun` and not on PATH. Run server tests as `PATH=$HOME/.bun/bin:$PATH bun test <files>`
  (some tests start bun as a subprocess and fail with "Executable not found in $PATH: bun" otherwise).
- There is no Swift toolchain on this machine (Linux). Swift is compiled only in CI: Swift 6 for the app, Swift 5
  language mode for the widget extension, warnings as errors (`SWIFT_TREAT_WARNINGS_AS_ERRORS=YES`). Write Swift
  exactly as given, re-read every edited region, and match the surrounding style.
- BlimpKit stays Foundation-only (it is tested on Linux): no ActivityKit, WidgetKit, SwiftUI, CryptoKit or
  `FileManager.containerURL` in it.
- The app's root tint is `Color.primary`; a prominent button's label uses `.foregroundStyle(Color(.systemBackground))`.
  Switches in Settings are `.tint(.green)`, as the Notifications one.
- Exact values (from the spec): one Live Activity; `apns-push-type: liveactivity`, topic
  `dev.blimp.phone.push-type.liveactivity`, the same connection and key as notifications (`apnsFor` in
  `src/push/watch.ts`); `event` `start` / `update` / `end`; content-state under 4 KB (rows' titles cut to fit) and
  matching the Swift `ContentState` exactly with default JSON coding (times as numbers, in ms); updates on change only,
  priority 5, 10 for a new needs-you, no alert; the push-to-start's alert is quiet (no sound); ended after 10 minutes
  with nothing needing you or working, dismissed at once; ended and started again at 7 h 45 min; 3 rows under a followed
  turn, 4 without; tokens in push.json beside `devices` and `widgets`; the runner only while there's a push key and a
  push-to-start token.
- Words shown (from the spec): the switch `Live panel on the lock screen` (on by default); `Step 4 of 7`; the alert
  `blimp` / `2 need you, 3 working`; the widgets' symbols and words: `?` needs you, `✓` new, `●` working,
  `? 2 · ✓ 1 · ● 3`, `All quiet`.
- The Live Activity type is `BlimpActivityAttributes` (blimpd's `attributes-type`); its `ContentState` is BlimpKit's
  `LiveState`. The views live in the existing `BlimpWidgets` extension.
- Every UI test must be in a shard list in `.github/workflows/ios.yml`. (This plan adds none: the spec has the phone
  checklist cover the panel.)
- iOS CI: never start a manual iOS run (`gh workflow run iOS …`) while main's push iOS run is going; they share the
  MacBook's runners and ports.

## Decisions this plan makes (the spec leaves them open)

- **The widget key may send the panel's tokens.** iOS wakes the app to hand over the token of a panel blimpd started,
  usually while the phone is locked, when the Keychain (`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`) and so the
  phone's token can't be read. The App Group's `server.json` (the server's address and the widget key) can, as the lock
  screen widgets already rely on. So `POST`/`DELETE /push/live` take the widget key too; nothing else new does.
- **"The app starts it itself when open"**: blimpd decides, and asks every events socket opened with the phone's token
  to start the panel (`{ "type": "live", "state": … }`). The app starts it only if it is in front; if no panel token
  reaches blimpd 10 s on (or no such socket is open), blimpd sends the push-to-start. The app ends any second panel
  (blimpd's and the app's can cross).
- **The followed turn**: one at a time, the newest prompt from the phone; its own row is left out of the rows (it's on
  top); it shows even in a hidden project (Max sent it from the phone); it ends when the session is done since the
  prompt, or gone, or hasn't started 2 minutes on (so a prompt typed while Claude is still on an earlier turn is
  followed until that turn ends). Steps show only when the task list changed since the prompt (an
  older list is an earlier turn's), and a `TaskCreate` once every step is completed starts a new list.
- **A panel Max swiped away**, or whose token never came, gets no new start while things stay busy: blimpd keeps it as
  "up" until the quiet 10 minutes end it. Starting it again would bring back what he dismissed.
- **`GET /live`** answers what the panel shows now: the server tests check the followed turn through it.
- **Dynamic Island compact**: `?2` leading, `●3` trailing; while a followed turn runs, its timer replaces `●3`.

## File map

- Create `src/steps.ts`: the task list reader (TaskCreate, TaskUpdate, TodoWrite), incremental.
- Create `src/followed.ts`: the followed turn's mark.
- Create `src/live.ts`: what the panel shows, its change shape, the start's alert, the pushes' payloads, `liveNow`.
- Modify `src/push/store.ts`: push.json keeps `starts` and `activities` beside `devices` and `widgets`.
- Modify `src/server.ts`: `GET /live`, `POST`/`DELETE /push/live`, the widget key's reach, the follow on
  `POST /sessions` with a prompt, the phone's events sockets for the runner.
- Modify `src/chatsocket.ts`: the phone's input marks the session followed.
- Modify `src/push/apns.ts`: a `liveactivity` push type and a priority option.
- Create `src/push/live.ts`: the runner.
- Modify `src/push/watch.ts`: the runner's tick beside the watcher's and the pinger's.
- Tests: `test/steps.test.ts`, `test/followed.test.ts`, `test/live.test.ts`, `test/push-live.test.ts` (new);
  `test/push-store.test.ts`, `test/push-apns.test.ts`, `test/server.test.ts`.
- Create `ios/BlimpKit/Sources/BlimpKit/Live.swift`, `ios/BlimpKit/Tests/BlimpKitTests/LiveTests.swift`; modify
  `ios/BlimpKit/Sources/BlimpKit/Widgets.swift` (Hashable), `ios/BlimpKit/Sources/BlimpKit/Models.swift`
  (`EventsMessage.live`).
- Create `ios/Live/BlimpActivityAttributes.swift` (in both targets), `ios/Blimp/LiveShare.swift`; modify
  `ios/Blimp/Model/Store.swift`, `ios/Blimp/Push.swift`, `ios/Blimp/Views/SettingsView.swift`, `ios/project.yml`.
- Create `ios/BlimpWidgets/LiveView.swift`; modify `ios/BlimpWidgets/BlimpWidgets.swift`.
- Docs: `docs/DESIGN.md`, `docs/SECURITY.md`, `ios/README.md`, `docs/PHONE-CHECKLIST.md`.

---

### Task 1: blimpd reads the steps of Claude's task list from a transcript

**Files:**
- Create: `src/steps.ts`
- Test: `test/steps.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks. The transcript format (Claude Code 2.1.284, captured October 2026):
  - `TaskCreate`: Claude's `tool_use` input is `{ subject, description }`; the id is only in the result line, a
    `type: "user"` line with `toolUseResult: { task: { id: "1", subject } }` (content
    `"Task #1 created successfully: <subject>"`).
  - `TaskUpdate`: Claude's `tool_use` input is `{ taskId: "1", status?, subject?, activeForm? }`, status `pending`,
    `in_progress`, `completed` (or `deleted`); its result says
    `toolUseResult: { success: true, taskId, updatedFields, statusChange: { from, to } }`.
  - `TodoWrite` (older versions; not in any transcript on hand): input `{ todos: [{ content, status, activeForm }] }`.
- Produces:
  - `type Steps = { done: number; total: number; current?: string }`
  - `type StepScan`, `newStepScan(): StepScan`, `lineSteps(line: string): StepEvent[]`,
    `foldSteps(s: StepScan, events: StepEvent[]): void`, `shownSteps(s: StepScan): Steps | undefined`
  - `transcriptSteps(file: string): { steps?: Steps; at: number } | undefined` (`at`: when the list last changed, ms;
    undefined when the file can't be opened)

- [ ] **Step 1: Write the failing test**

Create `test/steps.test.ts`:

```ts
// The followed turn's steps (src/steps.ts), from Claude Code's task list tools in a transcript. The TaskCreate and
// TaskUpdate lines are captured from Claude Code 2.1.284 (October 2026) with the task text replaced by neutral words
// and the fields that don't matter here left out. TodoWrite isn't in any transcript on hand (2.1.284 uses the task
// tools), so its line is built from its documented input: { todos: [{ content, status, activeForm }] }.

import { afterAll, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foldSteps, lineSteps, newStepScan, shownSteps, transcriptSteps } from "../src/steps";

const dir = mkdtempSync(join(tmpdir(), "blimp-steps-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Claude's call, then its result, which says the new task's id.
const create = (id: string, subject: string, ts = "2026-10-07T13:53:25.158Z") => [
  `{"parentUuid":"p${id}","isSidechain":false,"message":{"model":"claude-opus-5-5","id":"msg_011CfnzHZSGMxk9PusBPSTU6","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_c${id}","name":"TaskCreate","input":{"subject":"${subject}","description":"Neutral words about it."},"caller":{"type":"direct"}}],"stop_reason":"tool_use"},"type":"assistant","uuid":"a${id}","timestamp":"${ts}","sessionId":"52e03410-a0a3-4168-8f47-dbdd4e5a10ec","version":"2.1.284"}`,
  `{"parentUuid":"a${id}","isSidechain":false,"promptId":"59dd4803-7df1-46cd-ab3f-49e0925a8c9b","type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_c${id}","type":"tool_result","content":"Task #${id} created successfully: ${subject}"}]},"uuid":"r${id}","timestamp":"${ts}","toolUseResult":{"task":{"id":"${id}","subject":"${subject}"}},"sourceToolAssistantUUID":"a${id}","sessionId":"52e03410-a0a3-4168-8f47-dbdd4e5a10ec","version":"2.1.284"}`,
];
// input as Claude sent it; the result as Claude Code answered.
const update = (id: string, input: string, from: string, to: string, ts = "2026-10-07T13:53:31.129Z") => [
  `{"parentUuid":"q${id}","isSidechain":false,"message":{"model":"claude-opus-5-5","id":"msg_011CfnzJ3GpqP1f7hWaznPnZ","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_u${id}${to}","name":"TaskUpdate","input":${input},"caller":{"type":"direct"}}],"stop_reason":"tool_use"},"type":"assistant","uuid":"b${id}${to}","timestamp":"${ts}","sessionId":"52e03410-a0a3-4168-8f47-dbdd4e5a10ec","version":"2.1.284"}`,
  `{"parentUuid":"b${id}${to}","isSidechain":false,"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_u${id}${to}","type":"tool_result","content":"Updated task #${id} status"}]},"uuid":"s${id}${to}","timestamp":"${ts}","toolUseResult":{"success":true,"taskId":"${id}","updatedFields":["status"],"statusChange":{"from":"${from}","to":"${to}"}},"sessionId":"52e03410-a0a3-4168-8f47-dbdd4e5a10ec","version":"2.1.284"}`,
];
const todos = (list: object[], ts = "2026-10-07T14:00:00.000Z") =>
  `{"isSidechain":false,"message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_t1","name":"TodoWrite","input":{"todos":${JSON.stringify(list)}}}]},"type":"assistant","uuid":"t1","timestamp":"${ts}"}`;

const read = (lines: string[]) => {
  const s = newStepScan();
  for (const line of lines) foldSteps(s, lineSteps(line));
  return s;
};

test("TaskCreate's id comes from its result; the call alone adds nothing", () => {
  const [call, result] = create("1", "Write the test");
  expect(lineSteps(call)).toEqual([]);
  expect(lineSteps(result)).toEqual([{ type: "create", at: Date.parse("2026-10-07T13:53:25.158Z"), id: "1", subject: "Write the test" }]);
});

test("TaskUpdate's input changes a step's status and words; its result adds nothing", () => {
  const [call, result] = update("1", '{"taskId":"1","subject":"Write the tests","status":"in_progress","activeForm":"Writing the tests"}', "pending", "in_progress");
  expect(lineSteps(call)).toEqual([{ type: "update", at: Date.parse("2026-10-07T13:53:31.129Z"), id: "1", status: "in_progress", subject: "Write the tests", active: "Writing the tests" }]);
  expect(lineSteps(result)).toEqual([]);
});

test("done of total, and the step in progress", () => {
  const s = read([
    ...create("1", "Write the test"),
    ...create("2", "Make it pass"),
    ...create("3", "Commit"),
    ...update("1", '{"taskId":"1","status":"completed"}', "pending", "completed"),
    ...update("2", '{"taskId":"2","status":"in_progress"}', "pending", "in_progress"),
  ]);
  expect(shownSteps(s)).toEqual({ done: 1, total: 3, current: "Make it pass" });
  expect(s.at).toBe(Date.parse("2026-10-07T13:53:31.129Z"));
});

test("a step's activeForm is its words while in progress; deleted takes it out; an unknown id changes nothing", () => {
  const s = read([
    ...create("1", "Run the tests"),
    ...create("2", "Tidy up"),
    ...update("1", '{"taskId":"1","status":"in_progress","activeForm":"Running the tests"}', "pending", "in_progress"),
    ...update("2", '{"taskId":"2","status":"deleted"}', "pending", "deleted"),
    ...update("9", '{"taskId":"9","status":"completed"}', "pending", "completed", "2026-10-07T15:00:00.000Z"),
  ]);
  expect(shownSteps(s)).toEqual({ done: 0, total: 1, current: "Running the tests" });
  expect(s.at).toBe(Date.parse("2026-10-07T13:53:31.129Z"));
});

test("a TaskCreate once every step is completed starts a new list, as the captured session's tasks 7 to 9 did", () => {
  const done = (id: string) => update(id, `{"taskId":"${id}","status":"completed"}`, "pending", "completed");
  const s = read([...create("1", "Check one"), ...create("2", "Check two"), ...done("1"), ...done("2"), ...create("7", "Write the file"), ...create("8", "Count the uses")]);
  expect(shownSteps(s)).toEqual({ done: 0, total: 2 });
});

test("a subagent's task list isn't the turn's", () => {
  const [, result] = create("1", "Write the test");
  expect(lineSteps(result.replace('"isSidechain":false', '"isSidechain":true'))).toEqual([]);
});

test("TodoWrite: each call is the whole list", () => {
  const s = read([
    todos([
      { content: "Write the test", status: "completed", activeForm: "Writing the test" },
      { content: "Make it pass", status: "in_progress", activeForm: "Making it pass" },
      { content: "Commit", status: "pending", activeForm: "Committing" },
    ]),
  ]);
  expect(shownSteps(s)).toEqual({ done: 1, total: 3, current: "Making it pass" });
  foldSteps(s, lineSteps(todos([{ content: "Commit", status: "in_progress", activeForm: "Committing" }])));
  expect(shownSteps(s)).toEqual({ done: 0, total: 1, current: "Committing" });
});

test("no task list: no steps; a prompt that only mentions the tools is no call", () => {
  expect(shownSteps(newStepScan())).toBeUndefined();
  const prompt = `{"type":"user","message":{"role":"user","content":"use TodoWrite, or TaskCreate and TaskUpdate"},"isSidechain":false}`;
  expect(lineSteps(prompt)).toEqual([]);
  expect(lineSteps("not json")).toEqual([]);
});

test("the in-progress step's words are cut to 80 characters", () => {
  const s = read([...create("1", "x".repeat(200)), ...update("1", '{"taskId":"1","status":"in_progress"}', "pending", "in_progress")]);
  expect(shownSteps(s)?.current).toBe("x".repeat(80));
});

test("a transcript is read once, then only what was added; an unfinished last line waits", () => {
  const file = join(dir, "t.jsonl");
  writeFileSync(file, [...create("1", "Write the test"), ...create("2", "Make it pass")].join("\n") + "\n");
  expect(transcriptSteps(file)?.steps).toEqual({ done: 0, total: 2 });
  const [call, result] = update("1", '{"taskId":"1","status":"in_progress"}', "pending", "in_progress");
  appendFileSync(file, call + "\n" + result);
  expect(transcriptSteps(file)?.steps).toEqual({ done: 0, total: 2, current: "Write the test" });
  appendFileSync(file, "\n" + update("1", '{"taskId":"1","status":"completed"}', "in_progress", "completed").join("\n") + "\n");
  expect(transcriptSteps(file)?.steps).toEqual({ done: 1, total: 2 });
  expect(transcriptSteps(join(dir, "missing.jsonl"))).toBeUndefined();
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `PATH=$HOME/.bun/bin:$PATH bun test test/steps.test.ts`
Expected: FAIL (cannot find module `../src/steps`).

- [ ] **Step 3: Write the reader**

Create `src/steps.ts`:

```ts
// The followed turn's steps (docs/superpowers/specs/2026-10-26-phone-live-activity-design.md, "Steps"), read from its
// transcript as activity.ts reads jobs (Claude Code's internal format, so checked against captured real lines in
// test/steps.test.ts): TaskCreate adds a step (its id is only in the result: toolUseResult.task), TaskUpdate changes
// one's status or words (its input: taskId, status, subject, activeForm; status "deleted" takes it out), and older
// versions' TodoWrite gives the whole list each time. A TaskCreate once every step is completed starts a new list.
// Only the main thread counts: a subagent's list is its own. Read once, then only the lines added since.

import { closeSync, openSync, readSync, statSync } from "node:fs";

export type StepStatus = "pending" | "in_progress" | "completed";
type Step = { id: string; subject: string; status: StepStatus; active?: string };
export type StepEvent =
  | { type: "create"; at: number; id: string; subject: string }
  | { type: "update"; at: number; id: string; status?: StepStatus | "deleted"; subject?: string; active?: string }
  | { type: "todos"; at: number; steps: Step[] };
// at: when the list last changed (ms).
export type StepScan = { offset: number; skipping?: boolean; steps: Step[]; at: number };
// What the panel shows: done of total, and the step in progress in Claude's words (its activeForm, else its subject).
export type Steps = { done: number; total: number; current?: string };

export const newStepScan = (): StepScan => ({ offset: 0, steps: [], at: 0 });

const MAX_STEPS = 100;
const STATUSES: string[] = ["pending", "in_progress", "completed"];
const isStatus = (v: unknown): v is StepStatus => typeof v === "string" && STATUSES.includes(v);
const time = (r: any) => Date.parse(r?.timestamp) || 0;
const cut = (s: string, n: number) => Array.from(s).slice(0, n).join("");

// What a parsed line says.
export function recordSteps(r: any): StepEvent[] {
  if (!r || typeof r !== "object" || r.isSidechain === true) return [];
  const at = time(r);
  const task = r.type === "user" ? r.toolUseResult?.task : undefined;
  if (task && typeof task.id === "string" && typeof task.subject === "string") return [{ type: "create", at, id: task.id, subject: task.subject }];
  if (r.type !== "assistant" || !Array.isArray(r.message?.content)) return [];
  const out: StepEvent[] = [];
  for (const b of r.message.content) {
    const i = b?.type === "tool_use" ? b.input : undefined;
    if (!i || typeof i !== "object") continue;
    if (b.name === "TaskUpdate" && typeof i.taskId === "string")
      out.push({
        type: "update",
        at,
        id: i.taskId,
        ...((isStatus(i.status) || i.status === "deleted") && { status: i.status }),
        ...(typeof i.subject === "string" && { subject: i.subject }),
        ...(typeof i.activeForm === "string" && { active: i.activeForm }),
      });
    if (b.name === "TodoWrite" && Array.isArray(i.todos))
      out.push({
        type: "todos",
        at,
        steps: i.todos
          .filter((t: any) => typeof t?.content === "string" && isStatus(t?.status))
          .map((t: any, n: number) => ({ id: String(n), subject: t.content, status: t.status, ...(typeof t.activeForm === "string" && { active: t.activeForm }) })),
      });
  }
  return out;
}

// Most lines say nothing here (api-request lines are most of a transcript), so a quick look first.
export function lineSteps(line: string): StepEvent[] {
  if (line.startsWith('{"type":"api-request')) return [];
  if (!line.includes('"toolUseResult":{"task":{') && !line.includes('"name":"TaskUpdate"') && !line.includes('"name":"TodoWrite"')) return [];
  try {
    return recordSteps(JSON.parse(line));
  } catch {
    return [];
  }
}

export function foldSteps(s: StepScan, events: StepEvent[]) {
  for (const e of events) {
    if (e.type === "create") {
      if (s.steps.every((x) => x.status === "completed")) s.steps = [];
      s.steps = [...s.steps.filter((x) => x.id !== e.id), { id: e.id, subject: e.subject, status: "pending" as const }].slice(-MAX_STEPS);
    } else if (e.type === "update") {
      const x = s.steps.find((y) => y.id === e.id);
      if (!x) continue;
      if (e.status === "deleted") s.steps = s.steps.filter((y) => y !== x);
      else {
        if (e.status) x.status = e.status;
        if (e.subject !== undefined) x.subject = e.subject;
        if (e.active !== undefined) x.active = e.active;
      }
    } else s.steps = e.steps.slice(0, MAX_STEPS);
    s.at = e.at;
  }
}

// None: no task list (or an empty one).
export function shownSteps(s: StepScan): Steps | undefined {
  if (!s.steps.length) return;
  const now = s.steps.find((x) => x.status === "in_progress");
  const current = now && (now.active || now.subject).replace(/\s+/g, " ").trim();
  return { done: s.steps.filter((x) => x.status === "completed").length, total: s.steps.length, ...(current && { current: cut(current, 80) }) };
}

// As transcriptActivity (activity.ts) reads: a chunk at a time, a line that fills a whole chunk skipped, an unfinished
// last line left for next time. Only the followed session's transcript is read, so a few scans are kept.
const scans = new Map<string, StepScan>();
const CHUNK = 16 << 20;

export function transcriptSteps(file: string, chunk = CHUNK): { steps?: Steps; at: number } | undefined {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return;
  }
  try {
    const size = statSync(file).size;
    let s = scans.get(file);
    if (!s || size < s.offset) {
      if (scans.size >= 10) scans.clear();
      scans.set(file, (s = newStepScan())); // new, or rewritten shorter
    }
    while (s.offset < size) {
      const buf = Buffer.alloc(Math.min(chunk, size - s.offset));
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
        if (start > 0) s.offset += start;
        else if (s.offset + n < size) {
          s.skipping = true;
          s.offset += n;
        } else break; // the last line is still being written
        continue;
      }
      for (const line of buf.toString("utf8", start, end).split("\n")) foldSteps(s, lineSteps(line));
      s.offset += end + 1;
    }
    return { steps: shownSteps(s), at: s.at };
  } finally {
    closeSync(fd);
  }
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `PATH=$HOME/.bun/bin:$PATH bun test test/steps.test.ts`
Expected: 10 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/steps.ts test/steps.test.ts
git commit -m "blimpd: reads the steps of Claude's task list from a transcript, as activity.ts reads jobs: TaskCreate's result adds one, TaskUpdate changes its status or words, TodoWrite gives the whole list, a TaskCreate after every step is done starts a new list; done, total and the step in progress, checked against captured lines"
```

---

### Task 2: blimpd's followed turn and what the live panel shows

**Files:**
- Create: `src/followed.ts`, `src/live.ts`
- Test: `test/followed.test.ts`, `test/live.test.ts`

**Interfaces:**
- Consumes: `transcriptSteps`, `type Steps` from `src/steps.ts` (Task 1); `widgetSummary`, `type WidgetRow`,
  `type WidgetState`, `type WidgetSummary` from `src/widget.ts`; `readHidden` from `src/hidden.ts`; `Session` from
  `src/sessions.ts` (fields used: `name`, `dir`, `title`, `state`, `stateSince?`, `transcript?`).
- Produces (`src/followed.ts`):
  - `START_GRACE = 2 * 60_000`
  - `markFollowed(session: string, now?: number): void`, `clearFollowed(): void`
  - `followed(list: Session[], now?: number): { session: Session; at: number } | undefined`
- Produces (`src/live.ts`):
  - `type LiveTurn = { session: string; dir: string; title: string; state: WidgetState; since: number; steps?: Steps }`
  - `type LiveState = { turn?: LiveTurn; rows: WidgetRow[]; counts: WidgetSummary["counts"] }`
  - `type LiveEvent = "start" | "update" | "end"`
  - `ROWS_UNDER_TURN = 3`, `ROWS_ALONE = 4`, `MAX_STATE = 3500`, `ATTRIBUTES_TYPE = "BlimpActivityAttributes"`
  - `liveState(sessions: Session[], hidden: Set<string>, turn: { session: Session; at: number; steps?: Steps } | undefined, now?: number): LiveState`
  - `liveShape(l: LiveState): string`, `isBusy(l: LiveState): boolean`
  - `liveAlert(l: LiveState): { title: string; body: string }`
  - `livePayload(event: LiveEvent, l: LiveState, now: number): { aps: Record<string, unknown> }`
  - `liveNow(list: Session[], now?: number): LiveState`

- [ ] **Step 1: Write the followed turn's failing test**

Create `test/followed.test.ts`:

```ts
// The followed turn (src/followed.ts): the session last sent a prompt from the phone, until that turn ends.

import { beforeEach, expect, test } from "bun:test";
import { clearFollowed, followed, markFollowed, START_GRACE } from "../src/followed";
import type { Session } from "../src/sessions";

const T = 1_800_000_000_000;
const s = (name: string, o: Partial<Session> = {}): Session => ({
  name,
  pid: 1,
  clients: 0,
  created: (T - 3_600_000) / 1000,
  dir: "/u/blimp",
  cmd: "claude",
  kind: "claude",
  title: name,
  status: "idle",
  state: "done",
  stateSince: T - 60_000,
  unread: false,
  ...o,
});

beforeEach(clearFollowed);

test("none until a prompt goes in from the phone", () => {
  expect(followed([s("a")], T)).toBeUndefined();
});

test("the session and when its prompt went in, while it works and while it waits on you", () => {
  markFollowed("a", T);
  expect(followed([s("a")], T + 1000)?.at).toBe(T); // Claude hasn't started yet
  const working = s("a", { state: "working", stateSince: T + 500 });
  expect(followed([working, s("b")], T + 2000)?.session).toBe(working);
  expect(followed([s("a", { state: "waiting", stateSince: T + 9000 })], T + 10_000)?.session.name).toBe("a");
});

test("it ends when the session is done since the prompt, and stays ended", () => {
  markFollowed("a", T);
  expect(followed([s("a", { state: "done", stateSince: T + 60_000 })], T + 61_000)).toBeUndefined();
  expect(followed([s("a", { state: "working", stateSince: T + 70_000 })], T + 71_000)).toBeUndefined();
});

test("it ends when the session is gone; an empty list (a failed zmx list) keeps it", () => {
  markFollowed("a", T);
  expect(followed([], T + 1000)).toBeUndefined();
  expect(followed([s("a")], T + 1000)?.session.name).toBe("a");
  expect(followed([s("b")], T + 2000)).toBeUndefined();
  expect(followed([s("a")], T + 3000)).toBeUndefined();
});

test("a turn that hasn't started 2 minutes on ends", () => {
  markFollowed("a", T);
  expect(followed([s("a")], T + START_GRACE - 1)?.session.name).toBe("a");
  expect(followed([s("a")], T + START_GRACE)).toBeUndefined();
});

test("the newest prompt from the phone is the followed one", () => {
  markFollowed("a", T);
  markFollowed("b", T + 1000);
  const list = [s("a", { state: "working" }), s("b", { state: "working" })];
  expect(followed(list, T + 2000)?.session.name).toBe("b");
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `PATH=$HOME/.bun/bin:$PATH bun test test/followed.test.ts`
Expected: FAIL (cannot find module `../src/followed`).

- [ ] **Step 3: Write the followed turn**

Create `src/followed.ts`:

```ts
// The followed turn (docs/superpowers/specs/2026-10-26-phone-live-activity-design.md): the session Max last sent a
// prompt to from the phone (a chat socket's input, or a new session's first message, with the phone's token), until
// that turn ends: the session is done since the prompt, or gone. Waiting on Max keeps it: the turn goes on. One that
// hasn't started 2 minutes on (the prompt never reached Claude) ends too. One at a time, in memory: a restart of
// blimpd forgets it.

import type { Session } from "./sessions";

export const START_GRACE = 2 * 60_000;

let mark: { session: string; at: number } | undefined;

export const markFollowed = (session: string, now = Date.now()) => void (mark = { session, at: now });
export const clearFollowed = () => void (mark = undefined);

// The followed session and when its prompt went in (ms), or none. An empty list is more likely a zmx list that
// failed than every session gone (as in push/watch.ts), so it keeps the mark.
export function followed(list: Session[], now = Date.now()): { session: Session; at: number } | undefined {
  const m = mark;
  if (!m || !list.length) return;
  const s = list.find((x) => x.name === m.session);
  const ended = !s || (s.state === "done" && (s.stateSince ?? 0) >= m.at);
  const never = s && s.state !== "working" && s.state !== "waiting" && now - m.at >= START_GRACE;
  if (ended || never) return void (mark = undefined);
  return { session: s, at: m.at };
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `PATH=$HOME/.bun/bin:$PATH bun test test/followed.test.ts`
Expected: 6 pass, 0 fail.

- [ ] **Step 5: Write the panel's failing test**

Create `test/live.test.ts`:

```ts
// What the phone's live panel shows (src/live.ts): the followed turn on top, the widgets' rows under it, the counts,
// and the pushes that carry it, under Apple's 4 KB.

import { expect, test } from "bun:test";
import { isBusy, liveAlert, livePayload, liveShape, liveState, MAX_STATE, ROWS_ALONE, ROWS_UNDER_TURN } from "../src/live";
import type { Session } from "../src/sessions";

const T = 1_800_000_000_000;
const s = (name: string, o: Partial<Session> = {}): Session => ({
  name,
  pid: 1,
  clients: 0,
  created: (T - 3_600_000) / 1000,
  dir: "/u/blimp",
  cmd: "claude",
  kind: "claude",
  title: name,
  status: "busy",
  state: "working",
  stateSince: T - 60_000,
  unread: false,
  ...o,
});
const many = (n: number) => Array.from({ length: n }, (_, i) => s(`w${i}`, { stateSince: T - 1000 * (i + 1) }));

test("without a followed turn: the widgets' first 4 rows and every count", () => {
  const l = liveState([s("ask", { state: "waiting", stateSince: T - 5000 }), ...many(6)], new Set(), undefined, T);
  expect(ROWS_ALONE).toBe(4);
  expect(l.turn).toBeUndefined();
  expect(l.rows.map((r) => [r.session, r.state])).toEqual([["ask", "needs"], ["w5", "working"], ["w4", "working"], ["w3", "working"]]);
  expect(l.counts).toEqual({ needs: 1, new: 0, working: 6 });
});

test("a followed turn on top: its title, project, state, when its prompt went in, its steps; 3 rows under it, its own left out", () => {
  const followed = s("phone", { title: "Server update", dir: "/u/cq", stateSince: T - 2000 });
  const steps = { done: 3, total: 7, current: "Running the tests" };
  const l = liveState([followed, ...many(5)], new Set(), { session: followed, at: T - 3000, steps }, T);
  expect(ROWS_UNDER_TURN).toBe(3);
  expect(l.turn).toEqual({ session: "phone", dir: "/u/cq", title: "Server update", state: "working", since: T - 3000, steps });
  expect(l.rows.map((r) => r.session)).toEqual(["w4", "w3", "w2"]);
  expect(l.counts.working).toBe(6);
});

test("a followed turn waiting on you shows as needs you; without a task list it has no steps", () => {
  const followed = s("phone", { state: "waiting" });
  const l = liveState([followed], new Set(), { session: followed, at: T }, T);
  expect(l.turn?.state).toBe("needs");
  expect(l.turn && "steps" in l.turn).toBe(false);
});

test("the hidden projects' sessions are left out, as in the widgets; a followed turn shows whatever its project", () => {
  const secret = s("secret", { dir: "/u/secret" });
  const l = liveState([secret, s("a")], new Set(["/u/secret"]), { session: secret, at: T }, T);
  expect(l.rows.map((r) => r.session)).toEqual(["a"]);
  expect(l.counts.working).toBe(1);
  expect(l.turn?.session).toBe("secret");
});

test("titles are cut to 80 characters, then shorter until the content-state is at most 3500 bytes", () => {
  const long = "🎈".repeat(500);
  const l = liveState([s("t", { title: long }), ...many(4).map((x) => ({ ...x, title: long }))], new Set(), undefined, T);
  expect(Buffer.byteLength(JSON.stringify(l))).toBeLessThanOrEqual(MAX_STATE);
  const short = liveState([s("t", { title: "x".repeat(100) })], new Set(), undefined, T);
  expect(short.rows[0].title).toBe("x".repeat(80));
  // the whole push stays under Apple's 4 KB
  const followed = s("f", { title: long });
  const full = liveState([followed, ...many(4).map((x) => ({ ...x, title: long }))], new Set(), { session: followed, at: T, steps: { done: 1, total: 9, current: "y".repeat(80) } }, T);
  expect(Buffer.byteLength(JSON.stringify(livePayload("start", full, T)))).toBeLessThanOrEqual(4096);
});

test("a change is the counts, a row's state or title, or the turn's state, title or step; not the time", () => {
  const followed = s("f");
  const base = liveShape(liveState([followed, s("a")], new Set(), { session: followed, at: T, steps: { done: 1, total: 3 } }, T));
  const later = liveShape(liveState([followed, s("a")], new Set(), { session: followed, at: T, steps: { done: 1, total: 3 } }, T + 60_000));
  expect(later).toBe(base);
  expect(liveShape(liveState([followed, s("a", { title: "renamed" })], new Set(), { session: followed, at: T, steps: { done: 1, total: 3 } }, T))).not.toBe(base);
  expect(liveShape(liveState([followed, s("a")], new Set(), { session: followed, at: T, steps: { done: 2, total: 3 } }, T))).not.toBe(base);
  expect(liveShape(liveState([followed, s("a", { state: "waiting" })], new Set(), { session: followed, at: T, steps: { done: 1, total: 3 } }, T))).not.toBe(base);
});

test("busy: something needs you or works, or a followed turn runs", () => {
  expect(isBusy(liveState([s("a", { state: "done", unread: true })], new Set(), undefined, T))).toBe(false);
  expect(isBusy(liveState([s("a")], new Set(), undefined, T))).toBe(true);
  expect(isBusy(liveState([s("a", { state: "waiting" })], new Set(), undefined, T))).toBe(true);
  const secret = s("secret", { dir: "/u/secret" });
  expect(isBusy(liveState([secret], new Set(["/u/secret"]), { session: secret, at: T }, T))).toBe(true);
});

test("the start's alert: what needs you and what works, else the turn's title", () => {
  const l = liveState([s("a", { state: "waiting" }), s("b", { state: "waiting" }), ...many(3)], new Set(), undefined, T);
  expect(liveAlert(l)).toEqual({ title: "blimp", body: "2 need you, 3 working" });
  expect(liveAlert(liveState([s("a", { state: "waiting" })], new Set(), undefined, T)).body).toBe("1 needs you");
  const secret = s("secret", { dir: "/u/secret", title: "Hidden work" });
  expect(liveAlert(liveState([secret], new Set(["/u/secret"]), { session: secret, at: T }, T)).body).toBe("Hidden work");
});

test("the pushes: start with its type, attributes, alert (no sound) and token request; update; end dismissed at once", () => {
  const l = liveState([s("a")], new Set(), undefined, T);
  expect(livePayload("start", l, T + 999)).toEqual({
    aps: {
      timestamp: T / 1000,
      event: "start",
      "content-state": l,
      "attributes-type": "BlimpActivityAttributes",
      attributes: {},
      alert: { title: "blimp", body: "1 working" },
      "input-push-token": 1,
    },
  });
  expect(livePayload("update", l, T)).toEqual({ aps: { timestamp: T / 1000, event: "update", "content-state": l } });
  expect(livePayload("end", l, T)).toEqual({ aps: { timestamp: T / 1000, event: "end", "content-state": l, "dismissal-date": T / 1000 } });
});
```

- [ ] **Step 6: Run it to see it fail**

Run: `PATH=$HOME/.bun/bin:$PATH bun test test/live.test.ts`
Expected: FAIL (cannot find module `../src/live`).

- [ ] **Step 7: Write what the panel shows**

Create `src/live.ts`:

```ts
// What the phone's live panel shows (docs/superpowers/specs/2026-10-26-phone-live-activity-design.md, "What it
// shows"): on top the followed turn (followed.ts), with its steps (steps.ts) when Claude keeps a task list; then the
// widgets' rows (widget.ts: needs you, new, working, the hidden projects' left out; the followed session's own row left
// out, it's on top), 3 under a followed turn, 4 without, and the counts. It goes to Apple as the Live Activity's
// content-state, which iOS decodes into BlimpKit's LiveState (ios/BlimpKit/Sources/BlimpKit/Live.swift): the same
// names, times in ms as numbers. Apple takes at most 4 KB a push, so titles are cut to fit.

import { followed } from "./followed";
import { readHidden } from "./hidden";
import type { Session } from "./sessions";
import { type Steps, transcriptSteps } from "./steps";
import { type WidgetRow, type WidgetState, type WidgetSummary, widgetSummary } from "./widget";

// state: needs while it waits on you, else working. since: when the prompt went in (ms).
export type LiveTurn = { session: string; dir: string; title: string; state: WidgetState; since: number; steps?: Steps };
export type LiveState = { turn?: LiveTurn; rows: WidgetRow[]; counts: WidgetSummary["counts"] };
export type LiveEvent = "start" | "update" | "end";

export const ROWS_UNDER_TURN = 3;
export const ROWS_ALONE = 4;
// The content-state's JSON at most, in bytes: the rest of a push (its aps, the start's alert) fits in Apple's 4096.
export const MAX_STATE = 3500;
// The Swift type's name, for a push-to-start (ios/Live/BlimpActivityAttributes.swift).
export const ATTRIBUTES_TYPE = "BlimpActivityAttributes";
const TITLE = 80;

const cut = (s: string, n: number) => Array.from(s).slice(0, n).join("");
const bytes = (l: LiveState) => Buffer.byteLength(JSON.stringify(l));

export function liveState(sessions: Session[], hidden: Set<string>, turn: { session: Session; at: number; steps?: Steps } | undefined, now = Date.now()): LiveState {
  const w = widgetSummary(sessions, hidden, now);
  const rows = w.rows.filter((r) => r.session !== turn?.session.name).slice(0, turn ? ROWS_UNDER_TURN : ROWS_ALONE);
  const t = turn && {
    session: turn.session.name,
    dir: turn.session.dir,
    title: turn.session.title,
    state: (turn.session.state === "waiting" ? "needs" : "working") as WidgetState,
    since: turn.at,
    ...(turn.steps && { steps: turn.steps }),
  };
  // Titles at most 80 characters, then 10 fewer at a time until it fits.
  const fit = (n: number): LiveState => ({
    ...(t && { turn: { ...t, title: cut(t.title, n) } }),
    rows: rows.map((r) => ({ ...r, title: cut(r.title, n) })),
    counts: w.counts,
  });
  let n = TITLE;
  let l = fit(n);
  while (bytes(l) > MAX_STATE && n > 10) l = fit((n -= 10));
  return l;
}

// What the panel shows, for the runner to tell a change: the counts, the rows with their states and titles, the turn
// with its state, title and steps. The timers ticking isn't a change: the panel counts them up by itself.
export const liveShape = (l: LiveState) =>
  JSON.stringify([l.counts, l.rows.map((r) => [r.session, r.state, r.title]), l.turn ? [l.turn.session, l.turn.state, l.turn.title, l.turn.steps ?? null] : null]);

// The panel runs while something needs you or works, or a followed turn runs.
export const isBusy = (l: LiveState) => l.counts.needs > 0 || l.counts.working > 0 || !!l.turn;

// A push-to-start's alert (Apple wants one): "2 need you, 3 working", no sound.
export function liveAlert(l: LiveState): { title: string; body: string } {
  const parts: string[] = [];
  if (l.counts.needs) parts.push(`${l.counts.needs} ${l.counts.needs === 1 ? "needs" : "need"} you`);
  if (l.counts.working) parts.push(`${l.counts.working} working`);
  return { title: "blimp", body: parts.length ? parts.join(", ") : (l.turn?.title ?? "") };
}

const secs = (ms: number) => Math.floor(ms / 1000);

// A Live Activity push: start (a push-to-start, with its type, its empty attributes, the alert, and a request for the
// new panel's own push token), update, or end (dismissed at once).
export function livePayload(event: LiveEvent, l: LiveState, now: number): { aps: Record<string, unknown> } {
  const aps: Record<string, unknown> = { timestamp: secs(now), event, "content-state": l };
  if (event === "start") Object.assign(aps, { "attributes-type": ATTRIBUTES_TYPE, attributes: {}, alert: liveAlert(l), "input-push-token": 1 });
  if (event === "end") aps["dismissal-date"] = secs(now);
  return { aps };
}

// What the panel shows now: the session list, the hidden projects, the followed turn, and its steps if its task list
// changed since its prompt went in (an older list is an earlier turn's).
export function liveNow(list: Session[], now = Date.now()): LiveState {
  const f = followed(list, now);
  const read = f?.session.transcript ? transcriptSteps(f.session.transcript) : undefined;
  const steps = f && read?.steps && read.at >= f.at ? read.steps : undefined;
  return liveState(list, new Set(readHidden()), f && { ...f, steps }, now);
}
```

The push-to-start's `input-push-token: 1` (iOS 18+: the new panel gets its own push token, which iOS hands the app) is
from memory of Apple's "Starting and updating Live Activities with ActivityKit push notifications". If Apple answers a
start with 400 and a reason naming the payload (blimpd logs `push: Apple said 400 (…) to the live panel`), take the key
out: the app still sends the token from `pushTokenUpdates` (Task 6).

- [ ] **Step 8: Run both to see them pass**

Run: `PATH=$HOME/.bun/bin:$PATH bun test test/followed.test.ts test/live.test.ts test/widget.test.ts`
Expected: 0 fail.

- [ ] **Step 9: Commit**

```bash
git add src/followed.ts src/live.ts test/followed.test.ts test/live.test.ts
git commit -m "blimpd: the live panel's content: the turn followed from the phone on top (its title, project, state, timer start and steps), then the widgets' rows without it (3 under a turn, 4 without) and the counts, titles cut to keep a push under Apple's 4 KB; its change shape, the quiet start alert, and the start, update and end payloads"
```

---

### Task 3: blimpd's live panel routes and tokens, and following a turn sent from the phone

**Files:**
- Modify: `src/push/store.ts`
- Modify: `src/server.ts` (imports near line 25, `authorized`'s comment near line 84, `POST /sessions` near line 143, a
  new block before `if (path === "/events" && get)` near line 286, the fetch handler's widget key check near line 455)
- Modify: `src/chatsocket.ts` (`ChatData`, imports, `handle`'s `input` branch)
- Test: `test/push-store.test.ts`, `test/server.test.ts`
- Docs: `docs/DESIGN.md`, `docs/SECURITY.md`

**Interfaces:**
- Consumes: `markFollowed` from `src/followed.ts`, `liveNow` from `src/live.ts` (Task 2).
- Produces (store): `isLiveToken(t: unknown): t is string`, `type LiveList = "starts" | "activities"`,
  `readLive(list: LiveList, file?): Device[]` (newest first), `addLive(list, token, env, now?, file?): Device[]`,
  `removeLive(list, token, file?): Device[]`, `clearLive(list, file?): void`. The device and widget functions keep
  their signatures and behaviour; `clearDevices` removes the live lists too (it removes push.json).
- Produces (HTTP): `GET /live` → `LiveState`; `POST /push/live { kind: "start" | "activity", token, env }` → 204;
  `DELETE /push/live { kind, token }` → 204; 400 for another kind, a token that isn't hex (64 to 400), or another env.
  The widget key reaches `POST`/`DELETE /push/live` as well as `GET /widget`.
- Produces (chat): `ChatData.phone?: string` (set by `server.ts`'s `upgrade`, as before; now typed). A chat socket's
  `input` from the phone, once typed, calls `markFollowed(session)`; so does `POST /sessions` with a `prompt` from the
  phone.

- [ ] **Step 1: Write the failing store test**

In `test/push-store.test.ts`, replace the import line from `../src/push/store` with:

```ts
import { addDevice, addLive, addWidget, clearDevices, clearLive, credsFile, devicesFile, isDeviceToken, isLiveToken, isWidgetToken, keyFile, readCreds, readDevices, readLive, readWidgets, removeDevice, removeLive, removeWidget, saveCreds } from "../src/push/store";
```

Append:

```ts
test("the live panel's tokens are kept beside the devices and widgets: push-to-start ones and the panel's own", () => {
  const file = devicesFile(fresh());
  addDevice("a".repeat(64), "production", 1, file);
  addWidget("ab".repeat(50), "production", 2, file);
  addLive("starts", "CD".repeat(60), "development", 3, file);
  addLive("activities", "ef".repeat(70), "development", 4, file);
  addLive("activities", "12".repeat(70), "development", 5, file);
  expect(readLive("starts", file)).toEqual([{ token: "cd".repeat(60), env: "development", at: 3 }]);
  expect(readLive("activities", file).map((d) => d.token[0])).toEqual(["1", "e"]);
  expect(readDevices(file).length).toBe(1);
  expect(readWidgets(file).length).toBe(1);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  removeLive("starts", "cd".repeat(60), file);
  expect(readLive("starts", file)).toEqual([]);
  clearLive("activities", file);
  expect(readLive("activities", file)).toEqual([]);
  expect(readWidgets(file).length).toBe(1);
  // none left: push.json is as it was before the live panel
  expect(Object.keys(JSON.parse(readFileSync(file, "utf8")))).toEqual(["devices", "widgets"]);
  clearDevices(file);
  expect(readLive("starts", file)).toEqual([]);
});

test("a live panel token is hex, 64 to 400 characters", () => {
  expect(isLiveToken("ab".repeat(80))).toBe(true);
  expect(isLiveToken("ab".repeat(201))).toBe(false);
  expect(isLiveToken("xyz")).toBe(false);
  expect(isLiveToken(undefined)).toBe(false);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `PATH=$HOME/.bun/bin:$PATH bun test test/push-store.test.ts`
Expected: FAIL (an export named `addLive` not found in `src/push/store.ts`).

- [ ] **Step 3: The live lists (`src/push/store.ts`)**

In the opening comment, replace these two lines:

```ts
// push-key`; push.json { devices: [{ token, env, at }], widgets: [...] }, the phones that asked for notifications
// and the widgets' push tokens (iOS 26 widget push, src/push/widgets.ts). All 600,
```

with these three:

```ts
// push-key`; push.json { devices: [{ token, env, at }], widgets: [...], starts: [...], activities: [...] }, the phones
// that asked for notifications, the widgets' push tokens (iOS 26 widget push, src/push/widgets.ts), and the live
// panel's: the push-to-start token, and the token of the panel that's up (src/push/live.ts). All 600,
```

After the `isWidgetToken` line, add:

```ts
// ActivityKit's push-to-start and Live Activity tokens: hex, as long as a widget's can be.
export const isLiveToken = isWidgetToken;
```

Replace `type Lists = { devices: Device[]; widgets: Device[] };` with:

```ts
type Lists = { devices: Device[]; widgets: Device[]; starts: Device[]; activities: Device[] };
// The live panel's lists: push-to-start tokens, and the tokens of the panel that's up.
export type LiveList = "starts" | "activities";
```

Replace `readLists` and `writeLists` (from `function readLists(file: string): Lists {` to the end of the
`const writeLists = …;` line, with the comment `// No widgets: the file is as it was before them.` above it) with:

```ts
function readLists(file: string): Lists {
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    return {
      devices: valid(j?.devices, isDeviceToken),
      widgets: valid(j?.widgets, isWidgetToken),
      starts: valid(j?.starts, isLiveToken),
      activities: valid(j?.activities, isLiveToken),
    };
  } catch {}
  return { devices: [], widgets: [], starts: [], activities: [] };
}

// An empty list but the devices' is left out: without widgets or a live panel, the file is as it was before them.
const writeLists = (file: string, l: Lists) =>
  write(
    file,
    JSON.stringify({
      devices: l.devices,
      ...(l.widgets.length ? { widgets: l.widgets } : {}),
      ...(l.starts.length ? { starts: l.starts } : {}),
      ...(l.activities.length ? { activities: l.activities } : {}),
    }),
  );
```

(Keep the comment `// Missing or unreadable: none. Entries that aren't phones (or widgets) are left out.` above
`readLists`.) Then replace the comment line above `clearDevices` with these functions and the new comment:

```ts
export const readLive = (list: LiveList, file = devicesFile()): Device[] => readLists(file)[list];
export const addLive = (list: LiveList, token: string, env: PushEnv, now = Date.now(), file = devicesFile()) => add(list, token, env, now, file);
export const removeLive = (list: LiveList, token: string, file = devicesFile()) => remove(list, token, file);
// A panel ended or a new one is starting: the tokens kept are an ended panel's.
export function clearLive(list: LiveList, file = devicesFile()) {
  const l = readLists(file);
  if (!l[list].length) return;
  l[list] = [];
  writeLists(file, l);
}

// `blimpd pair --revoke`: a phone that can't connect gets no notifications, its widgets no pings, and no live panel.
```

`add` and `remove` already take `key: keyof Lists`, so they take the new lists as they are.

- [ ] **Step 4: Run it to see it pass**

Run: `PATH=$HOME/.bun/bin:$PATH bun test test/push-store.test.ts`
Expected: 11 pass, 0 fail.

- [ ] **Step 5: Write the failing server tests**

In `test/server.test.ts`'s `describe("chat", …)`, before the test `"history of a long transcript is its last 200
messages"`, add (it uses that block's `fakeClaude`, `socket`, `until` and `api`):

```ts
  test("input from the phone makes its session the live panel's followed turn; the Mac's doesn't", async () => {
    const phone = "feed".repeat(16);
    writeFileSync(join(tmp, "phone-token"), phone, { mode: 0o600 });
    try {
      const mac = await fakeClaude("live1", "5e5e5e5e-5e5e-4e5e-8e5e-5e5e5e5e5e5e", []);
      const c = await socket(`/sessions/${mac.name}/chat`);
      await until(() => c.messages.find((m) => m.type === "history"), "history");
      c.ws.send(JSON.stringify({ type: "input", id: "l1", text: "from the Mac" }));
      await until(() => c.messages.find((m) => m.type === "ack" && m.id === "l1"), "the Mac's ack");
      expect((await (await api("/live")).json()).turn).toBeUndefined();
      const { name } = await fakeClaude("live2", "5f5f5f5f-5f5f-4f5f-8f5f-5f5f5f5f5f5f", []);
      const ws = new WebSocket(`ws+unix://${sock}:/sessions/${name}/chat?token=${phone}`);
      const got: any[] = [];
      ws.onmessage = (e) => got.push(JSON.parse(String(e.data)));
      await until(() => got.find((m) => m.type === "history"), "the phone's history");
      ws.send(JSON.stringify({ type: "input", id: "l2", text: "from the phone" }));
      await until(() => got.find((m) => m.type === "ack" && m.id === "l2"), "the phone's ack");
      const live = await (await api("/live")).json();
      expect(live.turn).toMatchObject({ session: name, state: "working" });
      expect(typeof live.turn.since).toBe("number");
      expect(live.rows.some((r: { session: string }) => r.session === name)).toBe(false);
      ws.close();
      c.ws.close();
    } finally {
      rmSync(join(tmp, "phone-token"), { force: true });
    }
  });
```

At the end of the file, after `describe("widgets", …)`, add:

```ts
describe("live panel", () => {
  const phoneFile = join(tmp, "phone-token");
  const phone = "cafe".repeat(16);
  const key = widgetKey(phone);
  const withToken = (t: string, path: string, init: RequestInit = {}) => api(path, { ...init, headers: { Authorization: `Bearer ${t}` } }, false);
  const file = () => JSON.parse(readFileSync(join(tmp, "push.json"), "utf8"));

  test("GET /live: the rows and counts it would show", async () => {
    const r = await api("/live");
    expect(r.status).toBe(200);
    const l = await r.json();
    expect(Object.keys(l.counts).sort()).toEqual(["needs", "new", "working"]);
    expect(Array.isArray(l.rows)).toBe(true);
    expect(l.rows.length).toBeLessThanOrEqual(4);
  });

  test("POST and DELETE /push/live keep its push-to-start and panel tokens in push.json, beside the devices", async () => {
    const live = (kind: unknown, t: unknown, env: unknown = "development", method = "POST") => api("/push/live", { method, body: JSON.stringify({ kind, token: t, env }) });
    expect((await live("start", "ab".repeat(60))).status).toBe(204);
    expect((await live("activity", "cd".repeat(70))).status).toBe(204);
    expect(file().starts.map((d: { token: string }) => d.token)).toEqual(["ab".repeat(60)]);
    expect(file().activities.map((d: { token: string }) => d.token)).toEqual(["cd".repeat(70)]);
    expect(statSync(join(tmp, "push.json")).mode & 0o777).toBe(0o600);
    expect((await live("start", "ab".repeat(60), undefined, "DELETE")).status).toBe(204);
    expect((await live("activity", "cd".repeat(70), undefined, "DELETE")).status).toBe(204);
    expect(file().starts).toBeUndefined();
    expect(file().activities).toBeUndefined();
    expect((await live("broadcast", "ab".repeat(60))).status).toBe(400);
    expect((await live("start", "xyz")).status).toBe(400);
    expect((await live("start", "ab".repeat(60), "staging")).status).toBe(400);
    expect((await api("/push/live", { method: "POST", body: "null" })).status).toBe(400);
  });

  test("the widget key sends the panel's tokens (the phone may be locked), and still reads nothing else", async () => {
    writeFileSync(phoneFile, phone);
    try {
      const body = JSON.stringify({ kind: "activity", token: "ef".repeat(70), env: "production" });
      expect((await withToken(key, "/push/live", { method: "POST", body })).status).toBe(204);
      expect(file().activities.map((d: { token: string }) => d.token)).toEqual(["ef".repeat(70)]);
      expect((await withToken(key, "/push/live", { method: "DELETE", body })).status).toBe(204);
      expect(file().activities).toBeUndefined();
      expect((await withToken(key, "/live")).status).toBe(401);
      expect((await withToken(key, "/push/device", { method: "POST", body: JSON.stringify({ token: "a".repeat(64), env: "production" }) })).status).toBe(401);
      expect((await withToken(phone, "/push/live", { method: "POST", body })).status).toBe(204);
      expect((await withToken(phone, "/push/live", { method: "DELETE", body })).status).toBe(204);
    } finally {
      rmSync(phoneFile, { force: true });
    }
  });
});
```

- [ ] **Step 6: Run them to see them fail**

Run: `PATH=$HOME/.bun/bin:$PATH bun test test/server.test.ts -t "live panel"`
Expected: FAIL (`/live` and `/push/live` answer 404; the widget key gets 401).

- [ ] **Step 7: The routes and the widget key's reach (`src/server.ts`)**

Replace the `./push/store` import with these three lines:

```ts
import { markFollowed } from "./followed";
import { liveNow } from "./live";
import { addDevice, addLive, addWidget, isDeviceToken, isLiveToken, isPushEnv, isWidgetToken, removeDevice, removeLive, removeWidget } from "./push/store";
```

In the comment above `authorized`, replace `// widget.ts), or none (undefined).` with
`// widget.ts, and sends the live panel's tokens), or none (undefined).`

In `POST /sessions`, after `const started = await startSession(real, { name: name || undefined, kind: k, run });`, add:

```ts
    // A first message from the phone: the live panel follows this turn (followed.ts).
    if (phone && typeof prompt === "string") markFollowed(started);
```

Before `  if (path === "/events" && get) {`, add:

```ts
  // The live panel (live.ts, push/live.ts): what it shows now, and its push tokens: the push-to-start token (kind
  // "start") and the token of the panel that's up (kind "activity"). The widget key may send them too: iOS wakes the
  // app to hand over a panel blimpd started while the phone is locked, when only the App Group's files can be read.
  if (path === "/live" && get) return Response.json(liveNow(listSessionsLite(claudeDir(), await zmxListAsync())));
  if (path === "/push/live" && (req.method === "POST" || req.method === "DELETE")) {
    const { kind, token: live, env } = ((await req.json()) ?? {}) as Record<string, unknown>;
    const list = kind === "start" ? "starts" : kind === "activity" ? "activities" : undefined;
    if (!list) throw new HttpError(400, 'kind must be "start" or "activity"');
    if (!isLiveToken(live)) throw new HttpError(400, "token must be a Live Activity push token, in hex");
    if (req.method === "DELETE") removeLive(list, live);
    else if (isPushEnv(env)) addLive(list, live, env);
    else throw new HttpError(400, 'env must be "development" or "production"');
    return new Response(null, { status: 204 });
  }

```

In `serve()`'s fetch handler, replace these two lines:

```ts
      // The widget key reads the widgets' summary and nothing else.
      if (!who || (who === "widget" && !(url.pathname === "/widget" && req.method === "GET"))) return error(401, "wrong or missing token");
```

with:

```ts
      // The widget key reads the widgets' summary and sends the live panel's tokens, nothing else.
      const widgetMay = (url.pathname === "/widget" && req.method === "GET") || (url.pathname === "/push/live" && (req.method === "POST" || req.method === "DELETE"));
      if (!who || (who === "widget" && !widgetMay)) return error(401, "wrong or missing token");
```

- [ ] **Step 8: The phone's input follows its turn (`src/chatsocket.ts`)**

In `ChatData`, after `  handling?: Set<Promise<void>>; // messages being handled: closeChat waits for them`, add:

```ts
  phone?: string; // the phone's token, when the phone opened it (server.ts's upgrade sets it)
```

Before `import { claudeDir, type Session, transcriptPath } from "./sessions";`, add:

```ts
import { markFollowed } from "./followed";
```

In `handle`, in the `input` branch, between the end of the `await typed(d.typist, id, async () => { … });` call and
`      return send(ws, { type: "ack", id });`, add:

```ts
      // A prompt from the phone: the live panel follows this turn (followed.ts).
      if (d.phone) markFollowed(d.name);
```

The answer, interrupt and deny branches don't mark anything: answering a question goes on with the same turn.

- [ ] **Step 9: Run them to see them pass**

Run: `PATH=$HOME/.bun/bin:$PATH bun test test/server.test.ts -t "live panel|followed turn|widget|push"`
Expected: 0 fail. Then the whole server file: `PATH=$HOME/.bun/bin:$PATH bun test test/server.test.ts test/chatsocket.test.ts`
Expected: 0 fail.

- [ ] **Step 10: Docs**

In `docs/DESIGN.md`'s `### Widgets` section, in the bullet that starts `- **The widget key**`, replace:

```text
reads `GET /widget` and nothing else (anything else answers it 401)
```

with:

```text
reads `GET /widget` and sends the live panel's tokens (`/push/live`, below), nothing else (anything else answers it 401)
```

After the `### Widgets` section's last bullet (the one starting `- **The pinger**`), before `### Hooks (status
backup)`, add:

```markdown
### Live panel

The iPhone's live panel (one Live Activity, on the lock screen and in the Dynamic Island; design in `docs/superpowers/specs/2026-10-26-phone-live-activity-design.md`) shows a turn Max started from the phone, step by step, above the widgets' overview.

- **What it shows** (`src/live.ts`; `GET /live` answers the same): `{ turn?: { session, dir, title, state, since, steps?: { done, total, current? } }, rows, counts }`. `turn` is the followed turn (`state` needs or working; `since` when its prompt went in, ms); `rows` are the widgets' rows without the turn's own session, 3 under a turn and 4 without; `counts` are the widgets'. It is the Live Activity's content-state, which the phone decodes into BlimpKit's `LiveState` (`ios/BlimpKit/Sources/BlimpKit/Live.swift`): the same names, times as numbers. Titles are cut (80 characters, then shorter) so it stays under 3500 bytes and a push under Apple's 4 KB.
- **The followed turn** (`src/followed.ts`): the session that last got a prompt with the phone's token (a chat socket's `input`, or `POST /sessions`' `prompt`), until it is done since then, or gone, or hasn't started 2 minutes on. Waiting on Max keeps it. In memory only.
- **Steps** (`src/steps.ts`): from the followed session's transcript, read as `activity.ts` reads jobs. `TaskCreate`'s result (`toolUseResult.task: { id, subject }`) adds a step, `TaskUpdate`'s input (`taskId`, `status`, `subject`, `activeForm`) changes one, `TodoWrite`'s `todos` replaces the list; a `TaskCreate` once every step is completed starts a new list. Shown only if the list changed since the turn's prompt.
- **Tokens:** `POST /push/live { "kind": "start" | "activity", "token": hex, "env" }` → 204 and `DELETE /push/live { "kind", "token" }` → 204, kept in push.json's `starts` (push-to-start tokens) and `activities` (the panel that's up), at most 5 each; 400 for another kind, a token that isn't hex, or another env. The widget key may send them too: iOS wakes the app to hand over a panel blimpd started while the phone is locked, when the Keychain, and so the phone's token, can't be read. `blimpd pair --revoke` removes them with the devices.
```

In `docs/SECURITY.md`'s threat table, in the row that starts `| Someone who gets the widget key`, replace:

```text
| Read session names, titles, states, times and full folder paths, and counts | It reads `GET /widget` and nothing else.
```

with (the rest of the row stays):

```text
| Read session names, titles, states, times and full folder paths, and counts; add or remove the live panel's push tokens | It reads `GET /widget` and sends `/push/live`, nothing else. A token it adds gets the live panel, which shows what `GET /widget` gives plus a followed turn's step, and only on a phone with this blimp app: Apple delivers it to blimp's own app.
```

After the row that starts `| Someone who sees your locked phone, with blimp's rectangular widget`, add:

```markdown
| Someone who sees your locked phone while the live panel is up | Read session titles, and the step a turn you started from the phone is on | It shows the followed turn and up to 4 titles, as the widgets and notifications show text. Settings > "Live panel on the lock screen" turns it off; so does iOS Settings > blimp > Live Activities. |
```

- [ ] **Step 11: Commit**

```bash
git add src/push/store.ts src/server.ts src/chatsocket.ts test/push-store.test.ts test/server.test.ts docs/DESIGN.md docs/SECURITY.md
git commit -m "blimpd: the live panel's tokens (POST and DELETE /push/live: push-to-start and the panel's own, in push.json beside the devices, also with the widget key since the phone may be locked), GET /live, and a prompt from the phone (a chat input or a new session's first message) makes its session the followed turn"
```

---

### Task 4: blimpd starts, updates, ends and restarts the live panel

**Files:**
- Modify: `src/push/apns.ts` (`PushOptions`, `once()`'s headers)
- Create: `src/push/live.ts`
- Modify: `src/push/watch.ts` (opening comment, imports, `apnsFor`'s comment, `startPush`)
- Modify: `src/server.ts` (the `./push/watch` import; `serve()` before `startPush()`)
- Test: `test/push-apns.test.ts`, `test/push-live.test.ts`
- Docs: `docs/DESIGN.md`

**Interfaces:**
- Consumes: `isBusy`, `livePayload`, `liveShape`, `liveNow`, `type LiveState` from `src/live.ts` (Task 2); `readLive`,
  `removeLive`, `clearLive`, `type LiveList` from `src/push/store.ts` (Task 3); `goneDevice`, `type Sent`, `Apns` from
  `src/push/apns.ts`; `apnsFor` in `src/push/watch.ts`.
- Produces:
  - `PushOptions = { collapseId?: string; type?: "alert" | "widgets" | "liveactivity"; priority?: 5 | 10 }`; a
    `liveactivity` push goes to topic `dev.blimp.phone.push-type.liveactivity` with `apns-push-type: liveactivity`
    and `apns-priority` as given (10 when not).
  - `QUIET = 10 * 60_000`, `RESTART = (7 * 60 + 45) * 60_000`, `APP_GRACE = 10_000`
  - `type LiveDeps = { sessions; content(list, now): LiveState; creds; starts(): Device[]; activities(): Device[]; clearActivities(); send(c, d, payload, priority: 5 | 10): Promise<Sent>; gone(list: LiveList, d); tellApp(state): boolean; now; log }`
  - `class LiveRunner { constructor(deps: LiveDeps); tick(): Promise<void> }`
  - `onPhoneApps(f: (message: string) => boolean): void` (watch.ts): how the runner reaches the phone's open app; the
    message is `{"type":"live","state":<LiveState>}`.

- [ ] **Step 1: Write the failing Apple test**

In `test/push-apns.test.ts`, before the test `"Apple's reason comes back; 410, BadDeviceToken and Unregistered mean the
phone is gone"`, add:

```ts
test("a live panel push: the liveactivity push type, its own topic, and the priority asked for", async () => {
  reset();
  const a = new Apns(creds, hosts);
  try {
    const payload = { aps: { timestamp: 1, event: "update", "content-state": { rows: [], counts: { needs: 0, new: 0, working: 1 } } } };
    expect(await a.send(device, payload, { type: "liveactivity", priority: 5 })).toEqual({ status: 200 });
    expect(await a.send(device, payload, { type: "liveactivity" })).toEqual({ status: 200 });
    const [five, ten] = got;
    expect(five.headers["apns-topic"]).toBe(`${TOPIC}.push-type.liveactivity`);
    expect(five.headers["apns-push-type"]).toBe("liveactivity");
    expect(five.headers["apns-priority"]).toBe("5");
    expect(ten.headers["apns-priority"]).toBe("10");
    expect(JSON.parse(five.body)).toEqual(payload);
  } finally {
    a.close();
  }
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `PATH=$HOME/.bun/bin:$PATH bun test test/push-apns.test.ts`
Expected: FAIL (the topic is `dev.blimp.phone`, the priority 10).

- [ ] **Step 3: The liveactivity push type (`src/push/apns.ts`)**

Replace:

```ts
// type widgets: a widget push (iOS 26), which only tells WidgetKit to reload the widgets: its own topic, priority 5.
export type PushOptions = { collapseId?: string; type?: "alert" | "widgets" };
```

with:

```ts
// type widgets: a widget push (iOS 26), which only tells WidgetKit to reload the widgets: its own topic, priority 5.
// type liveactivity: a Live Activity push (the live panel, live.ts): its own topic, priority 10 unless given.
export type PushOptions = { collapseId?: string; type?: "alert" | "widgets" | "liveactivity"; priority?: 5 | 10 };
```

In `once()`, replace the three header lines:

```ts
        "apns-topic": o.type === "widgets" ? `${TOPIC}.push-type.widgets` : TOPIC,
        "apns-push-type": o.type ?? "alert",
        "apns-priority": o.type === "widgets" ? "5" : "10",
```

with:

```ts
        "apns-topic": o.type && o.type !== "alert" ? `${TOPIC}.push-type.${o.type}` : TOPIC,
        "apns-push-type": o.type ?? "alert",
        "apns-priority": String(o.priority ?? (o.type === "widgets" ? 5 : 10)),
```

- [ ] **Step 4: Run it to see it pass**

Run: `PATH=$HOME/.bun/bin:$PATH bun test test/push-apns.test.ts`
Expected: 10 pass, 0 fail (the alert and widget tests still see their own topics and priorities).

- [ ] **Step 5: Write the runner's failing test**

Create `test/push-live.test.ts`:

```ts
// The live panel's runner (src/push/live.ts) on stand-ins: what the panel shows, the clock, the tokens, the open app
// and Apple.

import { expect, test } from "bun:test";
import type { LiveState } from "../src/live";
import type { Sent } from "../src/push/apns";
import { APP_GRACE, type LiveDeps, LiveRunner, QUIET, RESTART } from "../src/push/live";
import type { Creds, Device, LiveList } from "../src/push/store";
import type { Session } from "../src/sessions";

const T = 1_800_000_000_000;
const key: Creds = { key: "k", keyId: "ABC123DEFG", teamId: "1A2B3C4D5E" };
const startToken: Device = { token: "ab".repeat(60), env: "production", at: 0 };
const panelToken = (at: number): Device => ({ token: "cd".repeat(70), env: "production", at });
const row = (session: string, state: "needs" | "new" | "working") => ({ session, dir: "/u/blimp", title: session, state, since: T });
const working = (n = 1): LiveState => ({ rows: Array.from({ length: n }, (_, i) => row(`w${i}`, "working")), counts: { needs: 0, new: 0, working: n } });
const quiet: LiveState = { rows: [], counts: { needs: 0, new: 0, working: 0 } };
const anySession = { name: "x" } as Session;

type Push = { list: "starts" | "activities"; event: string; priority: 5 | 10; payload: any };

function setup(o: { creds?: Creds; answer?: (d: Device) => Sent; appOpen?: boolean } = {}) {
  const t = {
    state: quiet,
    clock: T,
    starts: [startToken],
    activities: [] as Device[],
    creds: ("creds" in o ? o.creds : key) as Creds | undefined,
    appOpen: o.appOpen ?? false,
    pushes: [] as Push[],
    told: [] as LiveState[],
    gone: [] as [LiveList, Device][],
    logs: [] as string[],
    list: [anySession] as Session[],
    reads: 0,
  };
  const deps: LiveDeps = {
    sessions: async () => {
      t.reads++;
      return t.list;
    },
    content: () => t.state,
    creds: () => t.creds,
    starts: () => t.starts,
    activities: () => t.activities,
    clearActivities: () => void (t.activities = []),
    send: async (_c, d, payload: any, priority) => {
      t.pushes.push({ list: d.token === startToken.token ? "starts" : "activities", event: payload.aps.event, priority, payload });
      return o.answer?.(d) ?? { status: 200 };
    },
    gone: (list, d) => void t.gone.push([list, d]),
    tellApp: (state) => (t.appOpen ? (t.told.push(state), true) : false),
    now: () => t.clock,
    log: (line) => void t.logs.push(line),
  };
  return { t, r: new LiveRunner(deps) };
}
const events = (t: { pushes: Push[] }) => t.pushes.map((p) => `${p.list}:${p.event}:${p.priority}`);

test("no push-to-start token, or no push key: no work, not even the list", async () => {
  const a = setup();
  a.t.starts = [];
  a.t.state = working();
  await a.r.tick();
  const b = setup({ creds: undefined });
  b.t.state = working();
  await b.r.tick();
  expect([a.t.reads, b.t.reads, a.t.pushes.length, b.t.pushes.length]).toEqual([0, 0, 0, 0]);
});

test("quiet: nothing starts", async () => {
  const { t, r } = setup();
  await r.tick();
  t.clock += 60_000;
  await r.tick();
  expect(t.pushes).toEqual([]);
});

test("busy with the app closed: a push-to-start at once, with its alert and no sound", async () => {
  const { t, r } = setup();
  t.state = working(3);
  await r.tick();
  expect(events(t)).toEqual(["starts:start:10"]);
  expect(t.pushes[0].payload.aps.alert).toEqual({ title: "blimp", body: "3 working" });
  expect(t.pushes[0].payload.aps.sound).toBeUndefined();
  expect(t.pushes[0].payload.aps["content-state"]).toEqual(working(3));
});

test("busy with the app open: the app starts it (no banner); no token 10 s on, a push-to-start", async () => {
  const { t, r } = setup({ appOpen: true });
  t.state = working();
  await r.tick();
  expect(t.told).toEqual([working()]);
  expect(t.pushes).toEqual([]);
  t.clock += APP_GRACE - 1;
  await r.tick();
  expect(t.pushes).toEqual([]);
  t.clock += 1;
  await r.tick();
  expect(events(t)).toEqual(["starts:start:10"]);
  t.clock += 60_000;
  await r.tick();
  expect(events(t)).toEqual(["starts:start:10"]);
});

test("the app started it and sent its token: no push-to-start; updates go to that token", async () => {
  const { t, r } = setup({ appOpen: true });
  t.state = working();
  await r.tick();
  t.activities = [panelToken(T + 500)];
  t.clock += APP_GRACE;
  await r.tick();
  expect(t.pushes).toEqual([]);
  t.state = working(2);
  await r.tick();
  expect(events(t)).toEqual(["activities:update:5"]);
});

test("updates on a change only: the same content, or a later time, sends nothing", async () => {
  const { t, r } = setup();
  t.state = working();
  await r.tick();
  t.activities = [panelToken(T)];
  for (let i = 0; i < 3; i++) {
    t.clock += 1000;
    await r.tick();
  }
  expect(events(t)).toEqual(["starts:start:10"]);
  t.state = working(2);
  await r.tick();
  await r.tick();
  expect(events(t)).toEqual(["starts:start:10", "activities:update:5"]);
  expect(t.pushes[1].payload.aps).toEqual({ timestamp: Math.floor(t.clock / 1000), event: "update", "content-state": working(2) });
});

test("a new needs-you: priority 10, no alert; the same one again later: 5", async () => {
  const { t, r } = setup();
  t.state = working();
  await r.tick();
  t.activities = [panelToken(T)];
  t.state = { rows: [row("ask", "needs"), row("w0", "working")], counts: { needs: 1, new: 0, working: 1 } };
  await r.tick();
  t.state = { rows: [row("ask", "needs"), row("w0", "new")], counts: { needs: 1, new: 1, working: 0 } };
  await r.tick();
  expect(events(t)).toEqual(["starts:start:10", "activities:update:10", "activities:update:5"]);
  expect(t.pushes[1].payload.aps.alert).toBeUndefined();
});

test("ends after 10 minutes with nothing needing you or working, dismissed at once; busy again, a new one", async () => {
  const { t, r } = setup();
  t.state = working();
  await r.tick();
  t.activities = [panelToken(T)];
  t.state = { rows: [row("w0", "new")], counts: { needs: 0, new: 1, working: 0 } };
  await r.tick(); // what it shows changed: an update
  t.clock += QUIET - 1;
  await r.tick();
  expect(events(t)).toEqual(["starts:start:10", "activities:update:5"]);
  t.clock += 1;
  await r.tick();
  expect(events(t)).toEqual(["starts:start:10", "activities:update:5", "activities:end:10"]);
  expect(t.pushes[2].payload.aps["dismissal-date"]).toBe(Math.floor(t.clock / 1000));
  expect(t.activities).toEqual([]);
  t.state = working();
  await r.tick();
  expect(events(t).at(-1)).toBe("starts:start:10");
});

test("something working again within the 10 minutes keeps it", async () => {
  const { t, r } = setup();
  t.state = working();
  await r.tick();
  t.activities = [panelToken(T)];
  t.state = quiet;
  await r.tick();
  t.clock += QUIET - 1000;
  t.state = working();
  await r.tick();
  t.clock += QUIET - 1000;
  await r.tick();
  expect(events(t).filter((e) => e.endsWith(":end:10"))).toEqual([]);
});

test("at 7 h 45 min, still busy: ended and started again", async () => {
  const { t, r } = setup();
  t.state = working();
  await r.tick();
  t.activities = [panelToken(T)];
  t.clock = T + RESTART - 1;
  await r.tick();
  expect(events(t)).toEqual(["starts:start:10"]);
  t.clock = T + RESTART;
  await r.tick();
  expect(events(t)).toEqual(["starts:start:10", "activities:end:10", "starts:start:10"]);
  expect(RESTART).toBe((7 * 60 + 45) * 60_000);
});

test("blimpd started again with a panel's token kept: it carries on with that panel, and restarts it on time", async () => {
  const { t, r } = setup();
  t.activities = [panelToken(T - RESTART + 60_000)];
  t.state = working();
  await r.tick();
  expect(events(t)).toEqual(["activities:update:5"]);
  t.clock += 60_000;
  await r.tick();
  expect(events(t)).toEqual(["activities:update:5", "activities:end:10", "starts:start:10"]);
});

test("a panel whose token never came gets nothing more, and is forgotten after the quiet 10 minutes", async () => {
  const { t, r } = setup();
  t.state = working();
  await r.tick();
  t.state = working(2);
  await r.tick();
  t.state = quiet;
  t.clock += QUIET;
  await r.tick();
  await r.tick();
  expect(events(t)).toEqual(["starts:start:10"]);
});

test("tokens Apple says are gone are removed", async () => {
  const { t, r } = setup({ answer: () => ({ status: 410, reason: "Unregistered" }) });
  t.state = working();
  await r.tick();
  expect(t.gone).toEqual([["starts", startToken]]);
  expect(t.logs.join("\n")).toContain("no longer works");
  const b = setup({ answer: (d) => (d.token === startToken.token ? { status: 200 } : { status: 400, reason: "BadDeviceToken" }) });
  b.t.state = working();
  await b.r.tick();
  b.t.activities = [panelToken(T)];
  b.t.state = working(2);
  await b.r.tick();
  expect(b.t.gone).toEqual([["activities", panelToken(T)]]);
});

test("another answer from Apple is logged, and nothing is removed", async () => {
  const { t, r } = setup({ answer: () => ({ status: 429, reason: "TooManyRequests" }) });
  t.state = working();
  await r.tick();
  expect(t.gone).toEqual([]);
  expect(t.logs).toEqual(["push: Apple said 429 (TooManyRequests) to the live panel"]);
});

test("the push-to-start token gone (the switch off in Settings): it forgets the panel", async () => {
  const { t, r } = setup();
  t.state = working();
  await r.tick();
  t.starts = [];
  await r.tick();
  t.starts = [startToken];
  await r.tick();
  expect(events(t)).toEqual(["starts:start:10", "starts:start:10"]);
});

test("an empty list after sessions (a failed zmx list) changes nothing", async () => {
  const { t, r } = setup();
  t.state = working();
  await r.tick();
  t.activities = [panelToken(T)];
  t.list = [];
  t.state = quiet;
  t.clock += QUIET * 2;
  await r.tick();
  expect(events(t)).toEqual(["starts:start:10"]);
});
```

- [ ] **Step 6: Run it to see it fail**

Run: `PATH=$HOME/.bun/bin:$PATH bun test test/push-live.test.ts`
Expected: FAIL (cannot find module `../src/push/live`).

- [ ] **Step 7: Write the runner**

Create `src/push/live.ts`:

```ts
// The live panel's runner (docs/superpowers/specs/2026-10-26-phone-live-activity-design.md, "When it shows"): every
// second, while there's a push key and a push-to-start token, what the panel shows (live.ts). One panel:
// - started when something needs you or works (or a followed turn runs): by the app itself when it's open (the events
//   socket's "live" message, so no banner), else, or when the app hasn't sent the new panel's token 10 s on, by a
//   push-to-start (a quiet alert: no sound);
// - updated when what it shows changes, to the newest token the app sent for it: priority 5, 10 for a new needs-you,
//   no alert (notifications already ring);
// - ended after 10 minutes with nothing needing you or working, dismissed at once;
// - ended and started again at 7 h 45 min, before iOS ends it at 8 hours.
// A panel whose token never came, or went (Apple said gone), gets no pushes until it ends. Tokens Apple says are gone
// are removed. When blimpd starts with a panel's token kept, it carries on with that panel.

import { isBusy, livePayload, liveShape, type LiveState } from "../live";
import type { Session } from "../sessions";
import { goneDevice, type Sent } from "./apns";
import type { Creds, Device, LiveList } from "./store";

export const QUIET = 10 * 60_000;
export const RESTART = (7 * 60 + 45) * 60_000;
export const APP_GRACE = 10_000;

export type LiveDeps = {
  sessions: () => Promise<Session[]>;
  // What the panel shows, from the session list (liveNow in live.ts).
  content: (list: Session[], now: number) => LiveState;
  creds: () => Creds | undefined;
  // Newest first, as push.json keeps them.
  starts: () => Device[];
  activities: () => Device[];
  clearActivities: () => void;
  send: (c: Creds, d: Device, payload: object, priority: 5 | 10) => Promise<Sent>;
  gone: (list: LiveList, d: Device) => void;
  // Asks every app open with the phone's token to start the panel; false when none is.
  tellApp: (state: LiveState) => boolean;
  now: () => number;
  log: (line: string) => void;
};

type Panel = {
  since: number; // when it started (ms)
  sent: string; // what it shows (liveShape), as last sent or asked for
  needs: Set<string>; // which sessions needed you in that
  asked?: number; // when the open app was asked to start it
  quiet?: number; // since when nothing needs you or works
};

// The sessions that need you in what it shows, the followed turn's among them.
const needsOf = (l: LiveState) =>
  new Set([...(l.turn?.state === "needs" ? [l.turn.session] : []), ...l.rows.filter((r) => r.state === "needs").map((r) => r.session)]);

export class LiveRunner {
  private panel?: Panel;
  private listed = false;
  private busy = false;

  constructor(private deps: LiveDeps) {}

  async tick(): Promise<void> {
    if (this.busy) return; // a slow zmx shouldn't pile up checks
    this.busy = true;
    try {
      const start = this.deps.starts()[0];
      const creds = start ? this.deps.creds() : undefined;
      if (!start || !creds) {
        this.panel = undefined;
        this.listed = false;
        return;
      }
      const now = this.deps.now();
      const list = await this.deps.sessions();
      // An empty list after sessions is more likely a zmx list that failed than every session gone (as in watch.ts).
      if (!list.length && this.listed) return;
      this.listed = list.length > 0;
      const state = this.deps.content(list, now);
      const token = this.deps.activities()[0];
      // blimpd started again while a panel was up: carry on with it, as of when its token came.
      if (!this.panel && token) this.panel = { since: token.at, sent: "", needs: new Set() };
      const p = this.panel;
      if (!p) {
        if (isBusy(state)) await this.begin(creds, start, state, now);
        return;
      }
      if (isBusy(state)) p.quiet = undefined;
      else p.quiet ??= now;
      if (p.quiet !== undefined && now - p.quiet >= QUIET) return await this.end(creds, token, state, now);
      if (now - p.since >= RESTART) {
        await this.end(creds, token, state, now);
        if (isBusy(state)) await this.begin(creds, start, state, now);
        return;
      }
      if (!token) {
        // The app was asked, and no token came: it wasn't open after all.
        if (p.asked !== undefined && now - p.asked >= APP_GRACE) {
          p.asked = undefined;
          await this.pushStart(creds, start, state, p, now);
        }
        return;
      }
      const shape = liveShape(state);
      if (shape === p.sent) return;
      const needs = needsOf(state);
      const urgent = [...needs].some((n) => !p.needs.has(n));
      p.sent = shape;
      p.needs = needs;
      await this.send(creds, "activities", token, livePayload("update", state, now), urgent ? 10 : 5);
    } catch (e) {
      this.deps.log(`push: live panel: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  // Tokens kept from before are an ended panel's. The open app starts it with no banner; with none open, Apple does.
  private async begin(creds: Creds, start: Device, state: LiveState, now: number) {
    this.deps.clearActivities();
    const p: Panel = { since: now, sent: liveShape(state), needs: needsOf(state) };
    this.panel = p;
    if (this.deps.tellApp(state)) p.asked = now;
    else await this.pushStart(creds, start, state, p, now);
  }

  private async pushStart(creds: Creds, start: Device, state: LiveState, p: Panel, now: number) {
    p.sent = liveShape(state);
    p.needs = needsOf(state);
    await this.send(creds, "starts", start, livePayload("start", state, now), 10);
  }

  private async end(creds: Creds, token: Device | undefined, state: LiveState, now: number) {
    this.panel = undefined;
    if (token) await this.send(creds, "activities", token, livePayload("end", state, now), 10);
    this.deps.clearActivities();
  }

  private async send(creds: Creds, list: LiveList, d: Device, payload: object, priority: 5 | 10) {
    const r = await this.deps.send(creds, d, payload, priority);
    if (goneDevice(r)) {
      this.deps.gone(list, d);
      this.deps.log(`push: Apple says a live panel token no longer works (${r.reason ?? r.status}), so it's removed`);
    } else if (r.status !== 200) this.deps.log(`push: Apple said ${r.status || "nothing"}${r.reason ? ` (${r.reason})` : ""} to the live panel`);
  }
}
```

- [ ] **Step 8: Run it to see it pass**

Run: `PATH=$HOME/.bun/bin:$PATH bun test test/push-live.test.ts`
Expected: 16 pass, 0 fail.

- [ ] **Step 9: The runner's tick (`src/push/watch.ts`)**

At the end of the opening comment, replace:

```ts
// even the list; once both are there, what it finds first counts as seen. The widgets' pinger (widgets.ts) runs on the
// same tick, and likewise only with a key and a widget push token.
```

with:

```ts
// even the list; once both are there, what it finds first counts as seen. The widgets' pinger (widgets.ts) runs on the
// same tick, and likewise only with a key and a widget push token; so does the live panel's runner (live.ts), with a
// key and a push-to-start token.
```

After `import { readHidden } from "../hidden";`, add `import { liveNow } from "../live";`. Replace the `./store`
import with these two lines:

```ts
import { type LiveDeps, LiveRunner } from "./live";
import { clearLive, type Creds, type Device, readCreds, readDevices, readLive, readWidgets, removeDevice, removeLive, removeWidget } from "./store";
```

Replace the comment above `apnsFor`:

```ts
// One client while the key stays the same; push-key with a new one gets a new client. Notifications and the widgets'
// pings share it, so one connection to Apple.
```

with:

```ts
// One client while the key stays the same; push-key with a new one gets a new client. Notifications, the widgets'
// pings and the live panel share it, so one connection to Apple.
```

Replace `startPush` with:

```ts
// The phone's open apps (server.ts sets it): a message to each events socket opened with the phone's token; false
// when there's none.
let tellPhone: (message: string) => boolean = () => false;
export const onPhoneApps = (f: (message: string) => boolean) => void (tellPhone = f);

const liveLive: LiveDeps = {
  sessions: async () => listSessionsLite(claudeDir(), await zmxListAsync()),
  content: (list, now) => liveNow(list, now),
  creds: () => readCreds(),
  starts: () => readLive("starts"),
  activities: () => readLive("activities"),
  clearActivities: () => clearLive("activities"),
  send: (c, d, payload, priority) => apnsFor(c).send(d, payload, { type: "liveactivity", priority }),
  gone: (list, d) => void removeLive(list, d.token),
  tellApp: (state) => tellPhone(JSON.stringify({ type: "live", state })),
  now: Date.now,
  log: (line) => console.log(line),
};

export function startPush(every = 1000) {
  const w = new PushWatcher(live);
  const p = new WidgetPinger(widgetsLive);
  const l = new LiveRunner(liveLive);
  setInterval(() => {
    void w.tick();
    void p.tick();
    void l.tick();
  }, every);
}
```

- [ ] **Step 10: The phone's events sockets for the runner (`src/server.ts`)**

Replace `import { startPush } from "./push/watch";` with `import { onPhoneApps, startPush } from "./push/watch";`. In
`serve()`, replace:

```ts
  // Phone notifications, and the widgets' pings: nothing runs until there's a push key and a phone that asked, or a
  // widget push token (push/watch.ts).
  startPush();
```

with:

```ts
  // The live panel asks the phone's open app to start it (push/live.ts): through its events sockets.
  onPhoneApps((message) => {
    let told = false;
    for (const ws of phoneSockets)
      if (ws.data.kind === "events") {
        ws.send(message);
        told = true;
      }
    return told;
  });
  // Phone notifications, the widgets' pings and the live panel: nothing runs until there's a push key and a phone that
  // asked, a widget push token, or a push-to-start token (push/watch.ts).
  startPush();
```

`phoneSockets` is the set `serve()` already keeps of the sockets opened with the phone's token.

- [ ] **Step 11: Run the push tests and the server file**

Run: `PATH=$HOME/.bun/bin:$PATH bun test test/push-apns.test.ts test/push-live.test.ts test/push-watch.test.ts test/push-widgets.test.ts test/server.test.ts`
Expected: 0 fail.

- [ ] **Step 12: Docs**

In `docs/DESIGN.md`'s `### Live panel` section (Task 3), add this last bullet:

```markdown
- **The runner** (`src/push/live.ts`): every second, while there's a push key and a push-to-start token, what the panel shows (`liveNow`). Busy (something needs you or works, or a followed turn runs) with no panel up: it asks the phone's open app to start one over its events socket (`{ "type": "live", "state" }`, so no banner), and sends a push-to-start (`event: "start"`, `attributes-type: BlimpActivityAttributes`, `attributes: {}`, `alert` `blimp` / `2 need you, 3 working` without a sound, `input-push-token: 1`) when no app is open or no panel token came 10 s on. Then an update (`event: "update"`, no alert) to the newest panel token when the counts, a row's state or title, or the turn's state, title or step change: priority 5, 10 for a new needs-you. After 10 minutes with nothing needing you or working, an end (`event: "end"`, `dismissal-date` now); at 7 h 45 min, an end and a new start (iOS ends a panel at 8 hours). A start forgets the panel tokens kept from before. `apns-push-type: liveactivity`, topic `dev.blimp.phone.push-type.liveactivity`, times in seconds, on the notifications' connection to Apple; its 410, `BadDeviceToken` or `Unregistered` removes a token. A panel whose token never came, or that Max swiped away, gets nothing more until the quiet 10 minutes end it. When blimpd starts with a panel token kept, it carries on with that panel.
```

- [ ] **Step 13: Commit**

```bash
git add src/push/apns.ts src/push/live.ts src/push/watch.ts src/server.ts test/push-apns.test.ts test/push-live.test.ts docs/DESIGN.md
git commit -m "blimpd: the live panel's runner, a third tick beside the push watcher and the widgets' pinger on the same Apple connection: starts the panel when something needs you or works (through the phone's open app, else a quiet push-to-start), updates it on change (priority 5, 10 for a new needs-you), ends it after 10 quiet minutes, restarts it at 7 h 45 min, removes tokens Apple says are gone"
```

---

### Task 5: BlimpKit: the live panel's content, words and link

**Files:**
- Create: `ios/BlimpKit/Sources/BlimpKit/Live.swift`
- Modify: `ios/BlimpKit/Sources/BlimpKit/Widgets.swift` (`Counts` and `Row` become `Hashable`)
- Test: `ios/BlimpKit/Tests/BlimpKitTests/LiveTests.swift`

**Interfaces:**
- Consumes: `WidgetSummary.State`, `WidgetSummary.Counts`, `WidgetSummary.Row`, `WidgetText.symbol(_:)`,
  `WidgetLink.url(session:)`, `WidgetLink.app` (BlimpKit `Widgets.swift`); blimpd's JSON from `src/live.ts` (Task 2).
- Produces:
  - `LiveState: Codable, Sendable, Hashable` (`turn: Turn?`, `rows: [WidgetSummary.Row]`, `counts: WidgetSummary.Counts`;
    `init(turn:rows:counts:)`, `turn` defaulting to nil)
  - `LiveState.Turn` (`session`, `dir`, `title`, `state: WidgetSummary.State`, `since: Double` ms, `steps: Steps?`;
    `init(session:dir:title:state:since:steps:)`)
  - `LiveState.Steps` (`done: Int`, `total: Int`, `current: String?`; `init(done:total:current:)`)
  - `LiveText.step(_:) -> String`, `.progress(_:) -> Double`, `.compact(_:) -> (leading: String, trailing: String)`,
    `.minimal(_:) -> String`, `.link(_:) -> URL`
  - `WidgetSummary.Counts` and `WidgetSummary.Row` conform to `Hashable` (ActivityKit's `ContentState` must be
    `Hashable`; a conformance can only be synthesized in the type's own file).

Swift is compiled only in CI (Global Constraints). Write exactly this, and re-read it.

- [ ] **Step 1: Write the tests**

Create `ios/BlimpKit/Tests/BlimpKitTests/LiveTests.swift`:

```swift
import Foundation
import Testing
@testable import BlimpKit

// The phone's live panel: blimpd's content-state (src/live.ts, test/live.test.ts), its words and its link.

private let full = #"{"turn":{"session":"blimp-phone","dir":"/u/blimp","title":"Server update","state":"working","since":1800000000000,"steps":{"done":3,"total":7,"current":"Running the tests"}},"rows":[{"session":"a","dir":"/u/cq","title":"Linking Linear cards","state":"needs","since":1799999990000},{"session":"b","dir":"/u/blimp","title":"Fixing the Slack bot","state":"working","since":1799990000000}],"counts":{"needs":2,"new":1,"working":3}}"#

@Test func blimpdsContentStateDecodes() throws {
    let l = try JSONDecoder().decode(LiveState.self, from: Data(full.utf8))
    #expect(l.turn?.session == "blimp-phone")
    #expect(l.turn?.state == WidgetSummary.State.working)
    #expect(l.turn?.since == 1_800_000_000_000)
    #expect(l.turn?.steps == LiveState.Steps(done: 3, total: 7, current: "Running the tests"))
    #expect(l.rows.map(\.state) == [WidgetSummary.State.needs, WidgetSummary.State.working])
    #expect(l.counts == WidgetSummary.Counts(needs: 2, new: 1, working: 3))
    let bare = try JSONDecoder().decode(LiveState.self, from: Data(#"{"rows":[],"counts":{"needs":0,"new":0,"working":1}}"#.utf8))
    #expect(bare.turn == nil)
    let waiting = #"{"turn":{"session":"s","dir":"/u/x","title":"T","state":"needs","since":1},"rows":[],"counts":{"needs":1,"new":0,"working":0}}"#
    let noSteps = try JSONDecoder().decode(LiveState.self, from: Data(waiting.utf8))
    #expect(noSteps.turn?.state == WidgetSummary.State.needs)
    #expect(noSteps.turn?.steps == nil)
}

@Test func itComesBackFromJSONTheSame() throws {
    // iOS keeps a panel's content as JSON: what the app starts one with must decode to the same state.
    let l = try JSONDecoder().decode(LiveState.self, from: Data(full.utf8))
    let again = try JSONDecoder().decode(LiveState.self, from: JSONEncoder().encode(l))
    #expect(again == l)
    #expect(Set([l, again]).count == 1)
}

@Test func theStepIsTheOneAfterThoseDoneAndTheBarIsTheShareDone() {
    #expect(LiveText.step(LiveState.Steps(done: 3, total: 7, current: "Running the tests")) == "Step 4 of 7")
    #expect(LiveText.step(LiveState.Steps(done: 0, total: 2)) == "Step 1 of 2")
    #expect(LiveText.step(LiveState.Steps(done: 7, total: 7)) == "Step 7 of 7")
    #expect(LiveText.progress(LiveState.Steps(done: 1, total: 4)) == 0.25)
    #expect(LiveText.progress(LiveState.Steps(done: 0, total: 0)) == 0)
}

@Test func theIslandSaysWhatNeedsYouAndWhatWorks() {
    let c = LiveText.compact(WidgetSummary.Counts(needs: 2, new: 1, working: 3))
    #expect(c.leading == "?2")
    #expect(c.trailing == "●3")
    #expect(LiveText.minimal(WidgetSummary.Counts(needs: 1, new: 0, working: 3)) == "?")
    #expect(LiveText.minimal(WidgetSummary.Counts(needs: 0, new: 2, working: 3)) == "●")
}

@Test func aTapOpensTheTurnElseTheOldestThatNeedsYouElseTheApp() throws {
    let l = try JSONDecoder().decode(LiveState.self, from: Data(full.utf8))
    #expect(LiveText.link(l) == WidgetLink.url(session: "blimp-phone"))
    let work = WidgetSummary.Row(session: "w", dir: "/u/blimp", title: "W", state: .working, since: 1)
    let ask = WidgetSummary.Row(session: "ask", dir: "/u/blimp", title: "A", state: .needs, since: 2)
    #expect(LiveText.link(LiveState(rows: [work, ask], counts: WidgetSummary.Counts(needs: 1, new: 0, working: 1))) == WidgetLink.url(session: "ask"))
    #expect(LiveText.link(LiveState(rows: [work], counts: WidgetSummary.Counts(needs: 0, new: 0, working: 1))) == WidgetLink.app)
}
```

- [ ] **Step 2: Hashable rows and counts (`ios/BlimpKit/Sources/BlimpKit/Widgets.swift`)**

Replace `    public struct Counts: Codable, Sendable, Equatable {` with
`    public struct Counts: Codable, Sendable, Hashable {`, and
`    public struct Row: Codable, Sendable, Equatable, Identifiable {` with
`    public struct Row: Codable, Sendable, Hashable, Identifiable {`. Nothing else changes (`Hashable` includes
`Equatable`, so `WidgetSummary`'s own `Equatable` still holds).

- [ ] **Step 3: Write the model and words**

Create `ios/BlimpKit/Sources/BlimpKit/Live.swift`:

```swift
// The phone's live panel (docs/superpowers/specs/2026-10-26-phone-live-activity-design.md): what blimpd sends as its
// Live Activity's content-state (src/live.ts), which iOS decodes with these types' default coding (so times are
// milliseconds as numbers, never Date, whose default coding is seconds since 2001), and the words and link the panel
// uses. The Live Activity type itself needs ActivityKit, so it's in ios/Live/, outside BlimpKit.
import Foundation

public struct LiveState: Codable, Sendable, Hashable {
    public struct Steps: Codable, Sendable, Hashable {
        public let done: Int
        public let total: Int
        /// The step in progress, in Claude's words; nil when none is.
        public let current: String?

        public init(done: Int, total: Int, current: String? = nil) {
            self.done = done
            self.total = total
            self.current = current
        }
    }

    /// The turn started from the phone.
    public struct Turn: Codable, Sendable, Hashable {
        public let session: String
        public let dir: String
        public let title: String
        /// .needs while it waits on you, else .working.
        public let state: WidgetSummary.State
        /// Milliseconds: when its prompt went in.
        public let since: Double
        /// nil: Claude keeps no task list for it.
        public let steps: Steps?

        public init(session: String, dir: String, title: String, state: WidgetSummary.State, since: Double, steps: Steps? = nil) {
            self.session = session
            self.dir = dir
            self.title = title
            self.state = state
            self.since = since
            self.steps = steps
        }
    }

    public let turn: Turn?
    /// The widgets' rows (needs you, new, working), the turn's own left out: blimpd sends 3 under a turn, 4 without.
    public let rows: [WidgetSummary.Row]
    public let counts: WidgetSummary.Counts

    public init(turn: Turn? = nil, rows: [WidgetSummary.Row], counts: WidgetSummary.Counts) {
        self.turn = turn
        self.rows = rows
        self.counts = counts
    }
}

public enum LiveText {
    /// "Step 4 of 7": the one after those done; all done, the last.
    public static func step(_ s: LiveState.Steps) -> String {
        "Step \(min(s.done + 1, s.total)) of \(s.total)"
    }

    /// The bar: the share done, 0 to 1.
    public static func progress(_ s: LiveState.Steps) -> Double {
        s.total > 0 ? min(1, Double(s.done) / Double(s.total)) : 0
    }

    /// The Dynamic Island's two sides: "?2" and "●3".
    public static func compact(_ c: WidgetSummary.Counts) -> (leading: String, trailing: String) {
        ("\(WidgetText.symbol(.needs))\(c.needs)", "\(WidgetText.symbol(.working))\(c.working)")
    }

    /// Its smallest form: ? when something needs you, else ●.
    public static func minimal(_ c: WidgetSummary.Counts) -> String {
        WidgetText.symbol(c.needs > 0 ? .needs : .working)
    }

    /// A tap: the turn's chat, else the oldest that needs you, else the app.
    public static func link(_ l: LiveState) -> URL {
        if let turn = l.turn { return WidgetLink.url(session: turn.session) }
        return l.rows.first(where: { $0.state == .needs }).map { WidgetLink.url(session: $0.session) } ?? WidgetLink.app
    }
}
```

- [ ] **Step 4: Re-read both files against the tests**

Check by eye: every name the tests use exists with that label; `LiveText.compact` returns
`(leading: String, trailing: String)` and the tests read `.leading` and `.trailing`; `Steps.init`'s `current` defaults
to nil and `LiveState.init`'s `turn` to nil, as the tests call them; every JSON key in the tests' strings is a property
name (`turn`, `session`, `dir`, `title`, `state`, `since`, `steps`, `done`, `total`, `current`, `rows`, `counts`) and
matches `src/live.ts`'s `LiveState`; nothing in `Live.swift` imports more than Foundation.

- [ ] **Step 5: Commit**

```bash
git add ios/BlimpKit/Sources/BlimpKit/Live.swift ios/BlimpKit/Sources/BlimpKit/Widgets.swift ios/BlimpKit/Tests/BlimpKitTests/LiveTests.swift
git commit -m "BlimpKit: the live panel's content (blimpd's content-state: the followed turn with its steps, the rows and the counts), its words (Step 4 of 7, the bar, ?2 and ●3 in the Dynamic Island) and the link a tap opens; the widgets' rows and counts are Hashable"
```

---

### Task 6: The app: the Live Activity type, its tokens to blimpd, starting it when open, and the Settings switch

**Files:**
- Create: `ios/Live/BlimpActivityAttributes.swift`, `ios/Blimp/LiveShare.swift`
- Modify: `ios/BlimpKit/Sources/BlimpKit/Models.swift` (`EventsMessage`, near line 361)
- Modify: `ios/BlimpKit/Tests/BlimpKitTests/LiveTests.swift` (one test at the end)
- Modify: `ios/Blimp/Model/Store.swift` (`connect()`'s switch, `update(_:)`'s `.open` case, `signOut()`)
- Modify: `ios/Blimp/Push.swift` (`AppDelegate.application(_:didFinishLaunchingWithOptions:)`)
- Modify: `ios/Blimp/Views/SettingsView.swift`
- Modify: `ios/project.yml` (the Blimp target's `sources` and `info`)
- Modify: `ios/BlimpUITests/BlimpUITests.swift` (`launchable(push:)`)

**Interfaces:**
- Consumes: `LiveState` (Task 5); `WidgetShared.group`, `WidgetShared.files(in:)`, `WidgetShared.read(_:from:)`,
  `WidgetShared.Server` (BlimpKit `Widgets.swift`; `server.json` is written by `WidgetShare.update`); `Push.env`;
  `POST`/`DELETE /push/live` with the widget key (Task 3); the events socket's `{"type":"live","state":…}` (Task 4).
- Produces:
  - `struct BlimpActivityAttributes: ActivityAttributes { typealias ContentState = LiveState }`, compiled into the
    app and (Task 7) the widget extension.
  - `EventsMessage.live(LiveState)`.
  - `LiveShare.off: Bool` (UserDefaults `liveOff`), `LiveShare.observe()`, `LiveShare.start(_ state: LiveState)`,
    `LiveShare.update()`, `LiveShare.stop()`.
  - `NSSupportsLiveActivities` and `NSSupportsLiveActivitiesFrequentUpdates` in the app's Info.plist.

ActivityKit names used here, from memory of the iOS 17.2+ SDK (the app targets iOS 26):
`Activity<A>.pushToStartTokenUpdates`, `Activity<A>.pushToStartToken`, `Activity<A>.activityUpdates`,
`Activity<A>.activities`, `Activity<A>.request(attributes:content:pushType:)`, `.pushTokenUpdates`, `.pushToken`,
`.id`, `.end(_:dismissalPolicy:)`, `ActivityContent(state:staleDate:)`, `ActivityAuthorizationInfo().areActivitiesEnabled`,
`PushType.token`. CI's compile confirms them. If it rejects a name, read the SDK's interface on the runner
(`find "$(xcrun --sdk iphonesimulator --show-sdk-path)" -name '*.swiftinterface' -path '*ActivityKit*'`, or the
lines CI's log quotes) and match its spelling; keep the behaviour. If Swift 6 says an `Activity` "risks causing data
races" anywhere in `LiveShare.swift` (`observe()`, `watch(_:)`, `stop()`), change `import ActivityKit` in `LiveShare.swift` to
`@preconcurrency import ActivityKit`; if instead the compiler warns that `@preconcurrency` has no effect, take it out.

- [ ] **Step 1: The Live Activity type**

Create `ios/Live/BlimpActivityAttributes.swift`:

```swift
// The live panel's Live Activity type, in both the app (which starts a panel and hands blimpd its tokens) and the
// widget extension (which draws it). Its name is the attributes-type blimpd's push-to-start names (src/live.ts), and
// its content is BlimpKit's LiveState, blimpd's content-state. It has no attributes of its own: blimpd sends {}.
import ActivityKit
import BlimpKit

struct BlimpActivityAttributes: ActivityAttributes {
    typealias ContentState = LiveState
}
```

- [ ] **Step 2: The events socket's live message (BlimpKit `Models.swift`)**

In `EventsMessage`, replace:

```swift
    /// The server browser's tabs (Browser.swift), every folder's.
    case sessions([Session]), browser([BrowserTab]), other
```

with:

```swift
    /// The server browser's tabs (Browser.swift), every folder's. live: blimpd asks the open app to start the live
    /// panel with this content (src/push/live.ts).
    case sessions([Session]), browser([BrowserTab]), live(LiveState), other
```

Replace the `Wire` line with:

```swift
    private struct Wire: Decodable { let type: String; let sessions: [Lenient<Session>]?; let tabs: [Lenient<BrowserTab>]?; let state: Lenient<LiveState>? }
```

In `decode(_:)`, after the `browser` line, add:

```swift
        if w.type == "live", let l = w.state?.value { return .live(l) }
```

(`state` is `Lenient`, so a message whose `state` isn't a panel's content is `.other`, never a failed decode of the
whole message.)

At the end of `ios/BlimpKit/Tests/BlimpKitTests/LiveTests.swift`, add:

```swift
@Test func blimpdAsksTheOpenAppToStartThePanelOverTheEventsSocket() throws {
    let l = try JSONDecoder().decode(LiveState.self, from: Data(full.utf8))
    #expect(EventsMessage.decode(Data(#"{"type":"live","state":\#(full)}"#.utf8)) == .live(l))
    #expect(EventsMessage.decode(Data(#"{"type":"live","state":{"rows":5}}"#.utf8)) == .other)
    #expect(EventsMessage.decode(Data(#"{"type":"sessions","sessions":[]}"#.utf8)) == .sessions([]))
}
```

- [ ] **Step 3: The tokens and the panel (`ios/Blimp/LiveShare.swift`)**

Create `ios/Blimp/LiveShare.swift`:

```swift
// The live panel's side in the app (docs/superpowers/specs/2026-10-26-phone-live-activity-design.md, "How"): iOS's
// push-to-start token, and each panel's own push token, go to blimpd (POST /push/live) with the widget key from the
// App Group's server.json (WidgetShare.swift). Unlike the Keychain, that file can be read while the phone is locked,
// which is when iOS wakes the app to hand over a panel blimpd started. With the app open, blimpd asks it to start the
// panel itself (the events socket's "live" message), so no banner shows. One panel: a new one ends any other (blimpd's
// and the app's can cross). Off in Settings, or signing out: blimpd forgets the tokens and the panel ends.
import ActivityKit
import BlimpKit
import Foundation
import UIKit

@MainActor
enum LiveShare {
    /// Off in Settings ("Live panel on the lock screen" is on by default).
    static var off: Bool {
        get { UserDefaults.standard.bool(forKey: "liveOff") }
        set { UserDefaults.standard.set(newValue, forKey: "liveOff") }
    }

    private static var observing = false
    /// The panels whose push tokens are watched, by id.
    private static var watched: Set<String> = []

    /// At launch, also when iOS launches the app in the background for a panel blimpd started: the push-to-start token,
    /// new panels, and each panel's token, as iOS gives them.
    static func observe() {
        guard !observing else { return }
        observing = true
        Task {
            for await data in Activity<BlimpActivityAttributes>.pushToStartTokenUpdates {
                if !off { send("POST", kind: "start", token: hex(data)) }
            }
        }
        Task {
            for await activity in Activity<BlimpActivityAttributes>.activityUpdates {
                for other in Activity<BlimpActivityAttributes>.activities where other.id != activity.id {
                    await other.end(nil, dismissalPolicy: .immediate)
                }
                watch(activity)
            }
        }
        for activity in Activity<BlimpActivityAttributes>.activities { watch(activity) }
    }

    private static func watch(_ activity: Activity<BlimpActivityAttributes>) {
        guard watched.insert(activity.id).inserted else { return }
        Task {
            for await data in activity.pushTokenUpdates {
                if !off { send("POST", kind: "activity", token: hex(data)) }
            }
        }
    }

    /// blimpd asked: the app is open, so it starts the panel (no banner). Not when it's off here or in iOS Settings,
    /// when the app isn't in front after all (blimpd then pushes it 10 s on), or when one is up already.
    static func start(_ state: LiveState) {
        guard !off, ActivityAuthorizationInfo().areActivitiesEnabled, UIApplication.shared.applicationState == .active,
              Activity<BlimpActivityAttributes>.activities.isEmpty
        else { return }
        let content = ActivityContent(state: state, staleDate: nil)
        if let activity = try? Activity<BlimpActivityAttributes>.request(attributes: BlimpActivityAttributes(), content: content, pushType: .token) {
            watch(activity)
        }
    }

    /// Each time the app is online, the tokens again: blimpd forgets them on pair --revoke, and one sent while offline
    /// was lost.
    static func update() {
        guard !off else { return }
        if let data = Activity<BlimpActivityAttributes>.pushToStartToken { send("POST", kind: "start", token: hex(data)) }
        for activity in Activity<BlimpActivityAttributes>.activities {
            if let data = activity.pushToken { send("POST", kind: "activity", token: hex(data)) }
        }
    }

    /// Off in Settings, or signing out: blimpd forgets this phone's panel tokens, and the panel ends.
    static func stop() {
        if let data = Activity<BlimpActivityAttributes>.pushToStartToken { send("DELETE", kind: "start", token: hex(data)) }
        for activity in Activity<BlimpActivityAttributes>.activities {
            if let data = activity.pushToken { send("DELETE", kind: "activity", token: hex(data)) }
        }
        Task {
            for activity in Activity<BlimpActivityAttributes>.activities {
                await activity.end(nil, dismissalPolicy: .immediate)
            }
        }
    }

    private struct Body: Encodable {
        let kind: String
        let token: String
        let env: String
    }

    /// With the server and widget key in the App Group, read now (signing out removes them right after). Neither yet
    /// (not online since pairing), or no key (an older blimpd): nothing is sent. A failure is dropped: update() sends
    /// again the next time the app is online.
    private static func send(_ method: String, kind: String, token: String) {
        guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: WidgetShared.group),
              let server = WidgetShared.read(WidgetShared.Server.self, from: WidgetShared.files(in: container).server),
              let key = server.key,
              var c = URLComponents(url: server.url, resolvingAgainstBaseURL: false)
        else { return }
        c.path += "/push/live"
        guard let url = c.url else { return }
        var req = URLRequest(url: url, timeoutInterval: 20)
        req.httpMethod = method
        req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONEncoder().encode(Body(kind: kind, token: token, env: Push.env))
        let request = req
        Task { _ = try? await URLSession.shared.data(for: request) }
    }

    private static func hex(_ data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }
}
```

- [ ] **Step 4: Store (`ios/Blimp/Model/Store.swift`)**

In `connect()`'s `switch EventsMessage.decode(data)`, between the `.browser` case and `case .other:`, add:

```swift
                case .live(let state):
                    LiveShare.start(state)
```

In `update(_:)`'s `.open` case, after `                await WidgetShare.update(api: api) { self?.server == api.server }`,
add:

```swift
                // The live panel's tokens, with the widget key WidgetShare just left in the App Group.
                LiveShare.update()
```

In `signOut()`, after `        stopPush()`, add:

```swift
        LiveShare.stop()
```

(before `WidgetShare.forget(api: api)`, which removes the App Group's server.json that `stop()` reads.)

- [ ] **Step 5: Watching from launch (`ios/Blimp/Push.swift`)**

In `AppDelegate.application(_:didFinishLaunchingWithOptions:)`, replace:

```swift
        UNUserNotificationCenter.current().delegate = self
        return true
```

with:

```swift
        UNUserNotificationCenter.current().delegate = self
        // The live panel's tokens, also when iOS launches the app in the background to hand over one blimpd started.
        LiveShare.observe()
        return true
```

- [ ] **Step 6: The Settings switch (`ios/Blimp/Views/SettingsView.swift`)**

Replace the first line's comment with:

```swift
// Settings: which server this phone is paired with, notifications, the live panel, the voice replies are read in, and
// sign out.
```

After `    @State private var notify = !Push.off`, add:

```swift
    /// The live panel on the lock screen (LiveShare.off is the opposite).
    @State private var live = !LiveShare.off
```

Between the Notifications section's closing `}` (after its `footer:`) and the `Section {` that starts with
`voiceRow("Automatic", …)`, add:

```swift
                Section {
                    Toggle("Live panel on the lock screen", isOn: $live)
                        .tint(.green)
                        .accessibilityIdentifier("liveSwitch")
                        .onChange(of: live) { _, on in
                            LiveShare.off = !on
                            if on { LiveShare.update() } else { LiveShare.stop() }
                        }
                } footer: {
                    Text("What needs you and what's working, and a turn you start here step by step, on the lock screen and in the Dynamic Island. Titles show while the phone is locked.")
                }
```

- [ ] **Step 7: The target (`ios/project.yml`)**

In the `Blimp` target, replace `    sources: [Blimp]` with `    sources: [Blimp, Live]`. In its `info: properties:`,
after `        NSCameraUsageDescription: blimp uses the camera to scan the pairing code from your server.`, add:

```yaml
        # The live panel (LiveShare.swift), a Live Activity that blimpd's pushes start and update. Frequent updates:
        # a needs-you goes at priority 10, which iOS otherwise limits.
        NSSupportsLiveActivities: true
        NSSupportsLiveActivitiesFrequentUpdates: true
```

- [ ] **Step 8: The UI tests launch with the panel off (`ios/BlimpUITests/BlimpUITests.swift`)**

`testPushOpensTheChat` waits for `"development"` in blimpd's push.json to know the phone signed up for notifications;
a panel token (also `"development"`) must not get there first. In `launchable(push:)`, replace the doc comment's second
line and the `pushOff` line:

```swift
    /// Notifications off (Push: `pushOff`), so iOS's question never covers a test's screen, unless `push`.
```

```swift
        if !push { app.launchArguments += ["-pushOff", "YES"] }
```

with:

```swift
    /// Notifications off (Push: `pushOff`), so iOS's question never covers a test's screen, unless `push`. The live
    /// panel off (LiveShare: `liveOff`), so its tokens never reach the push.json testPushOpensTheChat reads.
```

```swift
        if !push { app.launchArguments += ["-pushOff", "YES"] }
        app.launchArguments += ["-liveOff", "YES"]
```

No test is added, so the shard lists in `.github/workflows/ios.yml` stay as they are.

- [ ] **Step 9: Re-read every edited Swift region**

Check: `LiveShare` is `@MainActor`, as `Store`, `AppDelegate` and `SettingsView` are, so its calls need no `await`;
`Push.env` is read on the main actor; `send` reads the App Group before its `Task`, and the `Task` captures the `let
request`, not the `var req`; `Store`'s switch now has a case for each of `sessions`, `browser`, `live`, `other`; the
new test's raw string interpolates with `\#(full)`; the switch's footer matches the Notifications one's form.

- [ ] **Step 10: Commit**

```bash
git add ios/Live/BlimpActivityAttributes.swift ios/Blimp/LiveShare.swift ios/BlimpKit/Sources/BlimpKit/Models.swift ios/BlimpKit/Tests/BlimpKitTests/LiveTests.swift ios/Blimp/Model/Store.swift ios/Blimp/Push.swift ios/Blimp/Views/SettingsView.swift ios/project.yml ios/BlimpUITests/BlimpUITests.swift
git commit -m "iPhone: the live panel's Live Activity type; the app sends blimpd its push-to-start token and each panel's token with the widget key (so it works while locked), starts the panel itself when blimpd asks and it's open, keeps one panel, and has the Settings switch Live panel on the lock screen; the UI tests launch with it off"
```

---

### Task 7: The widget extension draws the live panel

**Files:**
- Create: `ios/BlimpWidgets/LiveView.swift`
- Modify: `ios/BlimpWidgets/BlimpWidgets.swift` (the opening comment, `BlimpWidgetBundle`)
- Modify: `ios/project.yml` (the BlimpWidgets target's comment and `sources`)
- Docs: `ios/README.md`, `docs/PHONE-CHECKLIST.md`

**Interfaces:**
- Consumes: `BlimpActivityAttributes` (Task 6, `ios/Live/`); `LiveState`, `LiveText` (Task 5); `WidgetText`,
  `WidgetSummary.Row` (BlimpKit); `ElapsedView` (`ios/BlimpWidgets/SessionsView.swift`).
- Produces: `LiveWidget: Widget` (an `ActivityConfiguration` for `BlimpActivityAttributes`) in `BlimpWidgetBundle`;
  views `LivePanel`, `TurnView`, `LiveRowView`.

WidgetKit and ActivityKit names used here, from memory: `ActivityConfiguration(for:content:dynamicIsland:)` (written
with trailing closures), `ActivityViewContext.state`, `DynamicIsland(expanded:compactLeading:compactTrailing:minimal:)`,
`DynamicIslandExpandedRegion(.leading | .trailing | .bottom)`, `.widgetURL(_:)` on a `DynamicIsland`. If CI's compiler
spells one differently, match the SDK's WidgetKit interface (as in Task 6's note) and keep the layout.

- [ ] **Step 1: The target (`ios/project.yml`)**

In the `BlimpWidgets` target, replace `    sources: [BlimpWidgets]` with `    sources: [BlimpWidgets, Live]`. Replace the
target's comment's first line,
`  # The widgets (BlimpWidgets/): every project's sessions on the home screen and the lock screen. Swift 5 language`,
with these two lines:

```yaml
  # The widgets and the live panel (BlimpWidgets/; the Live Activity type is in Live/, shared with the app): every
  # project's sessions on the home screen and the lock screen. Swift 5 language
```

- [ ] **Step 2: The panel's views**

Create `ios/BlimpWidgets/LiveView.swift`:

```swift
// The live panel (docs/superpowers/specs/2026-10-26-phone-live-activity-design.md): one Live Activity, on the lock
// screen and in the Dynamic Island. On top the turn started from the phone, with "Step n of m", a bar and the step in
// progress when Claude keeps a task list; then what needs you, what's new and what's working (the widgets' rows), and
// the counts. blimpd sends what it shows (BlimpKit's LiveState); the timers count up by themselves. A tap opens the
// turn's chat, else the oldest that needs you, else the app. The widgets' symbols, so it reads in one colour.
import ActivityKit
import BlimpKit
import SwiftUI
import WidgetKit

struct LiveWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: BlimpActivityAttributes.self) { context in
            LivePanel(state: context.state).padding(14).widgetURL(LiveText.link(context.state))
        } dynamicIsland: { context in
            let state = context.state
            let compact = LiveText.compact(state.counts)
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Text(verbatim: "blimp").font(.headline)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(verbatim: WidgetText.line(state.counts)).font(.caption.weight(.medium))
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 6) {
                        if let turn = state.turn { TurnView(turn: turn) }
                        ForEach(state.rows.prefix(state.turn == nil ? 3 : 2)) { LiveRowView(row: $0) }
                    }
                }
            } compactLeading: {
                Text(verbatim: compact.leading).font(.caption.bold())
            } compactTrailing: {
                if let turn = state.turn {
                    Text(Date(timeIntervalSince1970: turn.since / 1000), style: .timer)
                        .font(.caption.monospacedDigit()).multilineTextAlignment(.trailing).frame(width: 44)
                } else {
                    Text(verbatim: compact.trailing).font(.caption.bold())
                }
            } minimal: {
                Text(verbatim: LiveText.minimal(state.counts)).font(.caption.bold())
            }
            .widgetURL(LiveText.link(state))
        }
    }
}

/// The lock screen's panel: the turn, the rows, then "blimp" and the counts.
struct LivePanel: View {
    let state: LiveState

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let turn = state.turn { TurnView(turn: turn) }
            ForEach(state.rows) { LiveRowView(row: $0) }
            HStack {
                Text(verbatim: "blimp").font(.caption.bold())
                Spacer()
                Text(verbatim: WidgetText.line(state.counts)).font(.caption.weight(.medium)).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The turn started from the phone: its state's symbol, title, project's two letters and a timer from its prompt; with
/// a task list, "Step 4 of 7", the bar, and the step in progress.
struct TurnView: View {
    let turn: LiveState.Turn

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text(verbatim: WidgetText.symbol(turn.state)).font(.subheadline.bold()).frame(width: 14)
                Text(verbatim: turn.title).font(.subheadline.weight(.semibold)).lineLimit(1)
                Spacer(minLength: 4)
                Text(verbatim: WidgetText.letters(dir: turn.dir)).font(.caption2.bold()).foregroundStyle(.secondary)
                Text(Date(timeIntervalSince1970: turn.since / 1000), style: .timer)
                    .font(.caption.monospacedDigit()).multilineTextAlignment(.trailing).frame(width: 52)
            }
            if let steps = turn.steps {
                HStack(spacing: 8) {
                    ProgressView(value: LiveText.progress(steps)).tint(Color.primary)
                    Text(verbatim: LiveText.step(steps)).font(.caption.weight(.medium)).fixedSize()
                }
                .padding(.leading, 20)
                if let current = steps.current {
                    Text(verbatim: current).font(.caption).foregroundStyle(.secondary).lineLimit(1).padding(.leading, 20)
                }
            }
        }
    }
}

/// A session under the turn, as a widget's row (RowView) but without a link of its own: the panel has one.
struct LiveRowView: View {
    let row: WidgetSummary.Row

    var body: some View {
        HStack(spacing: 6) {
            Text(verbatim: WidgetText.symbol(row.state)).font(.caption.bold()).frame(width: 14)
            Text(verbatim: row.title).font(.caption).lineLimit(1)
            Spacer(minLength: 4)
            if row.state == .working { ElapsedView(since: row.since) }
            Text(verbatim: WidgetText.letters(dir: row.dir)).font(.caption2.bold()).foregroundStyle(.secondary)
        }
    }
}
```

- [ ] **Step 3: In the bundle (`ios/BlimpWidgets/BlimpWidgets.swift`)**

At the end of the opening comment (after `// last summary they had, greyed.`), add:

```swift
// The live panel (LiveView.swift) is in this extension too: a Live Activity's views live in a widget extension.
```

Replace `    var body: some Widget { SessionsWidget() }` with:

```swift
    var body: some Widget {
        SessionsWidget()
        LiveWidget()
    }
```

- [ ] **Step 4: Re-read both Swift files**

Check: every `Text` of a title, count or symbol uses `verbatim:`; the two timers keep the `Text(date, style: .timer)`
form; the `dynamicIsland:` closure has `let`s, so it says `return DynamicIsland { … }` (it isn't a view builder);
`ForEach` over `rows.prefix(…)` works as `SessionsView.swift`'s does (`Row` is `Identifiable`); no type is named like a
SwiftUI one; `.tint(Color.primary)` is on the `ProgressView` only.

- [ ] **Step 5: Docs**

In `ios/README.md`, before `## Check list`, add:

```markdown
## Live panel

The live panel is a Live Activity: the large panel on the lock screen, and the Dynamic Island. On top, a turn you started from the phone: its title, its project's two letters, a timer and, when Claude keeps a task list, "Step 4 of 7", a bar and the step it's on. Below, what needs you (?), what's new (✓) and what's working (●), as the widgets show them, then the counts. A tap opens the turn's chat, else the oldest that needs you, else the app.

blimpd starts it when something needs you or is working, and ends it 10 minutes after nothing does. With blimp open it starts without a banner; with blimp closed, iOS shows a quiet one ("2 need you, 3 working", no sound). Updates come only when something changes, and make no sound: the notifications ring. It needs blimpd newer than 0.3.12 with its push key (`blimpd push-key`, as for notifications) and the app opened once after pairing. To turn it off: Settings > "Live panel on the lock screen", or iOS Settings > blimp > Live Activities.

Nothing to set up on Apple's developer site: a Live Activity uses the app's own push key and Push Notifications, and its views are in the widget extension.
```

In `docs/PHONE-CHECKLIST.md`, after the `## Widgets` list and before `## The blimp`, add:

```markdown
## Live panel

- [ ] With blimp open, send a prompt from the phone to a session. The panel appears without a banner: the turn on top with its title, its project's letters and a timer from the prompt, and the other sessions below.
- [ ] With blimp closed and the phone locked, start a turn on the Mac. Within seconds a quiet banner ("2 need you, 3 working" or similar, no sound), and the panel on the lock screen.
- [ ] Then, still locked, let a session start waiting on you: the panel shows it as ? within seconds (blimpd got the panel's own token from the phone; if it never updates, check blimpd's log for `live panel`).
- [ ] In a turn sent from the phone where Claude keeps a task list: "Step n of m", a bar that fills, and the step in progress, changing as Claude goes.
- [ ] Dynamic Island: ?n and ●n; while a turn from the phone runs, its timer instead of ●n. Long-press: the turn and the first rows.
- [ ] A tap opens the turn's chat; with no turn, the oldest that needs you.
- [ ] 10 minutes after nothing needs you or works, the panel goes away by itself.
- [ ] Settings > "Live panel on the lock screen" off: the panel goes away and doesn't come back. On again: it's back with the next busy turn.
- [ ] After 8 busy hours, a panel is still there (blimpd started a new one at 7 h 45 min, with another quiet banner).
```

- [ ] **Step 6: Commit**

```bash
git add ios/project.yml ios/BlimpWidgets/LiveView.swift ios/BlimpWidgets/BlimpWidgets.swift ios/README.md docs/PHONE-CHECKLIST.md
git commit -m "iPhone: the live panel's views in the widget extension: on the lock screen the turn followed from the phone (title, letters, timer, Step n of m with its bar and the step in progress) above the widgets' rows and counts; in the Dynamic Island ?2 and ●3 (the turn's timer while one runs), ? or ● at its smallest, and the turn and first rows expanded"
```

---

### Task 8: CI verification

**Files:** none, unless CI finds something; then a fix through a helper, with a commit per fix.

- [ ] **Step 1: Run the whole server suite**

Run: `PATH=$HOME/.bun/bin:$PATH bun test`
Expected: 0 fail.

- [ ] **Step 2: Ask Max before pushing**

Pushing the branch starts the iOS workflow on the MacBook's runners. Ask Max in one plain line, for example: "ok to
push the live panel branch? it starts the iOS CI on the MacBook". Wait for a yes.

- [ ] **Step 3: Push and watch the push run**

Run: `git push -u origin phone-live-activity`, then find the iOS run for the branch
(`gh run list --branch phone-live-activity --limit 3`) and watch it in the background:
`gh run watch <id> --exit-status --interval 30` (run_in_background). This run compiles the app and the extension with
warnings as errors, runs BlimpKit's tests (on Linux and the Mac), and the core UI tests.

- [ ] **Step 4: Fix what CI finds**

Compile errors or failing tests go to a helper with the log's lines and this plan's task text, one fix commit each,
then push and watch again. For an ActivityKit or WidgetKit name the SDK spells differently, or a Swift 6 complaint
about an `Activity`, see Task 6's and Task 7's notes.

- [ ] **Step 5: The layout run**

Check main's iOS runs are idle (`gh run list --workflow iOS --branch main --limit 3`; nothing `in_progress` or
`queued`). Then run the layout and gesture tests too, so a Settings section that moved things down is caught:
`gh workflow run iOS --ref phone-live-activity -f layout=true -f testflight=false`, and watch it in the background as
in Step 3. Fix what it finds as in Step 4.

- [ ] **Step 6: Ask Max about a TestFlight build from the branch**

The panel can only be seen on a real phone (`docs/PHONE-CHECKLIST.md`, "Live panel"), so Max needs a build. Check
main's iOS runs are idle again, then ask Max in one plain line, for example: "the branch is green. ok to send a
TestFlight build from it, so you can try the live panel?". On a yes:
`gh workflow run iOS --ref phone-live-activity -f layout=false -f testflight=true`, and watch it in the background.

- [ ] **Step 7: Report to Max**

Lead with the result: what passed, the TestFlight build number if one was uploaded, and what he should check on his
phone (`docs/PHONE-CHECKLIST.md`, "Live panel"). Remind him the panel needs blimpd newer than 0.3.12 with its push
key, so it works on his server after the next release and update.
