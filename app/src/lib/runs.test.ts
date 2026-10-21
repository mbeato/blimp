import { expect, test } from "bun:test";
import type { Session } from "./api";
import { fitBar, oneLine, runBar } from "./runs";
import { sessionTitle } from "./sessions";

const s = (name: string, extra: Partial<Session> = {}): Session => ({
  name,
  kind: "claude",
  pid: 1,
  clients: 0,
  created: 1,
  dir: "/p",
  cmd: "claude",
  title: name,
  status: "idle",
  state: "done",
  ...extra,
});
const run = (name: string, parent: string, command: string, startedAt: number, end?: { exit: number }) =>
  s(name, { kind: "run", run: { command, parent, cwd: "/p", startedAt, ...(end && { endedAt: startedAt + 1, exit: end.exit }) } });

test("a Claude session's commands: the first 3 shown, the rest in a menu", () => {
  const claude = s("web", { runnable: ["a", "b", "c", "d", "e"] });
  expect(runBar(claude, [claude], [])).toEqual({ key: "web\0a\0b\0c\0d\0e", shown: [{ command: "a" }, { command: "b" }, { command: "c" }], more: [{ command: "d" }, { command: "e" }] });
});

test("no bar without commands, for a session that isn't Claude, or once hidden for this reply", () => {
  expect(runBar(s("web"), [], [])).toBeNull();
  expect(runBar(s("web", { runnable: [] }), [], [])).toBeNull();
  expect(runBar(s("sh", { kind: "shell", runnable: ["ls"] }), [], [])).toBeNull();
  const claude = s("web", { runnable: ["ls"] });
  expect(runBar(claude, [], ["web\0ls"])).toBeNull();
  // A new reply with other commands shows again.
  expect(runBar({ ...claude, runnable: ["ls -la"] }, [], ["web\0ls"])).not.toBeNull();
});

test("each command has its newest run for this session, running or ended", () => {
  const claude = s("web", { runnable: ["bun test", "ls"] });
  const old = run("web-run-1", "web", "bun test", 1, { exit: 1 });
  const newer = run("web-run-2", "web", "bun test", 5);
  const other = run("api-run-1", "api", "ls", 9, { exit: 0 });
  expect(runBar(claude, [claude, old, newer, other], [])!.shown).toEqual([{ command: "bun test", run: newer }, { command: "ls" }]);
});

test("a run from before this reply began is an older reply's, not this one's", () => {
  const claude = s("web", { runnable: ["bun test"], runnableAt: 10 });
  const old = run("web-run-1", "web", "bun test", 9, { exit: 1 });
  expect(runBar(claude, [claude, old], [])!.shown).toEqual([{ command: "bun test" }]);
  const now = run("web-run-2", "web", "bun test", 10);
  expect(runBar(claude, [claude, old, now], [])!.shown).toEqual([{ command: "bun test", run: now }]);
});

test("oneLine: a command of several lines as one, for a button", () => {
  expect(oneLine("cd app\n  bun install\n")).toBe("cd app ⏎ bun install");
});

test("a run's row is titled by its command (blimpd's title for it)", () => {
  expect(sessionTitle({ ...run("web-run-1", "web", "bun test", 1), title: "bun test" })).toBe("bun test");
});

test("in a narrow split, the commands that don't fit go to the +N menu; one that has run keeps its place", () => {
  const claude = s("web", { runnable: ["a", "b", "c", "d"], runnableAt: 5 });
  const bar = runBar(claude, [claude], [])!;
  expect(fitBar(bar, 3)).toBe(bar);
  expect(fitBar(bar, 2)).toEqual({ key: bar.key, shown: [{ command: "a" }, { command: "b" }], more: [{ command: "c" }, { command: "d" }] });
  expect(fitBar(bar, 0).shown).toEqual([{ command: "a" }]); // at least one
  const ran = run("run-1", "web", "c", 10, { exit: 0 });
  const withRun = runBar(claude, [claude, ran], [])!;
  expect(fitBar(withRun, 2)).toEqual({ key: bar.key, shown: [{ command: "a" }, { command: "c", run: ran }], more: [{ command: "b" }, { command: "d" }] });
  expect(fitBar(withRun, 1).shown).toEqual([{ command: "c", run: ran }]);
});
