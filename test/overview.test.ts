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
