import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Handoff, handoffLinks, handoffText, handoffTick, namedFile, readHandoffs, replyEvent, saveHandoffs } from "../src/handoff";

const T0 = Date.parse("2026-10-21T10:00:00Z");
const line = (o: object) => JSON.stringify(o) + "\n";
const asked = (text = handoffText(new Date(T0))) => line({ type: "user", timestamp: new Date(T0 + 1000).toISOString(), message: { role: "user", content: text } });
const said = (text: string, extra: object = {}) =>
  line({ type: "assistant", timestamp: new Date(T0 + 2000).toISOString(), message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text }] }, ...extra });

describe("handoffText", () => {
  test("asks for the handoff under today's notes folder and only its path back", () => {
    const t = handoffText(new Date(2026, 9, 21, 23, 30));
    expect(t).toContain("Save it as notes/2026-10-21/HANDOFF-<short-slug>.md in this folder");
    expect(t).toStartWith("Write a handoff so a fresh session can continue this work: what the goal is, what's done, what's left");
    expect(t).toEndWith("Then reply with only the file's path.");
    expect(t).not.toContain("\n");
  });
});

describe("namedFile", () => {
  const dir = mkdtempSync(join(tmpdir(), "blimp-handoff-"));
  mkdirSync(join(dir, "notes", "2026-10-21"), { recursive: true });
  const fresh = join(dir, "notes", "2026-10-21", "HANDOFF-login.md");
  writeFileSync(fresh, "# handoff\n");
  const old = join(dir, "README.md");
  writeFileSync(old, "readme\n");
  utimesSync(old, new Date(T0 - 3600_000), new Date(T0 - 3600_000));
  const since = statSync(fresh).mtimeMs - 500;

  test("a path relative to the session's folder, as Claude was asked to reply", () => {
    expect(namedFile("notes/2026-10-21/HANDOFF-login.md", [dir], since)).toBe(fresh);
  });

  test("an absolute path, in backticks, a Markdown link or after ./", () => {
    expect(namedFile(`Saved it to \`${fresh}\`.`, [dir], since)).toBe(fresh);
    expect(namedFile("[handoff](notes/2026-10-21/HANDOFF-login.md)", [dir], since)).toBe(fresh);
    expect(namedFile("./notes/2026-10-21/HANDOFF-login.md", [dir], since)).toBe(fresh);
    expect(namedFile(`file://${fresh}`, [dir], since)).toBe(fresh);
    expect(namedFile(`${fresh}, written.`, [dir], since)).toBe(fresh);
    expect(namedFile(`Read README.md,notes/2026-10-21/HANDOFF-login.md`, [dir], since)).toBe(fresh);
  });

  test("a file that isn't there, isn't Markdown, or was there before the handoff was asked for is not it", () => {
    expect(namedFile("notes/2026-10-21/HANDOFF-other.md", [dir], since)).toBeUndefined();
    expect(namedFile("notes/2026-10-21", [dir], since)).toBeUndefined();
    expect(namedFile("Updated README.md", [dir], since)).toBeUndefined();
    expect(namedFile("notes/2026-10-21/HANDOFF-login.mdx", [dir], since)).toBeUndefined();
  });

  test("the last one that matches wins, and the next folder is tried when the first has none", () => {
    const other = mkdtempSync(join(tmpdir(), "blimp-handoff-"));
    const second = join(other, "HANDOFF-b.md");
    writeFileSync(second, "b\n");
    expect(namedFile(`Read README.md, then wrote notes/2026-10-21/HANDOFF-login.md and ${second}`, [dir], since)).toBe(second);
    expect(namedFile("HANDOFF-b.md", [dir, other], since)).toBe(second);
  });
});

describe("replyEvent", () => {
  test("the handoff request reaching Claude, typed or queued while it worked", () => {
    expect(replyEvent(asked())).toEqual({ asked: true });
    const queued = line({ type: "attachment", attachment: { type: "queued_command", prompt: handoffText(new Date(T0)) } });
    expect(replyEvent(queued)).toEqual({ asked: true });
    // Only typed in, not given to Claude yet.
    expect(replyEvent(line({ type: "queue-operation", operation: "enqueue", content: handoffText(new Date(T0)) }))).toBeUndefined();
  });

  test("a main-thread reply with text, with the folder Claude was in", () => {
    expect(replyEvent(said("notes/x.md", { cwd: "/w" }))).toEqual({ reply: "notes/x.md", cwd: "/w" });
    expect(replyEvent(said("notes/x.md", { isSidechain: true }))).toBeUndefined();
    expect(replyEvent(line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: {} }] } }))).toBeUndefined();
    expect(replyEvent(line({ type: "user", message: { content: "hello" } }))).toBeUndefined();
    expect(replyEvent("not json")).toBeUndefined();
  });
});

