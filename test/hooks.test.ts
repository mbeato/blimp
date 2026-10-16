import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installHooks, writeHookStatus } from "../src/hooks";

const tmp = mkdtempSync(join(tmpdir(), "blimp-hooks-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("installHooks", () => {
  test("merges into existing settings, backs up once, and a second run changes nothing", () => {
    const dir = join(tmp, "claude");
    const settings = join(dir, "settings.json");
    const original = {
      model: "opus",
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "say done" }] }],
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "check" }] }],
      },
    };
    mkdirSync(dir);
    writeFileSync(settings, JSON.stringify(original), { mode: 0o600 });

    expect(installHooks("/opt/it's/blimpd", settings)).toEqual(["Notification", "Stop", "UserPromptSubmit", "PostToolUse"]);
    const s = JSON.parse(readFileSync(settings, "utf8"));
    const ours = { hooks: [{ type: "command", command: `'/opt/it'\\''s/blimpd' hook`, timeout: 5 }] };
    expect(s.model).toBe("opus");
    expect(s.hooks.PreToolUse).toEqual(original.hooks.PreToolUse);
    expect(s.hooks.Stop).toEqual([original.hooks.Stop[0], ours]);
    expect(s.hooks.Notification).toEqual([ours]);
    expect(statSync(settings).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(settings + ".blimp-backup", "utf8"))).toEqual(original);

    const after = readFileSync(settings, "utf8");
    expect(installHooks("/opt/it's/blimpd", settings)).toEqual([]);
    expect(readFileSync(settings, "utf8")).toBe(after);

    // A later change (another event missing) keeps the first backup, not the in-between file.
    const s2 = JSON.parse(after);
    delete s2.hooks.PostToolUse;
    writeFileSync(settings, JSON.stringify(s2));
    expect(installHooks("/usr/bin/blimpd", settings)).toEqual(["PostToolUse"]);
    expect(JSON.parse(readFileSync(settings + ".blimp-backup", "utf8"))).toEqual(original);
    expect(readdirSync(dir).sort()).toEqual(["settings.json", "settings.json.blimp-backup"]); // no temp files left
  });

  test("an older-style unquoted `blimpd hook` counts as installed", () => {
    const settings = join(tmp, "plain.json");
    const hook = { hooks: [{ type: "command", command: "/home/u/.local/bin/blimpd hook" }] };
    writeFileSync(settings, JSON.stringify({ hooks: { Notification: [hook] } }));
    expect(installHooks("/x/blimpd", settings)).toEqual(["Stop", "UserPromptSubmit", "PostToolUse"]);
  });

  test("idempotent even when the binary isn't called blimpd", () => {
    const settings = join(tmp, "renamed.json");
    expect(installHooks("/x/dist/blimpd-linux-x64", settings)).toHaveLength(4);
    expect(installHooks("/x/dist/blimpd-linux-x64", settings)).toEqual([]);
  });

  test("no settings.json yet: creates it, nothing to back up", () => {
    const settings = join(tmp, "fresh", "settings.json");
    expect(installHooks("/x/blimpd", settings)).toHaveLength(4);
    expect(existsSync(settings + ".blimp-backup")).toBe(false);
  });

  test("a symlinked settings.json stays a link and its target gets the hooks", () => {
    // Dotfiles managers link ~/.claude/settings.json into a repo.
    mkdirSync(join(tmp, "dotfiles"));
    mkdirSync(join(tmp, "linked"));
    writeFileSync(join(tmp, "dotfiles", "s.json"), JSON.stringify({ a: 1 }));
    const settings = join(tmp, "linked", "settings.json");
    symlinkSync("../dotfiles/s.json", settings);
    expect(installHooks("/x/blimpd", settings)).toHaveLength(4);
    expect(lstatSync(settings).isSymbolicLink()).toBe(true);
    const s = JSON.parse(readFileSync(join(tmp, "dotfiles", "s.json"), "utf8"));
    expect(s.a).toBe(1);
    expect(Object.keys(s.hooks)).toHaveLength(4);
    expect(readdirSync(join(tmp, "dotfiles"))).toEqual(["s.json"]); // no temp files left
  });

  test("refuses to overwrite settings it can't read", () => {
    const settings = join(tmp, "broken.json");
    writeFileSync(settings, "{ not json");
    expect(() => installHooks("/x/blimpd", settings)).toThrow();
    expect(readFileSync(settings, "utf8")).toBe("{ not json");
  });
});

