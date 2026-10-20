import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversations, projectFolderName } from "../src/folders";
import { addMessage, checkName, NAMING_ARGS, namesOn, namingPrompt, readNames, saveName, type Summary, wantsName } from "../src/names";
import { listSessions, titleFromTranscript } from "../src/sessions";

const MIN = 60_000;
const now = 1_000_000_000_000;
const claude = { kind: "claude", state: "done" as const };

describe("wantsName", () => {
  const sum = { prompts: 1, replies: 1 };
  test("a Claude session with a prompt and a reply and no name yet, once its turn is over", () => {
    expect(wantsName(claude, sum, undefined, now)).toBe(true);
    expect(wantsName({ kind: "claude-glm", state: "waiting" }, sum, undefined, now)).toBe(true);
    expect(wantsName({ kind: "claude", state: "working" }, sum, undefined, now)).toBe(false);
    expect(wantsName({ kind: "claude", state: "unknown" }, sum, undefined, now)).toBe(false);
    expect(wantsName({ kind: "codex", state: "done" }, sum, undefined, now)).toBe(false);
    expect(wantsName({ kind: "shell", state: "done" }, sum, undefined, now)).toBe(false);
    expect(wantsName(claude, { prompts: 1, replies: 0 }, undefined, now)).toBe(false);
    expect(wantsName(claude, { prompts: 0, replies: 1 }, undefined, now)).toBe(false);
  });

  test("not one you named with /rename", () => {
    expect(wantsName(claude, sum, undefined, now, { custom: "mine" })).toBe(false);
  });

  test("again after 3 more prompts and 20 minutes, both", () => {
    const had = { name: "X", at: now - 20 * MIN, prompts: 2 };
    expect(wantsName(claude, { prompts: 5, replies: 4 }, had, now)).toBe(true);
    expect(wantsName(claude, { prompts: 4, replies: 4 }, had, now)).toBe(false);
    expect(wantsName(claude, { prompts: 9, replies: 9 }, { ...had, at: now - 19 * MIN }, now)).toBe(false);
  });

  test("a failed try waits 10 minutes", () => {
    expect(wantsName(claude, sum, undefined, now, { failedAt: now - 9 * MIN })).toBe(false);
    expect(wantsName(claude, sum, undefined, now, { failedAt: now - 10 * MIN })).toBe(true);
  });
});

describe("namingPrompt", () => {
  const sum = (): Summary => ({ scan: { offset: 0, dir: "", tools: new Map() }, prompts: 0, replies: 0, last: [] });

  test("title, first request, the last 3, the last reply; tool calls don't count", () => {
    const s = sum();
    let i = 0;
    const m = (role: "user" | "assistant", text: string) => addMessage(s, { id: String(i++), at: 0, role, text });
    m("user", "set up the repo");
    m("assistant", "done");
    addMessage(s, { id: "t", at: 0, role: "tool", name: "Bash", summary: "Ran `ls`", input: "ls SECRET-TOOL-INPUT", output: "SECRET-TOOL-OUTPUT" });
    for (const t of ["two", "three", "four"]) m("user", t);
    m("assistant", "the\nlatest   reply");
    expect([s.prompts, s.replies]).toEqual([4, 2]);
    const p = namingPrompt({ title: "Repo setup", ...s });
    expect(p).toContain("2 to 4 words, in Title Case");
    expect(p).toContain("Its title so far: Repo setup\nFirst request: set up the repo\nLatest requests, oldest first:\n- two\n- three\n- four\nClaude's latest reply: the latest reply\n");
    expect(p).not.toContain("SECRET");
  });

  test("each piece cut to about 300 characters; the first request not twice", () => {
    const p = namingPrompt({ first: "a", last: ["a", "b".repeat(1000)], prompts: 2, reply: "c".repeat(1000) });
    expect(p).not.toContain("First request");
    expect(p).toContain(`- ${"b".repeat(300)}…\n`);
    expect(p).toContain(`reply: ${"c".repeat(300)}…\n`);
    expect(p).not.toContain("b".repeat(301));
  });
});

