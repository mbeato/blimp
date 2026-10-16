import { expect, test } from "bun:test";
import type { Session } from "./api";
import { folderGroups, lastActivity, tildify, waitingQueue } from "./sidebar";

const s = (name: string, dir: string, created: number, extra: Partial<Session> = {}): Session => ({
  name,
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

test("waiting sessions from every server form one queue, oldest wait first", () => {
  const q = waitingQueue([
    { link: "A", sessions: [s("a", "/home/u/x", 1, { state: "waiting", stateSince: 500 }), s("b", "/home/u/x", 2)] },
    { link: "B", sessions: [s("c", "/home/u/y", 3, { state: "waiting", stateSince: 100 })] },
  ]);
  expect(q.map((w) => [w.link, w.s.name])).toEqual([
    ["B", "c"],
    ["A", "a"],
  ]);
});

test("waiting sessions stay in their folder group, so it keeps its header", () => {
  const folders = folderGroups(
    [s("a", "/home/u/x", 1, { state: "waiting", stateSince: 500 }), s("b", "/home/u/y", 2)],
    "/home/u",
  );
  expect(folders.map((f) => [f.label, f.sessions.map((x) => x.name)])).toEqual([
    ["~/y", ["b"]],
    ["~/x", ["a"]],
  ]);
});

test("folder groups: sessions newest first, groups by their newest session", () => {
  const folders = folderGroups(
    [s("old", "/home/u/x", 10), s("mid", "/home/u/y", 20), s("new", "/home/u/x", 30), s("w", "/home/u/y", 25, { state: "working" })],
    "/home/u",
  );
  expect(folders.map((f) => f.dir)).toEqual(["/home/u/x", "/home/u/y"]);
  expect(folders[0].sessions.map((x) => x.name)).toEqual(["new", "old"]);
  expect(folders[1].sessions.map((x) => x.name)).toEqual(["w", "mid"]);
});

test("empty list", () => {
  expect(folderGroups([], "/home/u")).toEqual([]);
  expect(waitingQueue([])).toEqual([]);
});

test("last activity falls back from updatedAt to stateSince to created", () => {
  expect(lastActivity(s("a", "/", 5, { updatedAt: 9000, stateSince: 8000 }))).toBe(9000);
  expect(lastActivity(s("a", "/", 5, { stateSince: 8000 }))).toBe(8000);
  expect(lastActivity(s("a", "/", 5))).toBe(5000);
});