describe("writeHookStatus", () => {
  const dir = join(tmp, "status");
  const ev = (name: string, notification_type = "permission_prompt") =>
    JSON.stringify({ hook_event_name: name, session_id: "abc", notification_type });
  const read = (n: string) => JSON.parse(readFileSync(join(dir, `${n}.json`), "utf8"));

  test("maps hook events to states", () => {
    for (const [event, state] of [
      ["Notification", "waiting"],
      ["UserPromptSubmit", "working"],
      ["PostToolUse", "working"],
      ["Stop", "done"],
    ]) {
      const before = Date.now();
      writeHookStatus(ev(event), "web-1", dir);
      const s = read("web-1");
      expect(s).toMatchObject({ state, sessionId: "abc", event });
      expect(s.at).toBeGreaterThanOrEqual(before);
    }
  });

  test("only notifications that need an answer mean waiting", () => {
    writeHookStatus(ev("Stop"), "web-3", dir);
    // idle_prompt comes about 60 s after a finished turn; it must not turn done into waiting.
    for (const type of ["idle_prompt", "auth_success", "agent_completed"]) writeHookStatus(ev("Notification", type), "web-3", dir);
    writeHookStatus(JSON.stringify({ hook_event_name: "Notification", session_id: "abc" }), "web-3", dir);
    expect(read("web-3").state).toBe("done");
    for (const type of ["permission_prompt", "elicitation_dialog", "elicitation_url_dialog"]) {
      writeHookStatus(ev("Stop"), "web-3", dir);
      writeHookStatus(ev("Notification", type), "web-3", dir);
      expect(read("web-3").state).toBe("waiting");
    }
  });

  test("ignores unknown events, bad JSON, and no ZMX_SESSION", () => {
    writeHookStatus(ev("SessionStart"), "other", dir);
    writeHookStatus("nope", "other", dir);
    writeHookStatus(ev("Stop"), undefined, dir);
    expect(existsSync(join(dir, "other.json"))).toBe(false);
  });

  test("a session name can't write outside the status folder", () => {
    for (const bad of ["../../x", "../escape", "a/b", "..", ".", ""]) writeHookStatus(ev("Stop"), bad, dir);
    expect(existsSync(join(tmp, "x.json"))).toBe(false);
    expect(existsSync(join(tmp, "escape.json"))).toBe(false);
    expect(readdirSync(dir).sort()).toEqual(["web-1.json", "web-3.json"]);
  });
});

describe("`blimpd hook`", () => {
  const run = (stdin: string, session: string) =>
    Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "main.ts"), "hook"], {
      stdin: new TextEncoder().encode(stdin),
      env: { ...process.env, ZMX_SESSION: session, BLIMPD_SOCKET: join(tmp, "s", "blimpd.sock") },
    });

  test("writes <socket dir>/status/<session>.json and prints nothing", () => {
    const r = run(JSON.stringify({ hook_event_name: "Notification", notification_type: "permission_prompt", session_id: "abc" }), "web-2");
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString() + r.stderr.toString()).toBe("");
    expect(JSON.parse(readFileSync(join(tmp, "s", "status", "web-2.json"), "utf8")).state).toBe("waiting");
  });

  test("exits 0 quietly with garbage on stdin and a hostile session name", () => {
    const r = run("garbage", "../../x");
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString() + r.stderr.toString()).toBe("");
  });
});
