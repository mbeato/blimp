import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDigest, digestKey, digestPrompt, digestTick, readDigests, saveDigest, shownDigests, wantsDigest, type DigestSession } from "../src/digests";

const MIN = 60_000;
const now = 1_000_000_000_000;
const one = (name: string, extra: Partial<DigestSession> = {}): DigestSession => ({ name, title: name.toUpperCase(), state: "done", ...extra });

describe("digestKey", () => {
  test("changes when a session starts or ends, its state changes or it gets a new note; not on order", () => {
    const a = one("a", { note: { status: "done", text: "x", at: 1 } });
    const k = digestKey([a, one("b")]);
    expect(digestKey([one("b"), a])).toBe(k);
    expect(digestKey([a, one("b", { state: "working" })])).not.toBe(k);
    expect(digestKey([{ ...a, note: { status: "done", text: "y", at: 2 } }, one("b")])).not.toBe(k);
    expect(digestKey([a])).not.toBe(k);
    // What the latest request says doesn't count: that's in the note once the turn ends.
    expect(digestKey([{ ...a, last: "more" }, one("b")])).toBe(k);
  });
});

describe("wantsDigest", () => {
  const had = { text: "t", sessions: ["a"], at: now - MIN, key: "old" };
  test("once the sessions changed and have stayed so for 15 s", () => {
    expect(wantsDigest("new", undefined, now - 15_000, now)).toBe(true);
    expect(wantsDigest("new", had, now - 15_000, now)).toBe(true);
    expect(wantsDigest("new", had, now - 14_000, now)).toBe(false);
    expect(wantsDigest("old", had, now - MIN, now)).toBe(false);
  });
  test("a failed try waits 10 minutes", () => {
    expect(wantsDigest("new", had, now - MIN, now, now - 9 * MIN)).toBe(false);
    expect(wantsDigest("new", had, now - MIN, now, now - 10 * MIN)).toBe(true);
  });
});

test("digestPrompt: the project, then each session numbered with where it stands", () => {
  const p = digestPrompt("blimp", [
    one("a", { title: "Fix login", state: "waiting", note: { status: "question", text: "use OAuth?", at: 1 } }),
    one("b", { title: "Rate limiter", state: "working", last: "x".repeat(500) }),
    one("c", { title: "Release", note: { status: "done", text: "v0.2.18 out", at: 1 } }),
    one("d", { title: "Flaky test", note: { status: "progress", text: "half the retries done", at: 1 } }),
  ]);
  expect(p).toContain("project blimp");
  expect(p).toContain("[the login fix](2)");
  expect(p).toContain('1. "Fix login": waiting on the user: use OAuth?\n');
  expect(p).toContain(`2. "Rate limiter": working now; the latest request: ${"x".repeat(200)}…\n`);
  expect(p).toContain('3. "Release": finished: v0.2.18 out\n');
  expect(p).toContain('4. "Flaky test": stopped part way: half the retries done\n');
});

describe("checkDigest", () => {
  test("a paragraph whose links all name one of the sessions", () => {
    expect(checkDigest("[The login fix](1) needs you to pick OAuth or keys.\n[The release](2) is out.", 2)).toBe("[The login fix](1) needs you to pick OAuth or keys. [The release](2) is out.");
    expect(checkDigest("Nothing much is going on.", 2)).toBe("Nothing much is going on.");
  });
  test("anything else is a failed try", () => {
    expect(checkDigest("[x](3) is done.", 2)).toBeUndefined();
    expect(checkDigest("[x](0) is done.", 2)).toBeUndefined();
    expect(checkDigest("[x](https://evil.example) is done.", 2)).toBeUndefined();
    expect(checkDigest("[x] is done.", 2)).toBeUndefined();
    expect(checkDigest("- a list\n- of things", 2)).toBeUndefined();
    expect(checkDigest("Two\n\nparagraphs.", 2)).toBeUndefined();
    expect(checkDigest("a\x07b", 2)).toBeUndefined();
    expect(checkDigest("", 2)).toBeUndefined();
    expect(checkDigest("w ".repeat(400), 2)).toBeUndefined();
  });
});

test("digests.json: 600, kept per folder, and none shown while names are off", () => {
  const dir = mkdtempSync(join(tmpdir(), "blimp-digests-"));
  try {
    const file = join(dir, "digests.json");
    saveDigest("/p", { text: "t", sessions: ["a"], at: 1, key: "k" }, file);
    saveDigest("/q", { text: "u", sessions: [], at: 2, key: "j" }, file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readDigests(file)["/p"].text).toBe("t");
    expect(shownDigests(["/p"], () => true, file)).toEqual({ "/p": { text: "t", sessions: ["a"], at: 1 } });
    expect(shownDigests(["/p"], () => false, file)).toEqual({});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("digestTick", () => {
  const sessions = [
    { name: "s1", dir: "/p", kind: "claude", state: "done" as const, sessionId: "id1", title: "Fix login", note: { status: "done" as const, text: "fixed", at: 1 } },
    { name: "s2", dir: "/p", kind: "claude", state: "working" as const, sessionId: "id2", title: "Limiter" },
    { name: "sh", dir: "/p", kind: "shell", state: "unknown" as const, title: "zsh" },
  ];
  const deps = (file: string, on = true) => ({ sessions: async () => sessions, transcript: () => undefined, file, on: () => on });

  test("writes a project's paragraph once its sessions have been still for 15 s, with the sessions its links name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "blimp-digests-"));
    try {
      const file = join(dir, "digests.json");
      const prompts: string[] = [];
      const ask = async (p: string) => (prompts.push(p), "[The login fix](1) is done and [the limiter](2) is still going.");
      let t = now;
      await digestTick(ask, () => t, deps(file));
      expect(prompts).toEqual([]); // just changed: wait
      t += 15_000;
      await digestTick(ask, () => t, deps(file));
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).not.toContain("zsh");
      expect(readDigests(file)["/p"]).toMatchObject({ text: "[The login fix](1) is done and [the limiter](2) is still going.", sessions: ["s1", "s2"], at: t });
      // Nothing changed: no new call.
      t += MIN;
      await digestTick(ask, () => t, deps(file));
      expect(prompts).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("none when the answer isn't a paragraph, or names are off", async () => {
    const dir = mkdtempSync(join(tmpdir(), "blimp-digests-"));
    try {
      const file = join(dir, "digests.json");
      let calls = 0;
      await digestTick(async () => (calls++, "nope"), () => now, deps(file, false));
      await digestTick(async () => (calls++, "nope"), () => now + 20_000, deps(file, false));
      expect(calls).toBe(0);
      await digestTick(async () => (calls++, "[bad](9)"), () => now + 40_000, { ...deps(file), sessions: async () => sessions.map((s) => ({ ...s, dir: "/r" })) });
      await digestTick(async () => (calls++, "[bad](9)"), () => now + 60_000, { ...deps(file), sessions: async () => sessions.map((s) => ({ ...s, dir: "/r" })) });
      expect(calls).toBe(1);
      expect(readDigests(file)["/r"]).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
