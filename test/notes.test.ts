import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversations, projectFolderName } from "../src/folders";
import { checkNote, noteTick, notingPrompt, readNotes, saveNote, turnOf, wantsNote } from "../src/notes";
import { listSessions } from "../src/sessions";

const MIN = 60_000;
const now = 1_000_000_000_000;
const claude = { kind: "claude", state: "done" as const };

describe("wantsNote", () => {
  const sum = { prompts: 1, replies: 1 };
  test("a Claude session once its turn is over, with a prompt or a reply the last note didn't have", () => {
    expect(wantsNote(claude, sum, undefined, now)).toBe(true);
    expect(wantsNote({ kind: "claude-glm", state: "waiting" }, sum, undefined, now)).toBe(true);
    expect(wantsNote({ kind: "claude", state: "working" }, sum, undefined, now)).toBe(false);
    expect(wantsNote({ kind: "claude", state: "unknown" }, sum, undefined, now)).toBe(false);
    expect(wantsNote({ kind: "shell", state: "done" }, sum, undefined, now)).toBe(false);
    expect(wantsNote(claude, { prompts: 1, replies: 0 }, undefined, now)).toBe(false);
    const had = { status: "done" as const, text: "x", at: now - MIN, turn: turnOf(sum) };
    expect(wantsNote(claude, sum, had, now)).toBe(false);
    expect(wantsNote(claude, { prompts: 2, replies: 1 }, had, now)).toBe(true);
    expect(wantsNote(claude, { prompts: 1, replies: 2 }, had, now)).toBe(true);
  });

  test("a failed try waits 10 minutes", () => {
    expect(wantsNote(claude, sum, undefined, now, now - 9 * MIN)).toBe(false);
    expect(wantsNote(claude, sum, undefined, now, now - 10 * MIN)).toBe(true);
  });
});

test("notingPrompt: the title, the latest requests and the latest reply, cut to about 300 characters", () => {
  const p = notingPrompt({ title: "Release", last: ["ship it", "b".repeat(1000)], reply: "Released v0.2.16." });
  expect(p).toContain("DONE | ");
  expect(p).toContain("PROGRESS | ");
  expect(p).toContain("QUESTION | ");
  expect(p).toContain("Session: Release\nLatest requests, oldest first:\n- ship it\n");
  expect(p).toContain(`- ${"b".repeat(300)}…\n`);
  expect(p).toContain("Claude's latest reply: Released v0.2.16.\n");
});

describe("checkNote", () => {
  test("a status and a few words", () => {
    expect(checkNote("DONE | v0.2.16 out, phone build uploaded\n")).toEqual({ status: "done", text: "v0.2.16 out, phone build uploaded" });
    expect(checkNote("progress | fixing the flaky restart test.")).toEqual({ status: "progress", text: "fixing the flaky restart test" });
    expect(checkNote("QUESTION|which layout for the rows?")).toEqual({ status: "question", text: "which layout for the rows?" });
  });

  test("anything else is ignored", () => {
    expect(checkNote("")).toBeUndefined();
    expect(checkNote("v0.2.16 out")).toBeUndefined();
    expect(checkNote("MAYBE | something")).toBeUndefined();
    expect(checkNote("DONE | ")).toBeUndefined();
    expect(checkNote("DONE | a\nPROGRESS | b")).toBeUndefined();
    expect(checkNote(`DONE | ${"word ".repeat(20)}`)).toBeUndefined(); // over 80 characters
    expect(checkNote("DONE | bell\x07")).toBeUndefined();
  });
});

describe("notes.json", () => {
  test("600, through a temp file, the 500 newest kept", () => {
    const dir = mkdtempSync(join(tmpdir(), "blimp-notes-"));
    const file = join(dir, "notes.json");
    for (let i = 0; i < 503; i++) saveNote(`s${i}`, { status: "done", text: `t ${i}`, at: 1000 + i, turn: "1/1" }, file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const all = readNotes(file);
    expect(Object.keys(all).length).toBe(500);
    expect(all.s0).toBeUndefined();
    expect(all.s502).toEqual({ status: "done", text: "t 502", at: 1502, turn: "1/1" });
    writeFileSync(file, "{ not json");
    expect(readNotes(file)).toEqual({});
    rmSync(dir, { recursive: true, force: true });
  });
});

const line = (o: object) => JSON.stringify(o) + "\n";
const prompt = line({ type: "user", message: { role: "user", content: "release it" } });
const reply = line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Released." }] } });

test("the session list and the Earlier list carry each one's note, without its turn", () => {
  const home = mkdtempSync(join(tmpdir(), "blimp-notes-"));
  const cwd = join(home, "work");
  mkdirSync(cwd);
  const proj = join(home, "projects", projectFolderName(cwd));
  mkdirSync(proj, { recursive: true });
  mkdirSync(join(home, "sessions"));
  writeFileSync(join(proj, "s1.jsonl"), prompt + reply);
  writeFileSync(join(proj, "s2.jsonl"), prompt);
  writeFileSync(join(home, "sessions", "42.json"), JSON.stringify({ sessionId: "s1", cwd, status: "idle" }));
  const notes = { s1: { status: "done" as const, text: "released", at: 5, turn: "1/1" } };
  const zmxOut = `  name=w-1\tpid=42\tclients=0\tcreated=5\tcwd=${cwd}`;
  const list = listSessions(home, zmxOut, join(home, "status"), join(home, "memo.json"), {}, undefined, notes);
  expect(list[0].note).toEqual({ status: "done", text: "released", at: 5 });
  expect(listSessions(home, zmxOut, join(home, "status"), join(home, "memo.json"), {}, undefined, {})[0].note).toBeUndefined();
  const byId = Object.fromEntries(conversations(cwd, home, {}, undefined, notes).map((c) => [c.sessionId, c.note]));
  expect(byId).toEqual({ s1: { status: "done", text: "released", at: 5 }, s2: undefined });
  rmSync(home, { recursive: true, force: true });
});

describe("noteTick", () => {
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), "blimp-notes-"));
    const file = join(dir, "s1.jsonl");
    writeFileSync(file, prompt + reply);
    const session = { kind: "claude", state: "done" as const, sessionId: "s1", title: "Release" };
    const deps = { sessions: async () => [session], transcript: () => file, file: join(dir, "notes.json"), on: () => true };
    return { dir, file, session, deps };
  };

  test("a turn that ended gets a note, once; the model reads the turn", async () => {
    const { dir, deps } = setup();
    const asked: string[] = [];
    const ask = async (p: string) => (asked.push(p), "DONE | released v0.2.16");
    await noteTick(ask, () => now, deps);
    expect(readNotes(deps.file).s1).toEqual({ status: "done", text: "released v0.2.16", at: now, turn: "1/1" });
    expect(asked[0]).toContain("- release it\n");
    expect(asked[0]).toContain("Claude's latest reply: Released.\n");
    await noteTick(ask, () => now + MIN, deps);
    expect(asked.length).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  test("no note when the model's answer isn't one, or names are off", async () => {
    const { dir, deps } = setup();
    await noteTick(async () => "Sure! Here is a note.", () => now, deps);
    expect(readNotes(deps.file)).toEqual({});
    let asked = 0;
    await noteTick(async () => (asked++, "DONE | x"), () => now, { ...deps, on: () => false });
    expect(asked).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});
