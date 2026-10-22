import { expect, test } from "bun:test";
import type { Session } from "./api";
import { branchLine } from "./work";

const s = (name: string, extra: Partial<Session> = {}): Session => ({
  name,
  kind: "claude",
  pid: 1,
  clients: 0,
  created: 1,
  dir: "/p",
  cmd: "claude",
  title: `${name} title`,
  status: "idle",
  state: "done",
  ...extra,
});

test("the row tooltip names the branch, and says when its checkout is a worktree", () => {
  expect(branchLine(s("a", { work: { branch: "feat/x" } }))).toBe("On branch feat/x");
  expect(branchLine(s("a", { work: { branch: "feat/x", root: "/p-wt", worktree: true } }))).toBe("On branch feat/x (worktree)");
  expect(branchLine(s("a", { work: { root: "/p" } }))).toBeUndefined();
  expect(branchLine(s("a"))).toBeUndefined();
});
