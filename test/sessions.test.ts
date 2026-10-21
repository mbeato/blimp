import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { appendFileSync, chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkZmxDir,
  deriveState,
  formatList,
  newSessionName,
  parseZmxList,
  rememberKind,
  titleFromTranscript,
  transcriptTitle,
  transcriptTitles,
  zmxDir,
} from "../src/sessions";

describe("zmx's socket folder", () => {
  test("found the way zmx finds it", () => {
    const uid = process.getuid!();
    expect(zmxDir({ ZMX_DIR: "/z", XDG_RUNTIME_DIR: "/run/user/1" })).toBe("/z");
    expect(zmxDir({ XDG_RUNTIME_DIR: "/run/user/1" })).toBe("/run/user/1/zmx");
    expect(zmxDir({ TMPDIR: "/var/t" })).toBe(`/var/t/zmx-${uid}`);
    expect(zmxDir({})).toBe(`/tmp/zmx-${uid}`);
  });

  test("made private when missing; refused when others can write it or it's a link", () => {
    const tmp = mkdtempSync(join(tmpdir(), "bz"));
    try {
      const dir = join(tmp, "zmx");
      checkZmxDir(dir);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      chmodSync(dir, 0o750); // zmx's own default
      checkZmxDir(dir);

      for (const mode of [0o777, 0o770, 0o702]) {
        chmodSync(dir, mode);
        expect(() => checkZmxDir(dir)).toThrow(`zmx's socket folder ${dir} is writable by others`);
      }
      chmodSync(dir, 0o700);
      symlinkSync(dir, join(tmp, "link"));
      expect(() => checkZmxDir(join(tmp, "link"))).toThrow("isn't a folder you own");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("parseZmxList", () => {
  test("reads zmx 0.5 and 0.8 lines, skips the current-session arrow", () => {
    const out = [
      "→ name=blimp-184227\tpid=209535\tclients=1\tcreated=1792168947\tstart_dir=/home/u/blimp\tcmd=claude",
      "  name=web-172635\tpid=62543\tclients=0\tcreated=1792164395\tcwd=/home/u/web\tcmd=claude --resume abc",
      "",
    ].join("\n");
    expect(parseZmxList(out)).toEqual([
      { name: "web-172635", pid: 62543, clients: 0, created: 1792164395, dir: "/home/u/web", cmd: "claude --resume abc" },
      { name: "blimp-184227", pid: 209535, clients: 1, created: 1792168947, dir: "/home/u/blimp", cmd: "claude" },
    ]);
  });

  test("zmx 0.8 can report the folder as a file:// URL", () => {
    const [s] = parseZmxList("  name=a\tpid=1\tclients=0\tcreated=1\tcwd=file://box/home/u/my%20app\tcmd=claude");
    expect(s.dir).toBe("/home/u/my app");
  });
});

describe("titleFromTranscript", () => {
  const line = (o: object) => JSON.stringify(o);
  const prompt = line({ type: "user", message: { role: "user", content: "fix   the\nlogin bug" } });

  test("custom title beats ai title, last one wins", () => {
    const t = [
      prompt,
      line({ type: "custom-title", customTitle: "old name" }),
      line({ type: "ai-title", aiTitle: "AI name" }),
      line({ type: "custom-title", customTitle: "my name" }),
      line({ type: "ai-title", aiTitle: "later AI name" }),
    ].join("\n");
    expect(titleFromTranscript(t)).toBe("my name");
  });

  test("last ai title when there is no custom title", () => {
    const t = [prompt, line({ type: "ai-title", aiTitle: "a" }), line({ type: "ai-title", aiTitle: "b" })].join("\n");
    expect(titleFromTranscript(t)).toBe("b");
  });

  test("falls back to the first plain prompt, whitespace collapsed", () => {
    const t = [
      line({ type: "user", message: { content: "<command-name>/clear</command-name>" } }),
      line({ type: "user", message: { content: [{ type: "text", text: "array content" }] } }),
      prompt,
      "not json",
    ].join("\n");
    expect(titleFromTranscript(t)).toBe("fix the login bug");
  });

  test("empty transcript", () => {
    expect(titleFromTranscript("")).toBe("(new session)");
  });
});

describe("newSessionName", () => {
  const at = new Date(2026, 9, 16, 9, 5, 7);

  test("folder-HHMMSS like claude1", () => {
    expect(newSessionName("/home/u/my.app", at, [])).toBe("my_app-090507");
  });

  test("-s NAME replaces the time", () => {
    expect(newSessionName("/home/u/web", at, [], "review")).toBe("web-review");
  });

  test("a custom name can't carry path characters", () => {
    expect(newSessionName("/home/u/web", at, [], "../../x")).toBe("web-______x");
  });

  test("never reuses a running name", () => {
    expect(newSessionName("/home/u/web", at, ["web-090507", "web-090507-2"])).toBe("web-090507-3");
  });
});

describe("formatList", () => {
  test("same columns as cc-pick", () => {
    const now = 1_800_000_000_000;
    const rows = [
      { name: "web-1", title: "x".repeat(70), status: "waiting", updatedAt: now - 5 * 60_000, dir: "/h/web" },
      { name: "api-2", title: "short", status: "idle", updatedAt: now - 3 * 3600_000, dir: "/srv/api" },
    ];
    expect(formatList(rows as any, now, "/h")).toBe(
      ` 1  ${"x".repeat(60)}  waiting        5m ago  web-1  ~/web\n` +
        ` 2  ${"short".padEnd(60)}  idle           3h ago  api-2  /srv/api`,
    );
  });
});

test("listSessions joins zmx with Claude's session file, transcript and blimp's hook file", async () => {
  const home = mkdtempSync(join(tmpdir(), "blimp-"));
  mkdirSync(join(home, "sessions"));
  mkdirSync(join(home, "status"));
  mkdirSync(join(home, "projects", "-home-u-web"), { recursive: true });
  writeFileSync(
    join(home, "sessions", "42.json"),
    JSON.stringify({ sessionId: "s1", cwd: "/home/u/web/src", status: "busy", updatedAt: 123 }),
  );
  writeFileSync(join(home, "projects", "-home-u-web", "s1.jsonl"), JSON.stringify({ type: "ai-title", aiTitle: "Web work" }));
  // sh-2 has no Claude status, only a hook file written after it started.
  writeFileSync(join(home, "status", "sh-2.json"), JSON.stringify({ state: "waiting", at: 7000, event: "Notification" }));
  const { listSessions } = await import("../src/sessions");
  const zmxOut = "  name=web-1\tpid=42\tclients=1\tcreated=5\tcwd=/home/u/web\tcmd=claude\n  name=sh-2\tpid=43\tclients=0\tcreated=6\tcwd=/tmp\tcmd=";
  expect(listSessions(home, zmxOut, join(home, "status"), undefined, {}, { since: 0, seen: {} })).toEqual([
    { name: "web-1", pid: 42, clients: 1, created: 5, kind: "claude", dir: "/home/u/web/src", cmd: "claude", sessionId: "s1", transcript: join(home, "projects", "-home-u-web", "s1.jsonl"), title: "Web work", status: "busy", waitingFor: undefined, updatedAt: 123, state: "working", stateSince: 123, unread: false },
    { name: "sh-2", pid: 43, clients: 0, created: 6, kind: "shell", dir: "/tmp", cmd: "", sessionId: undefined, title: "(new session)", status: "", waitingFor: undefined, updatedAt: undefined, state: "waiting", stateSince: 7000, unread: false },
  ]);
  // Claude's reply after what was seen: unread
  writeFileSync(join(home, "projects", "-home-u-web", "s1.jsonl"),
    JSON.stringify({ type: "assistant", timestamp: new Date(9000).toISOString(), message: { content: [{ type: "text", text: "done" }] } }) + "\n");
  const unread = (seen: Record<string, number>) => listSessions(home, zmxOut, join(home, "status"), undefined, {}, { since: 0, seen })[0].unread;
  expect(unread({})).toBe(true);
  expect(unread({ s1: 9000 })).toBe(false);
});

test("listSessions adds a Claude session's background jobs, context and git folder from its transcript, and not the files it edited", async () => {
  const real = (await import("./fixtures/activity-lines.json")).default as Record<string, string>;
  const home = mkdtempSync(join(tmpdir(), "blimp-"));
  mkdirSync(join(home, "sessions"));
  mkdirSync(join(home, "projects", "-home-u-web"), { recursive: true });
  writeFileSync(join(home, "sessions", "42.json"), JSON.stringify({ sessionId: "s1", cwd: "/home/u/web", status: "busy" }));
  writeFileSync(join(home, "projects", "-home-u-web", "s1.jsonl"), [real.failedCall, real.failedStarted, real.edit, real.workflowCall].join("\n") + "\n");
  writeFileSync(join(home, "sessions", "43.json"), JSON.stringify({ sessionId: "s2", cwd: "/home/u/web", status: "idle" }));
  writeFileSync(join(home, "projects", "-home-u-web", "s2.jsonl"), real.bashCall + "\n");
  const { listSessions } = await import("../src/sessions");
  const zmxOut = "  name=web-1\tpid=42\tclients=1\tcreated=5\tcwd=/home/u/web\tcmd=claude\n  name=web-2\tpid=43\tclients=0\tcreated=6\tcwd=/home/u/web\tcmd=claude";
  const memo = join(home, "session-kinds.json");
  writeFileSync(memo, JSON.stringify({ "web-1": "claude-glm" }));
  const [s, t] = listSessions(home, zmxOut, join(home, "status"), memo, {}, { since: 0, seen: {} });
  const started = Date.parse(JSON.parse(real.failedStarted).timestamp);
  expect(s.jobs).toEqual([
    { id: "b5bbkbpfm", kind: "bash", label: "Watch the phone run for the fix", startedAt: started, status: "running", outputFile: expect.stringMatching(/\/tasks\/b5bbkbpfm\.output$/) },
  ]);
  expect(s.context).toEqual({ used: 531 + 148928, limit: 1048576 }); // the workflow call, a GLM reply
  expect(s.git).toEqual({ cwd: "/Users/u/blimp" }); // no such folder here, so no branch
  expect(s).not.toHaveProperty("files");
  expect(t).not.toHaveProperty("jobs");
  expect(t.context).toEqual({ used: 2 + 791 + 91091, limit: 1_000_000 });
  // `blimpd sessions` without --json shows none of it, so it doesn't read it.
  const bare = listSessions(home, zmxOut, join(home, "status"), memo, {}, { since: 0, seen: {} }, {}, false)[0];
  for (const k of ["jobs", "context", "git"]) expect(bare).not.toHaveProperty(k);
  // Claude started again on this transcript (a resume): the job didn't survive the old process.
  writeFileSync(join(home, "sessions", "42.json"), JSON.stringify({ sessionId: "s1", cwd: "/home/u/web", status: "busy", startedAt: Date.now() - 1000 }));
  const [r] = listSessions(home, zmxOut, join(home, "status"), memo, {}, { since: 0, seen: {} });
  expect(r.jobs).toMatchObject([{ id: "b5bbkbpfm", status: "stopped" }]);
  expect(r.jobs![0].endedAt).toBeGreaterThan(started);
  rmSync(home, { recursive: true, force: true });
});

test("a session remembered as a shell that Claude now runs in is Claude Code", async () => {
  const home = mkdtempSync(join(tmpdir(), "blimp-"));
  mkdirSync(join(home, "sessions"));
  writeFileSync(join(home, "sessions", "50.json"), JSON.stringify({ sessionId: "s9", status: "idle" }));
  const memo = join(home, "session-kinds.json");
  writeFileSync(memo, JSON.stringify({ "sh-1": "shell", "sh-2": "shell", "cx-3": "codex" }));
  const { listSessions } = await import("../src/sessions");
  const zmxOut = "  name=sh-1\tpid=50\tclients=0\tcreated=5\tcwd=/tmp\n  name=sh-2\tpid=51\tclients=0\tcreated=6\tcwd=/tmp\n  name=cx-3\tpid=52\tclients=0\tcreated=7\tcwd=/tmp";
  expect(listSessions(home, zmxOut, join(home, "status"), memo).map((s) => s.kind)).toEqual(["claude", "shell", "codex"]);
  rmSync(home, { recursive: true, force: true });
});

test("rememberKind drops ended sessions, but nothing when zmx listed none (a failed list)", () => {
  const dir = mkdtempSync(join(tmpdir(), "blimp-"));
  const memo = join(dir, "session-kinds.json");
  writeFileSync(memo, JSON.stringify({ a: "codex", b: "shell" }));
  rememberKind("c", "claude-glm", [], memo);
  expect(JSON.parse(readFileSync(memo, "utf8"))).toEqual({ c: "claude-glm", a: "codex", b: "shell" });
  rememberKind("d", "claude", ["a", "c"], memo);
  expect(JSON.parse(readFileSync(memo, "utf8"))).toEqual({ d: "claude", a: "codex", c: "claude-glm" });
  rmSync(dir, { recursive: true, force: true });
});

describe("deriveState", () => {
  test("from Claude's status file", () => {
    expect(deriveState({ status: "busy", updatedAt: 5 }, {})).toEqual({ state: "working", stateSince: 5 });
    expect(deriveState({ status: "shell", updatedAt: 5, statusUpdatedAt: 4 }, {})).toEqual({ state: "working", stateSince: 4 });
    expect(deriveState({ status: "idle", updatedAt: 5 }, {})).toEqual({ state: "done", stateSince: 5 });
    expect(deriveState({ status: "waiting", updatedAt: 5 }, {})).toEqual({ state: "waiting", stateSince: 5 });
    expect(deriveState({ status: "busy", waitingFor: "permission", updatedAt: 5 }, {})).toEqual({ state: "waiting", stateSince: 5 });
  });

  test("the newer of Claude's file and the hook file wins", () => {
    const claude = { status: "idle", statusUpdatedAt: 2000 };
    expect(deriveState(claude, { state: "waiting", at: 3000 })).toEqual({ state: "waiting", stateSince: 3000 });
    expect(deriveState(claude, { state: "working", at: 1000 })).toEqual({ state: "done", stateSince: 2000 });
  });

  test("a hook file from before the session started is ignored", () => {
    expect(deriveState({}, { state: "waiting", at: 1000 }, 5)).toEqual({ state: "unknown" });
    expect(deriveState({}, { state: "waiting", at: 6000 }, 5)).toEqual({ state: "waiting", stateSince: 6000 });
  });

  test("nothing known", () => {
    expect(deriveState({}, {})).toEqual({ state: "unknown" });
    expect(deriveState({ status: "something-new" }, { state: "bogus", at: 1 })).toEqual({ state: "unknown" });
  });
});

describe("transcriptTitle (incremental)", () => {
  const dir = mkdtempSync(join(tmpdir(), "blimp-title-"));
  const line = (o: object) => JSON.stringify(o) + "\n";
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("reads only what was appended, and an unterminated last line counts", () => {
    const f = join(dir, "a.jsonl");
    writeFileSync(f, line({ type: "user", message: { content: "first prompt" } }));
    expect(transcriptTitle(f)).toBe("first prompt");

    appendFileSync(f, JSON.stringify({ type: "ai-title", aiTitle: "half" })); // no newline yet
    expect(transcriptTitle(f)).toBe("half");
    appendFileSync(f, "\n" + line({ type: "custom-title", customTitle: "mine" }));
    expect(transcriptTitle(f)).toBe("mine");

    // The cache remembers state: earlier lines aren't re-read, so changing them in place goes unseen,
    // while a later ai-title still loses to the custom title.
    appendFileSync(f, line({ type: "ai-title", aiTitle: "later ai" }));
    expect(transcriptTitle(f)).toBe("mine");
  });

  test("replied: when Claude last wrote text, not a tool call, a side task's or Claude Code's own note", () => {
    const f = join(dir, "r.jsonl");
    const at = (ms: number) => new Date(ms).toISOString();
    const text = (t: string) => [{ type: "text", text: t }];
    writeFileSync(f, line({ type: "assistant", timestamp: at(1000), message: { content: text("hi") } }));
    expect(transcriptTitles(f)?.replied).toBe(1000);
    appendFileSync(f, line({ type: "assistant", timestamp: at(2000), message: { content: [{ type: "tool_use", name: "Bash" }] } }));
    appendFileSync(f, line({ type: "assistant", timestamp: at(3000), isSidechain: true, message: { content: text("side") } }));
    appendFileSync(f, line({ type: "assistant", timestamp: at(4000), message: { model: "<synthetic>", content: text("No response requested.") } }));
    appendFileSync(f, line({ type: "assistant", timestamp: at(5000), message: { content: text("  ") } }));
    expect(transcriptTitles(f)?.replied).toBe(1000);
    appendFileSync(f, line({ type: "assistant", timestamp: at(6000), message: { content: [{ type: "tool_use" }, ...text("done")] } }));
    expect(transcriptTitles(f)?.replied).toBe(6000);
  });

  test("a file rewritten shorter is read again from the start", () => {
    const f = join(dir, "b.jsonl");
    writeFileSync(f, line({ type: "ai-title", aiTitle: "a long title for the first version" }));
    expect(transcriptTitle(f)).toBe("a long title for the first version");
    writeFileSync(f, line({ type: "ai-title", aiTitle: "short" }));
    expect(transcriptTitle(f)).toBe("short");
  });

  test("same answer as reading the whole file, for a real-looking transcript", () => {
    const f = join(dir, "c.jsonl");
    const big = "x".repeat(100_000);
    const text =
      line({ type: "user", message: { content: "<command-name>/clear</command-name>" } }) +
      line({ type: "user", message: { content: "fix   it" } }) +
      line({ type: "assistant", message: { content: big } }) +
      line({ type: "ai-title", aiTitle: "Fixing it" });
    writeFileSync(f, text.slice(0, 50_000));
    transcriptTitle(f);
    appendFileSync(f, text.slice(50_000));
    expect(transcriptTitle(f)).toBe(titleFromTranscript(text));
  });

  test("missing file", () => {
    expect(transcriptTitle(join(dir, "nope.jsonl"))).toBe("(new session)");
  });

  test("a line longer than a chunk is skipped without holding the rest of the file in memory", () => {
    const f = join(dir, "d.jsonl");
    const huge = line({ type: "assistant", message: { content: "y".repeat(40 << 20) } });
    writeFileSync(f, line({ type: "user", message: { content: "start" } }) + huge.slice(0, 20 << 20)); // still being written
    const alloc = spyOn(Buffer, "alloc");
    try {
      expect(transcriptTitle(f)).toBe("start");
      appendFileSync(f, huge.slice(20 << 20) + line({ type: "ai-title", aiTitle: "after the big one" }));
      expect(transcriptTitle(f)).toBe("after the big one");
      appendFileSync(f, huge + line({ type: "custom-title", customTitle: "renamed" }));
      expect(transcriptTitle(f)).toBe("renamed");
      expect(Math.max(...alloc.mock.calls.map((c) => c[0] as number))).toBeLessThanOrEqual(16 << 20);
    } finally {
      alloc.mockRestore();
    }
  });
});
