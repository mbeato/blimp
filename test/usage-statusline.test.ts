// The status line step (src/usage/statusline.ts): saving Claude's limit numbers, putting blimpd in front
// of the user's own status line and back, and `blimpd statusline` end to end. Temp folders only: never the
// real ~/.claude/settings.json or ~/.blimp.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installStatusline, limitsDir, readLimits, saveLimits, statuslineInstalled, uninstallStatusline } from "../src/usage/statusline";

const root = mkdtempSync(join(tmpdir(), "blimp-statusline-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = () => {
  const d = join(root, `t${++n}`);
  mkdirSync(d, { recursive: true });
  return { usage: join(d, "usage"), accounts: join(d, "accounts"), settings: join(d, "claude", "settings.json"), dir: d };
};
const mode = (p: string) => statSync(p).mode & 0o777;
const NOW = 1_795_000_000_000;
const input = (extra: object = {}) => ({
  session_id: "s1",
  rate_limits: { five_hour: { used_percentage: 62, resets_at: 1_795_010_000 }, seven_day: { used_percentage: 21, resets_at: 1_795_400_000 } },
  ...extra,
});
const state = (accounts: string, s: object) => {
  mkdirSync(accounts, { recursive: true });
  writeFileSync(join(accounts, "state.json"), JSON.stringify({ order: [], out: {}, ...s }));
};

describe("saveLimits", () => {
  test("saves both windows, in ms, under the account in use: 600 in 700 folders", () => {
    const d = fresh();
    state(d.accounts, { active: "A" });
    expect(saveLimits(input(), { ...d, now: NOW })).toBe(true);
    const file = join(limitsDir(d.usage), "A.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ at: NOW, fiveHour: { used: 62, resetsAt: 1_795_010_000_000 }, sevenDay: { used: 21, resetsAt: 1_795_400_000_000 } });
    expect(mode(file)).toBe(0o600);
    expect(mode(d.usage)).toBe(0o700);
    expect(mode(limitsDir(d.usage))).toBe(0o700);
    expect(readLimits(d.usage)).toEqual({ A: { at: NOW, fiveHour: { used: 62, resetsAt: 1_795_010_000_000 }, sevenDay: { used: 21, resetsAt: 1_795_400_000_000 } } });
  });

  test("logins are saved but none is known to be in place: nothing is saved", () => {
    const d = fresh();
    state(d.accounts, { order: ["A", "B"] });
    expect(saveLimits(input(), { ...d, now: NOW })).toBe(false);
    expect(readLimits(d.usage)).toEqual({});
  });

  test("with no accounts state, under one; a window without numbers is left out", () => {
    const d = fresh();
    expect(saveLimits(input({ rate_limits: { five_hour: { used_percentage: 5, resets_at: 10 }, seven_day: { used_percentage: "x" } } }), { ...d, now: NOW })).toBe(true);
    expect(readLimits(d.usage)).toEqual({ one: { at: NOW, fiveHour: { used: 5, resetsAt: 10_000 } } });
  });

  test("nothing is saved without rate_limits, or with neither window", () => {
    const d = fresh();
    expect(saveLimits({ session_id: "s1" }, d)).toBe(false);
    expect(saveLimits(input({ rate_limits: "full" }), d)).toBe(false);
    expect(saveLimits(input({ rate_limits: {} }), d)).toBe(false);
    expect(saveLimits(null, d)).toBe(false);
    expect(existsSync(limitsDir(d.usage))).toBe(false);
  });

  describe("after a swap, only a session with a real reply since", () => {
    const SWITCHED = Date.parse("2026-11-20T10:00:00.000Z");
    const iso = (ms: number) => new Date(ms).toISOString();
    const reply = (ms: number) =>
      JSON.stringify({ type: "assistant", timestamp: iso(ms), isSidechain: false, message: { model: "claude-fable-5-2", id: `m${ms}`, usage: { input_tokens: 1, output_tokens: 1 } } });
    const apiError = (ms: number) =>
      JSON.stringify({ type: "assistant", isApiErrorMessage: true, timestamp: iso(ms), message: { model: "<synthetic>", id: `e${ms}`, usage: { input_tokens: 0, output_tokens: 0 } } });
    const user = (ms: number, text = "carry on") => JSON.stringify({ type: "user", timestamp: iso(ms), message: { role: "user", content: text } });
    const swapped = (lines: string[] | null) => {
      const d = fresh();
      state(d.accounts, { active: "B", switchedAt: SWITCHED });
      const transcript = join(d.dir, "t.jsonl");
      if (lines) writeFileSync(transcript, lines.join("\n") + "\n");
      return { d, transcript };
    };

    test("only replies dated before the swap: not saved", () => {
      const { d, transcript } = swapped([user(SWITCHED - 120_000), reply(SWITCHED - 60_000)]);
      expect(saveLimits(input({ transcript_path: transcript }), d)).toBe(false);
      expect(readLimits(d.usage)).toEqual({});
    });

    test("a reply before, then a rate-limit error and blimp's carry-on after (the live bug): not saved", () => {
      // Both lines after the swap make the file newer than switchedAt; neither is an answer on the new account.
      const { d, transcript } = swapped([reply(SWITCHED - 60_000), apiError(SWITCHED + 1000), user(SWITCHED + 5000)]);
      expect(saveLimits(input({ transcript_path: transcript }), d)).toBe(false);
      expect(existsSync(join(limitsDir(d.usage), "B.json"))).toBe(false);
      expect(readLimits(d.usage)).toEqual({});
    });

    test("a real reply dated after the swap: saved under the active account", () => {
      const { d, transcript } = swapped([reply(SWITCHED - 60_000), apiError(SWITCHED + 1000), user(SWITCHED + 5000), reply(SWITCHED + 9000)]);
      expect(saveLimits(input({ transcript_path: transcript }), d)).toBe(true);
      expect(Object.keys(readLimits(d.usage))).toEqual(["B"]);
    });

    test("no transcript on disk: not saved", () => {
      const { d, transcript } = swapped(null);
      expect(saveLimits(input({ transcript_path: transcript }), d)).toBe(false);
      expect(readLimits(d.usage)).toEqual({});
    });

    test("a transcript larger than the tail read, its first tail line cut mid-object, a reply after the swap near the end: saved", () => {
      // One 300 KB line before the reply: the last 256 KB starts inside it.
      const big = user(SWITCHED - 120_000, "x".repeat(300 * 1024));
      const { d, transcript } = swapped([reply(SWITCHED - 200_000), big, user(SWITCHED + 5000), reply(SWITCHED + 9000), user(SWITCHED + 10_000)]);
      const bytes = readFileSync(transcript);
      expect(bytes.length).toBeGreaterThan(300 * 1024);
      expect(String.fromCharCode(bytes[bytes.length - 256 * 1024 - 1])).toBe("x");
      expect(saveLimits(input({ transcript_path: transcript }), d)).toBe(true);
      expect(Object.keys(readLimits(d.usage))).toEqual(["B"]);
    });

    test("the only reply after the swap starts exactly where the tail does: it is a whole line, saved", () => {
      const TAIL = 256 * 1024;
      const r = reply(SWITCHED + 9000);
      const pad = user(SWITCHED + 10_000, "x".repeat(TAIL - r.length - 2 - user(SWITCHED + 10_000, "").length));
      const { d, transcript } = swapped([user(SWITCHED - 120_000), r, pad]);
      const bytes = readFileSync(transcript);
      expect(bytes.subarray(bytes.length - TAIL, bytes.length - TAIL + r.length).toString()).toBe(r);
      expect(saveLimits(input({ transcript_path: transcript }), d)).toBe(true);
    });

    test("no switchedAt in state: saved without looking at the transcript", () => {
      const d = fresh();
      state(d.accounts, { active: "B" });
      expect(saveLimits(input({ transcript_path: join(d.dir, "gone.jsonl") }), d)).toBe(true);
      expect(Object.keys(readLimits(d.usage))).toEqual(["B"]);
    });
  });

  test("readLimits skips a broken file; no folder is none", () => {
    const d = fresh();
    expect(readLimits(d.usage)).toEqual({});
    saveLimits(input(), { ...d, now: NOW });
    writeFileSync(join(limitsDir(d.usage), "bad.json"), "{");
    writeFileSync(join(limitsDir(d.usage), "list.json"), "[1]");
    expect(Object.keys(readLimits(d.usage))).toEqual(["one"]);
  });
});

describe("install and uninstall", () => {
  const text = (o: unknown) => JSON.stringify(o, null, 2) + "\n";
  const BLIMPD = "/opt/it's/blimpd";
  const ours = `'/opt/it'\\''s/blimpd' statusline`;

  test("install keeps the user's status line (padding stays, the command is ours), and a second install changes nothing", () => {
    const d = fresh();
    const mine = { type: "command", command: "node ~/gsd-statusline.js", padding: 2 };
    mkdirSync(join(d.dir, "claude"));
    writeFileSync(d.settings, text({ model: "opus", statusLine: mine, hooks: {} }), { mode: 0o600 });
    expect(statuslineInstalled(d.settings)).toBe(false);
    expect(installStatusline(BLIMPD, d.settings, d.usage)).toBe(true);
    const s = JSON.parse(readFileSync(d.settings, "utf8"));
    expect(s).toEqual({ model: "opus", statusLine: { type: "command", command: ours, padding: 2 }, hooks: {} });
    expect(JSON.parse(readFileSync(join(d.usage, "statusline.json"), "utf8"))).toEqual({ statusLine: mine });
    expect(readFileSync(d.settings + ".blimp-backup", "utf8")).toBe(text({ model: "opus", statusLine: mine, hooks: {} }));
    expect(statuslineInstalled(d.settings)).toBe(true);
    const after = readFileSync(d.settings, "utf8");
    expect(installStatusline(BLIMPD, d.settings, d.usage)).toBe(false);
    expect(readFileSync(d.settings, "utf8")).toBe(after);
    expect(JSON.parse(readFileSync(join(d.usage, "statusline.json"), "utf8"))).toEqual({ statusLine: mine });
  });

  test("install then uninstall gives back the same bytes, with a status line of the user's and with none", () => {
    for (const before of [{ model: "opus", statusLine: { type: "command", command: "echo hi" }, theme: "dark" }, { model: "opus", theme: "dark" }]) {
      const d = fresh();
      mkdirSync(join(d.dir, "claude"));
      writeFileSync(d.settings, text(before), { mode: 0o600 });
      expect(installStatusline(BLIMPD, d.settings, d.usage)).toBe(true);
      expect(readFileSync(d.settings, "utf8")).not.toBe(text(before));
      expect(uninstallStatusline(d.settings, d.usage)).toBe(true);
      expect(readFileSync(d.settings, "utf8")).toBe(text(before));
      expect(mode(d.settings)).toBe(0o600);
      expect(existsSync(join(d.usage, "statusline.json"))).toBe(false);
      expect(statuslineInstalled(d.settings)).toBe(false);
      expect(uninstallStatusline(d.settings, d.usage)).toBe(false);
    }
  });

  test("statuslineInstalled: any blimpd's statusline; no file or bad JSON is not installed; bad JSON stops an install", () => {
    const d = fresh();
    expect(statuslineInstalled(d.settings)).toBe(false);
    mkdirSync(join(d.dir, "claude"));
    writeFileSync(d.settings, text({ statusLine: { type: "command", command: "/home/u/.local/bin/blimpd statusline" } }));
    expect(statuslineInstalled(d.settings)).toBe(true);
    expect(installStatusline(BLIMPD, d.settings, d.usage)).toBe(false);
    writeFileSync(d.settings, "{ not json");
    expect(statuslineInstalled(d.settings)).toBe(false);
    expect(() => installStatusline(BLIMPD, d.settings, d.usage)).toThrow();
    expect(readFileSync(d.settings, "utf8")).toBe("{ not json");
  });
});

describe("`blimpd statusline`", () => {
  // A blimpd pointed at a temp socket folder and a temp Claude folder, as `blimpd hook`'s tests do.
  const run = (dir: string, stdin: string) =>
    Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "src", "main.ts"), "statusline"], {
      stdin: new TextEncoder().encode(stdin),
      env: { ...process.env, BLIMPD_SOCKET: join(dir, "s", "blimpd.sock"), CLAUDE_CONFIG_DIR: join(dir, "claude") },
      stdout: "pipe",
      stderr: "pipe",
    });
  const kept = (dir: string, command: string) => {
    mkdirSync(join(dir, "s", "usage"), { recursive: true });
    writeFileSync(join(dir, "s", "usage", "statusline.json"), JSON.stringify({ statusLine: { type: "command", command } }));
  };

  test("saves the numbers, then runs the user's own command with the same stdin and prints what it prints", () => {
    const d = fresh();
    kept(d.dir, "cat");
    const stdin = JSON.stringify(input());
    const r = run(d.dir, stdin);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toBe(stdin);
    expect(JSON.parse(readFileSync(join(d.dir, "s", "usage", "limits", "one.json"), "utf8")).fiveHour).toEqual({ used: 62, resetsAt: 1_795_010_000_000 });
  });

  test("the user's command's exit code comes back; stdin that isn't JSON still reaches it", () => {
    const d = fresh();
    kept(d.dir, "cat; exit 3");
    const r = run(d.dir, "not json");
    expect(r.exitCode).toBe(3);
    expect(r.stdout.toString()).toBe("not json");
    expect(existsSync(join(d.dir, "s", "usage", "limits"))).toBe(false);
  });

  test("with no command of the user's it prints nothing; a kept command that is ours is not run", () => {
    const d = fresh();
    const none = run(d.dir, JSON.stringify(input()));
    expect(none.exitCode).toBe(0);
    expect(none.stdout.toString()).toBe("");
    kept(d.dir, "'/x/blimpd' statusline; echo looped");
    const loop = run(d.dir, "{}");
    expect(loop.exitCode).toBe(0);
    expect(loop.stdout.toString()).toBe("");
  });
});