describe("handoffs.json", () => {
  const rec = (o: Partial<Handoff>): Handoff => ({ state: "writing", at: T0, dir: "/w", kind: "claude", transcript: "/t.jsonl", offset: 0, ...o });

  test("written 600, pruned to links with a live session and to the last 7 days", () => {
    const file = join(mkdtempSync(join(tmpdir(), "blimp-handoff-")), "handoffs.json");
    const now = T0 + 8 * 86400_000;
    saveHandoffs({ a: rec({ at: now - 1000 }), b: rec({ at: now - 1000, state: "started", child: "c" }), d: rec({ at: now - 1000 }), old: rec({ at: T0 }) }, ["a", "c", "old"], now, file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // b's parent ended but its child c is live; d has neither; old is over 7 days old.
    expect(Object.keys(readHandoffs(file)).sort()).toEqual(["a", "b"]);
    // An empty live list is more likely a zmx list that failed: nothing goes for that.
    saveHandoffs(readHandoffs(file), [], now, file);
    expect(Object.keys(readHandoffs(file)).sort()).toEqual(["a", "b"]);
  });

  test("a missing or broken file is no handoffs", () => {
    const dir = mkdtempSync(join(tmpdir(), "blimp-handoff-"));
    expect(readHandoffs(join(dir, "none.json"))).toEqual({});
    writeFileSync(join(dir, "bad.json"), "{nope");
    expect(readHandoffs(join(dir, "bad.json"))).toEqual({});
  });

  test("the parent gets the handoff's state, child, file and error; the child its parent", () => {
    const all = { p: rec({ state: "started", child: "k", file: "/w/h.md" }), q: rec({ state: "failed", error: "No handoff file came back" }) };
    expect(handoffLinks(all, "p")).toEqual({ handoff: { state: "started", child: "k", file: "/w/h.md" } });
    expect(handoffLinks(all, "k")).toEqual({ parent: "p" });
    expect(handoffLinks(all, "q")).toEqual({ handoff: { state: "failed", error: "No handoff file came back" } });
    expect(handoffLinks(all, "z")).toEqual({});
  });
});

describe("handoffTick", () => {
  function setup(lines: string[] = []) {
    const dir = mkdtempSync(join(tmpdir(), "blimp-handoff-"));
    const transcript = join(dir, "t.jsonl");
    writeFileSync(transcript, line({ type: "assistant", message: { content: [{ type: "text", text: "an older reply naming HANDOFF-a.md" }] } }));
    const offset = statSync(transcript).size;
    appendFileSync(transcript, lines.join(""));
    const file = join(dir, "handoffs.json");
    const starts: [string, string, string][] = [];
    const deps = (now: number, live = ["p"]) => ({
      now: () => now,
      live: async () => live,
      start: async (d: string, kind: string, prompt: string) => (starts.push([d, kind, prompt]), "p-child"),
    });
    const at = statSync(transcript).mtimeMs - 1000;
    saveHandoffs({ p: { state: "writing", at, dir, kind: "claude-glm", transcript, offset } }, ["p"], at, file);
    return { dir, transcript, file, starts, deps, at };
  }

  test("once Claude replies with the file it wrote, a new session of the same kind starts in the folder, told to read it", async () => {
    const { dir, transcript, file, starts, deps, at } = setup();
    await handoffTick(deps(at + 1000), file);
    expect(readHandoffs(file).p.state).toBe("writing");
    mkdirSync(join(dir, "notes"));
    writeFileSync(join(dir, "notes", "HANDOFF-a.md"), "# a\n");
    // A reply from before the request reached Claude doesn't count, even naming the file.
    appendFileSync(transcript, said("notes/HANDOFF-a.md"));
    await handoffTick(deps(at + 2000), file);
    expect(starts).toEqual([]);
    appendFileSync(transcript, asked() + said("Writing it now.") + said("notes/HANDOFF-a.md"));
    await handoffTick(deps(at + 3000), file);
    expect(starts).toEqual([[dir, "claude-glm", "Read notes/HANDOFF-a.md and do it"]]);
    expect(handoffLinks(readHandoffs(file), "p")).toEqual({ handoff: { state: "started", child: "p-child", file: join(dir, "notes", "HANDOFF-a.md") } });
    // Started once.
    await handoffTick(deps(at + 4000), file);
    expect(starts.length).toBe(1);
  });

  test("a file outside the session's folder is given to the new session by its full path", async () => {
    const { transcript, file, starts, deps, at } = setup();
    const elsewhere = join(mkdtempSync(join(tmpdir(), "blimp-handoff-")), "HANDOFF-b.md");
    writeFileSync(elsewhere, "b\n");
    appendFileSync(transcript, asked() + said(elsewhere));
    await handoffTick(deps(at + 1000), file);
    expect(starts[0][2]).toBe(`Read ${elsewhere} and do it`);
  });

  test("no file after 20 minutes: failed, saying why; a session that ended takes its handoff with it", async () => {
    const a = setup();
    await handoffTick(a.deps(a.at + 20 * 60_000 + 1), a.file);
    expect(handoffLinks(readHandoffs(a.file), "p")).toEqual({ handoff: { state: "failed", error: "No handoff file came back" } });
    const b = setup();
    await handoffTick(b.deps(b.at + 1000, ["other"]), b.file);
    expect(readHandoffs(b.file)).toEqual({});
  });

  test("a new session that can't start: failed, with the reason", async () => {
    const { dir, transcript, file, deps, at } = setup();
    writeFileSync(join(dir, "HANDOFF-c.md"), "c\n");
    appendFileSync(transcript, asked() + said("HANDOFF-c.md"));
    await handoffTick({ ...deps(at + 1000), start: async () => { throw new Error("Claude Code on GLM can't start here: no Z.ai key"); } }, file);
    expect(handoffLinks(readHandoffs(file), "p").handoff).toEqual({ state: "failed", file: join(dir, "HANDOFF-c.md"), error: "Claude Code on GLM can't start here: no Z.ai key" });
  });
});
