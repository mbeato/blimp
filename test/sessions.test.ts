import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatList, newSessionName, parseZmxList, titleFromTranscript } from "../src/sessions";

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

test("listSessions joins zmx with Claude's session file and transcript", async () => {
  const home = mkdtempSync(join(tmpdir(), "blimp-"));
  mkdirSync(join(home, "sessions"));
  mkdirSync(join(home, "projects", "-home-u-web"), { recursive: true });
  writeFileSync(
    join(home, "sessions", "42.json"),
    JSON.stringify({ sessionId: "s1", cwd: "/home/u/web/src", status: "busy", updatedAt: 123 }),
  );
  writeFileSync(join(home, "projects", "-home-u-web", "s1.jsonl"), JSON.stringify({ type: "ai-title", aiTitle: "Web work" }));
  const { listSessions } = await import("../src/sessions");
  const zmxOut = "  name=web-1\tpid=42\tclients=1\tcreated=5\tcwd=/home/u/web\tcmd=claude\n  name=sh-2\tpid=43\tclients=0\tcreated=6\tcwd=/tmp\tcmd=";
  expect(listSessions(home, zmxOut)).toEqual([
    { name: "web-1", pid: 42, clients: 1, created: 5, dir: "/home/u/web/src", cmd: "claude", sessionId: "s1", title: "Web work", status: "busy", waitingFor: undefined, updatedAt: 123 },
    { name: "sh-2", pid: 43, clients: 0, created: 6, dir: "/tmp", cmd: "", sessionId: undefined, title: "(new session)", status: "", waitingFor: undefined, updatedAt: undefined },
  ]);
});
