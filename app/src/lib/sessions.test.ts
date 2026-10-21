import { describe, expect, test } from "bun:test";
import type { Session } from "./api";
import { earlier, folderSessions, hasState, isClaude, lastActivity, listItems, moveItem, pickSession, sessionReference, sessionTitle, tildify } from "./sessions";

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

// Pasted into another session, its Claude can read this one's conversation and message it.
test("sessionReference", () => {
  const claude = s("blimp-3f2a", "/home/u/blimp", 1, { title: "Fix scroll lag", sessionId: "abc", transcript: "/home/u/.claude/projects/-home-u-blimp/abc.jsonl" });
  expect(sessionReference(claude)).toBe(
    'Another blimp session: "Fix scroll lag" (blimp-3f2a), in /home/u/blimp.\n' +
      "Its conversation so far (JSONL): /home/u/.claude/projects/-home-u-blimp/abc.jsonl\n" +
      'To send it a message: blimpd send blimp-3f2a "<message>"',
  );
  // Before its first message: no transcript yet, but it takes messages.
  expect(sessionReference({ ...claude, transcript: undefined })).toBe('Another blimp session: "Fix scroll lag" (blimp-3f2a), in /home/u/blimp.\nTo send it a message: blimpd send blimp-3f2a "<message>"');
  expect(sessionReference(s("blimp-sh", "/srv/x", 1, { kind: "shell" }))).toBe("Another blimp session: blimp-sh, in /srv/x.");
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

test("list: newest first; a split group sits where its newest session is, in its own order", () => {
  const listed = folderSessions([s("a", "/p", 1), s("b", "/p", 2), s("c", "/p", 3), s("d", "/p", 4), s("e", "/p", 5)], "/p");
  const names = (items: ReturnType<typeof listItems>) => items.map((i) => (Array.isArray(i) ? i.map((x) => x.name) : i.name));
  const by = (...n: string[]) => n.map((x) => listed.find((y) => y.name === x)!);
  expect(names(listItems(listed, []))).toEqual(["e", "d", "c", "b", "a"]);
  // An old pair doesn't jump above newer sessions; its left-to-right order stays.
  expect(names(listItems(listed, [by("a", "c")]))).toEqual(["e", "d", ["a", "c"], "b"]);
  expect(names(listItems(listed, [by("b", "a"), by("e", "d")]))).toEqual([["e", "d"], "c", ["b", "a"]]);
});

describe("the order rows are dragged into", () => {
  const listed = folderSessions([s("a", "/p", 1), s("b", "/p", 2), s("c", "/p", 3), s("d", "/p", 4), s("e", "/p", 5)], "/p");
  const names = (items: ReturnType<typeof listItems>) => items.map((i) => (Array.isArray(i) ? i.map((x) => x.name) : i.name));
  const by = (...n: string[]) => n.map((x) => listed.find((y) => y.name === x)!);

  test("a row dragged up or down lands in the gap it was let go in", () => {
    const items = listItems(listed, []);
    // e d c b a: a (row 4) to the top, then e (row 0) to the gap before a's old place.
    expect(moveItem(items, 4, 0)).toEqual(["a", "e", "d", "c", "b"]);
    expect(moveItem(items, 0, 4)).toEqual(["d", "c", "b", "e", "a"]);
    expect(moveItem(items, 1, 5)).toEqual(["e", "c", "b", "a", "d"]);
    // Let go where it was (the gap above or below itself): nothing moves.
    expect(moveItem(items, 2, 2)).toEqual(["e", "d", "c", "b", "a"]);
    expect(moveItem(items, 2, 3)).toEqual(["e", "d", "c", "b", "a"]);
  });

  test("the list follows the saved order", () => {
    expect(names(listItems(listed, [], ["a", "e", "d", "c", "b"]))).toEqual(["a", "e", "d", "c", "b"]);
  });

  test("a group moves as one, in its split order, and the order keeps it together", () => {
    const groups = [by("b", "d")];
    const items = listItems(listed, groups);
    expect(names(items)).toEqual(["e", ["b", "d"], "c", "a"]);
    const order = moveItem(items, 1, 4);
    expect(order).toEqual(["e", "c", "a", "b", "d"]);
    expect(names(listItems(listed, groups, order))).toEqual(["e", "c", "a", ["b", "d"]]);
    // The pair split up: its sessions stay where the group was.
    expect(names(listItems(listed, [], order))).toEqual(["e", "c", "a", "b", "d"]);
    // A new group sits where its first session in the order is.
    expect(names(listItems(listed, [by("d", "e")], order))).toEqual([["d", "e"], "c", "a", "b"]);
  });

  test("sessions the order doesn't know keep their newest-first place: a new one goes on top", () => {
    const order = ["a", "c", "e"];
    const withNew = folderSessions([...listed, s("f", "/p", 6)], "/p");
    expect(names(listItems(withNew, [], order))).toEqual(["f", "a", "d", "c", "b", "e"]);
  });

  test("ended sessions drop out; the others keep their order", () => {
    const order = ["a", "e", "x", "d", "c", "b"];
    const left = listed.filter((x) => x.name !== "d");
    expect(names(listItems(left, [], order))).toEqual(["a", "e", "c", "b"]);
    expect(moveItem(listItems(left, [], order), 3, 0)).toEqual(["b", "a", "e", "c"]);
  });
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
