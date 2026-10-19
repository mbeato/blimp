import { expect, test } from "bun:test";
import type { Session } from "./api";
import { earlier, folderSessions, hasState, isClaude, lastActivity, pickSession, sessionTitle, tildify } from "./sessions";

const s = (name: string, dir: string, created: number, extra: Partial<Session> = {}): Session => ({
  name,
  kind: "claude",
  pid: 1,
  clients: 0,
  created,
  dir,
  cmd: "claude",
  title: name,
  status: "idle",
  state: "done",
  ...extra,
});

test("tildify", () => {
  expect(tildify("/home/u", "/home/u")).toBe("~");
  expect(tildify("/home/u/blimp", "/home/u")).toBe("~/blimp");
  expect(tildify("/home/user2/x", "/home/u")).toBe("/home/user2/x");
  expect(tildify("/srv/x", "")).toBe("/srv/x");
});

test("folder sessions: exactly this folder (not subfolders), newest first", () => {
  const list = [s("a", "/p", 1), s("b", "/p/sub", 3), s("c", "/p", 2), s("d", "/q", 4)];
  expect(folderSessions(list, "/p").map((x) => x.name)).toEqual(["c", "a"]);
  expect(folderSessions([], "/p")).toEqual([]);
});

test("earlier leaves out conversations a running session has open", () => {
  const convs = [
    { sessionId: "x", title: "X", updatedAt: 2 },
    { sessionId: "y", title: "Y", updatedAt: 1 },
  ];
  expect(earlier(convs, [s("a", "/p", 1, { sessionId: "x" }), s("b", "/p", 2)])).toEqual([convs[1]]);
});

test("the pane shows the session waiting longest, else the newest", () => {
  const list = folderSessions([s("a", "/p", 1), s("b", "/p", 2), s("c", "/p", 3)], "/p");
  expect(pickSession(list)?.name).toBe("c");
  const w = [s("a", "/p", 1, { state: "waiting", stateSince: 50 }), s("b", "/p", 2, { state: "waiting", stateSince: 10 })];
  expect(pickSession(w)?.name).toBe("b");
  expect(pickSession([])).toBeUndefined();
});

test("last activity falls back from updatedAt to stateSince to created", () => {
  expect(lastActivity(s("a", "/", 5, { updatedAt: 9000, stateSince: 8000 }))).toBe(9000);
  expect(lastActivity(s("a", "/", 5, { stateSince: 8000 }))).toBe(8000);
  expect(lastActivity(s("a", "/", 5))).toBe(5000);
});

test("kinds: Claude Code on Claude or GLM is titled by its conversation; Codex has state; others are plain", () => {
  const of = (kind: string) => s("web-1", "/w", 1, { kind, title: "Fix the build" });
  expect(["claude", "claude-glm", "codex", "codex-login", "shell", "aider"].map((k) => [isClaude(of(k)), hasState(of(k)), sessionTitle(of(k))])).toEqual([
    [true, true, "Fix the build"],
    [true, true, "Fix the build"],
    [false, true, "web-1"],
    [false, false, "web-1"],
    [false, false, "web-1"],
    [false, false, "web-1"],
  ]);
});