describe("checkName", () => {
  test("quotes and trailing punctuation off", () => {
    expect(checkName("Mobile App Fixes\n")).toBe("Mobile App Fixes");
    expect(checkName('"Cost Optimization Work."')).toBe("Cost Optimization Work");
    expect(checkName("“Slack Thread Options”!")).toBe("Slack Thread Options");
    expect(checkName("**Repo Pen Test**")).toBe("Repo Pen Test");
    expect(checkName("Pen")).toBe("Pen");
  });

  test("anything else is ignored", () => {
    expect(checkName("")).toBeUndefined();
    expect(checkName("  \n")).toBeUndefined();
    expect(checkName("Here is a name:\nMobile App Fixes")).toBeUndefined();
    expect(checkName("Here is a name: Fixing The Mobile App Login Flow")).toBeUndefined(); // over 40
    expect(checkName("One Two Three Four Five Six Seven")).toBeUndefined(); // 7 words
    expect(checkName("Bell\x07 Name")).toBeUndefined();
    expect(checkName('"..."')).toBeUndefined();
  });
});

test("the model's arguments: haiku, no tools, nothing saved, no hooks, no MCPs", () => {
  expect(NAMING_ARGS.join(" ")).toBe('claude -p --model haiku --no-session-persistence --strict-mcp-config --tools  --max-turns 1 --settings {"disableAllHooks":true}');
});

describe("title order", () => {
  const line = (o: object) => JSON.stringify(o) + "\n";
  const prompt = line({ type: "user", message: { role: "user", content: "fix the login bug" } });

  test("your /rename, then blimp's name, then Claude's AI title, then the first prompt", () => {
    const ai = line({ type: "ai-title", aiTitle: "AI name" });
    expect(titleFromTranscript(prompt + ai + line({ type: "custom-title", customTitle: "mine" }), "Blimp Name")).toBe("mine");
    expect(titleFromTranscript(prompt + ai, "Blimp Name")).toBe("Blimp Name");
    expect(titleFromTranscript(prompt + ai)).toBe("AI name");
    expect(titleFromTranscript(prompt)).toBe("fix the login bug");
  });

  test("the session list and the Earlier list use the stored name", () => {
    const home = mkdtempSync(join(tmpdir(), "blimp-names-"));
    const cwd = join(home, "work");
    mkdirSync(cwd);
    const proj = join(home, "projects", projectFolderName(cwd));
    mkdirSync(proj, { recursive: true });
    mkdirSync(join(home, "sessions"));
    writeFileSync(join(proj, "s1.jsonl"), prompt + line({ type: "ai-title", aiTitle: "AI name" }));
    writeFileSync(join(proj, "s2.jsonl"), prompt);
    writeFileSync(join(home, "sessions", "42.json"), JSON.stringify({ sessionId: "s1", cwd, status: "idle" }));
    const names = { s1: { name: "Login Bug Fix", at: 1, prompts: 1 } };
    const zmxOut = `  name=w-1\tpid=42\tclients=0\tcreated=5\tcwd=${cwd}`;
    expect(listSessions(home, zmxOut, join(home, "status"), join(home, "memo.json"), names)[0].title).toBe("Login Bug Fix");
    expect(listSessions(home, zmxOut, join(home, "status"), join(home, "memo.json"), {})[0].title).toBe("AI name");
    const titles = Object.fromEntries(conversations(cwd, home, names).map((c) => [c.sessionId, c.title]));
    expect(titles).toEqual({ s1: "Login Bug Fix", s2: "fix the login bug" });
    rmSync(home, { recursive: true, force: true });
  });
});

describe("names.json and config.json", () => {
  test("600, through a temp file, the 500 newest kept", () => {
    const dir = mkdtempSync(join(tmpdir(), "blimp-names-"));
    const file = join(dir, "names.json");
    for (let i = 0; i < 503; i++) saveName(`s${i}`, { name: `N ${i}`, at: 1000 + i, prompts: 1 }, file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const all = readNames(file);
    expect(Object.keys(all).length).toBe(500);
    expect(all.s0).toBeUndefined();
    expect(all.s502).toEqual({ name: "N 502", at: 1502, prompts: 1 });
    writeFileSync(file, "{ not json");
    expect(readNames(file)).toEqual({});
    rmSync(dir, { recursive: true, force: true });
  });

  test('on unless config.json says "names": false', () => {
    const dir = mkdtempSync(join(tmpdir(), "blimp-names-"));
    const file = join(dir, "config.json");
    expect(namesOn(file)).toBe(true);
    writeFileSync(file, JSON.stringify({ names: false }));
    expect(namesOn(file)).toBe(false);
    writeFileSync(file, JSON.stringify({ names: true, other: 1 }));
    expect(namesOn(file)).toBe(true);
    writeFileSync(file, "nope");
    expect(namesOn(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("nope");
    rmSync(dir, { recursive: true, force: true });
  });
});
