import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_HOOKS, installHooks, uninstallHooks, writeHookStatus } from "../src/hooks";

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

    expect(installHooks("/opt/it's/blimpd", settings)).toEqual(["Notification", "Stop", "UserPromptSubmit", "PostToolUse", "PermissionRequest", "PreToolUse", "Elicitation"]);
    const s = JSON.parse(readFileSync(settings, "utf8"));
    const ours = { hooks: [{ type: "command", command: `'/opt/it'\\''s/blimpd' hook`, timeout: 5 }] };
    expect(s.model).toBe("opus");
    expect(s.hooks.PreToolUse).toEqual([original.hooks.PreToolUse[0], { matcher: "AskUserQuestion", ...ours }]);
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
    expect(installHooks("/x/blimpd", settings)).toEqual(["Stop", "UserPromptSubmit", "PostToolUse", "PermissionRequest", "PreToolUse", "Elicitation"]);
  });

  test("idempotent even when the binary isn't called blimpd", () => {
    const settings = join(tmp, "renamed.json");
    expect(installHooks("/x/dist/blimpd-linux-x64", settings)).toHaveLength(7);
    expect(installHooks("/x/dist/blimpd-linux-x64", settings)).toEqual([]);
  });

  test("no settings.json yet: creates it, nothing to back up", () => {
    const settings = join(tmp, "fresh", "settings.json");
    expect(installHooks("/x/blimpd", settings)).toHaveLength(7);
    expect(existsSync(settings + ".blimp-backup")).toBe(false);
  });

  test("a symlinked settings.json stays a link and its target gets the hooks", () => {
    // Dotfiles managers link ~/.claude/settings.json into a repo.
    mkdirSync(join(tmp, "dotfiles"));
    mkdirSync(join(tmp, "linked"));
    writeFileSync(join(tmp, "dotfiles", "s.json"), JSON.stringify({ a: 1 }));
    const settings = join(tmp, "linked", "settings.json");
    symlinkSync("../dotfiles/s.json", settings);
    expect(installHooks("/x/blimpd", settings)).toHaveLength(7);
    expect(lstatSync(settings).isSymbolicLink()).toBe(true);
    const s = JSON.parse(readFileSync(join(tmp, "dotfiles", "s.json"), "utf8"));
    expect(s.a).toBe(1);
    expect(Object.keys(s.hooks)).toHaveLength(7);
    expect(readdirSync(join(tmp, "dotfiles"))).toEqual(["s.json"]); // no temp files left
  });

  test("refuses to overwrite settings it can't read", () => {
    const settings = join(tmp, "broken.json");
    writeFileSync(settings, "{ not json");
    expect(() => installHooks("/x/blimpd", settings)).toThrow();
    expect(readFileSync(settings, "utf8")).toBe("{ not json");
  });
});

describe("uninstallHooks", () => {
  const original = {
    model: "opus",
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "say done" }] }],
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "check" }] }],
    },
  };

  test("removes exactly what installHooks added and nothing else", () => {
    const settings = join(tmp, "un.json");
    writeFileSync(settings, JSON.stringify(original), { mode: 0o640 });
    installHooks("/opt/it's/blimpd", settings);
    expect(uninstallHooks("/opt/it's/blimpd", settings)).toEqual(["Notification", "Stop", "UserPromptSubmit", "PostToolUse", "PermissionRequest", "PreToolUse", "Elicitation"]);
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual(original);
    expect(statSync(settings).mode & 0o777).toBe(0o640);

    // Nothing left to remove: the file isn't touched.
    const after = readFileSync(settings, "utf8");
    expect(uninstallHooks("/opt/it's/blimpd", settings)).toEqual([]);
    expect(readFileSync(settings, "utf8")).toBe(after);
  });

  test("settings that had no hooks at all come back without a hooks key", () => {
    const settings = join(tmp, "un-bare.json");
    writeFileSync(settings, JSON.stringify({ model: "opus" }));
    installHooks("/x/dist/blimpd-linux-x64", settings);
    expect(uninstallHooks("/x/dist/blimpd-linux-x64", settings)).toHaveLength(7);
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({ model: "opus" });
  });

  test("an older or differently placed blimpd's hook goes too; a group's other hooks stay", () => {
    const settings = join(tmp, "un-mixed.json");
    const mine = { type: "command", command: "say hi" };
    writeFileSync(
      settings,
      JSON.stringify({
        hooks: {
          Notification: [{ matcher: "", hooks: [{ type: "command", command: "/home/u/.local/bin/blimpd hook" }, mine] }],
          Stop: [{ hooks: [{ type: "command", command: "'/other/blimpd' hook", timeout: 5 }] }],
          // install-hooks never adds to other events, so it never removes from them either.
          SessionStart: [{ hooks: [{ type: "command", command: "/home/u/.local/bin/blimpd hook" }] }],
        },
      }),
    );
    expect(uninstallHooks("/x/blimpd", settings)).toEqual(["Notification", "Stop"]);
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({
      hooks: {
        Notification: [{ matcher: "", hooks: [mine] }],
        SessionStart: [{ hooks: [{ type: "command", command: "/home/u/.local/bin/blimpd hook" }] }],
      },
    });
  });

  test("a symlinked settings.json stays a link and its target loses the hooks", () => {
    mkdirSync(join(tmp, "dotfiles2"));
    mkdirSync(join(tmp, "linked2"));
    writeFileSync(join(tmp, "dotfiles2", "s.json"), JSON.stringify({ a: 1 }));
    const settings = join(tmp, "linked2", "settings.json");
    symlinkSync("../dotfiles2/s.json", settings);
    installHooks("/x/blimpd", settings);
    expect(uninstallHooks("/x/blimpd", settings)).toHaveLength(7);
    expect(lstatSync(settings).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(join(tmp, "dotfiles2", "s.json"), "utf8"))).toEqual({ a: 1 });
    expect(readdirSync(join(tmp, "dotfiles2"))).toEqual(["s.json"]); // no temp files left
  });

  test("no settings.json: nothing to do, nothing created", () => {
    const settings = join(tmp, "none", "settings.json");
    expect(uninstallHooks("/x/blimpd", settings)).toEqual([]);
    expect(existsSync(settings)).toBe(false);
  });

  test("refuses to overwrite settings it can't read", () => {
    const settings = join(tmp, "un-broken.json");
    writeFileSync(settings, "{ not json");
    expect(() => uninstallHooks("/x/blimpd", settings)).toThrow();
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
      ["PermissionRequest", "waiting"],
      ["Elicitation", "waiting"],
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

  test("PreToolUse means waiting only for the question tool", () => {
    writeHookStatus(ev("Stop"), "web-4", dir);
    writeHookStatus(JSON.stringify({ hook_event_name: "PreToolUse", session_id: "abc", tool_name: "Bash" }), "web-4", dir);
    expect(read("web-4").state).toBe("done");
    writeHookStatus(JSON.stringify({ hook_event_name: "PreToolUse", session_id: "abc", tool_name: "AskUserQuestion" }), "web-4", dir);
    expect(read("web-4").state).toBe("waiting");
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
    expect(readdirSync(dir).sort()).toEqual(["web-1.json", "web-3.json", "web-4.json"]);
  });

  test("records what Claude asked, and a later Notification keeps it", () => {
    writeHookStatus(JSON.stringify({ hook_event_name: "PermissionRequest", session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" } }), "p1", dir);
    const first = read("p1");
    expect(first.prompt).toMatchObject({ kind: "permission", summary: "Ran `ls`" });
    writeHookStatus(JSON.stringify({ hook_event_name: "Notification", session_id: "s1", notification_type: "permission_prompt" }), "p1", dir);
    expect(read("p1").prompt).toEqual(first.prompt);
    expect(read("p1").at).toBe(first.at);
    writeHookStatus(JSON.stringify({ hook_event_name: "PostToolUse", session_id: "s1" }), "p1", dir);
    expect(read("p1").prompt).toBeUndefined();
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

test("`blimpd uninstall-hooks` takes them out of $CLAUDE_CONFIG_DIR/settings.json", () => {
  const dir = join(tmp, "cli");
  mkdirSync(dir);
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "'/u/blimpd' hook" }] }] } }));
  const r = Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "main.ts"), "uninstall-hooks"], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: dir, CODEX_HOME: join(dir, "no-codex") },
  });
  expect(r.exitCode).toBe(0);
  expect(r.stdout.toString()).toBe("hooks: removed Stop\n");
  expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))).toEqual({});
});

test("`blimpd uninstall-hooks` skips a Codex hooks.json that isn't strict JSON, leaving it as it was", () => {
  const dir = join(tmp, "cli-codex");
  mkdirSync(join(dir, "codex"), { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "'/u/blimpd' hook" }] }] } }));
  const mine = '{\n  // mine\n  "hooks": {},\n}\n';
  writeFileSync(join(dir, "codex", "hooks.json"), mine);
  const r = Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "main.ts"), "uninstall-hooks"], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: dir, CODEX_HOME: join(dir, "codex") },
  });
  expect(r.exitCode).toBe(0);
  expect(r.stderr.toString()).toBe("");
  expect(r.stdout.toString()).toMatch(/^hooks: removed Stop\ncodex hooks: skipped \(.+\)\n$/);
  expect(readFileSync(join(dir, "codex", "hooks.json"), "utf8")).toBe(mine);
});

// Codex's ~/.codex/hooks.json takes the same format. Only temp folders here, never the real ~/.codex.
describe("Codex hooks", () => {
  test("added after the user's own (Codex trusts hooks by their place), backed up once, taken out cleanly", () => {
    const dir = join(tmp, "codex");
    const file = join(dir, "hooks.json");
    const original = {
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard.sh" }] }],
        Stop: [{ hooks: [{ type: "command", command: "say done" }] }],
        SessionStart: [{ hooks: [{ type: "command", command: "hello" }] }],
      },
    };
    mkdirSync(dir);
    writeFileSync(file, JSON.stringify(original), { mode: 0o600 });

    expect(installHooks("/x/blimpd", file, CODEX_HOOKS)).toEqual(["UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop"]);
    const ours = { hooks: [{ type: "command", command: "'/x/blimpd' hook codex", timeout: 5 }] };
    const s = JSON.parse(readFileSync(file, "utf8"));
    expect(s.hooks.PreToolUse).toEqual([original.hooks.PreToolUse[0], ours]); // no matcher: every tool
    expect(s.hooks.Stop).toEqual([original.hooks.Stop[0], ours]);
    expect(s.hooks.SessionStart).toEqual(original.hooks.SessionStart);
    expect(s.hooks.PermissionRequest).toEqual([ours]);
    expect(JSON.parse(readFileSync(file + ".blimp-backup", "utf8"))).toEqual(original);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(installHooks("/x/blimpd", file, CODEX_HOOKS)).toEqual([]);

    expect(uninstallHooks("/x/blimpd", file, CODEX_HOOKS)).toHaveLength(5);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(original);
  });

  test("states: prompt and every tool call are working, a permission request waiting, Stop done", () => {
    const dir = join(tmp, "codex-status");
    const read = () => JSON.parse(readFileSync(join(dir, "cx-1.json"), "utf8")).state;
    const ev = (name: string, extra = {}) => JSON.stringify({ hook_event_name: name, session_id: "t1", ...extra });
    for (const [event, state] of [
      ["UserPromptSubmit", "working"],
      ["PermissionRequest", "waiting"],
      ["PreToolUse", "working"],
      ["Stop", "done"],
      ["PostToolUse", "working"],
    ]) {
      writeHookStatus(ev(event, { tool_name: "shell" }), "cx-1", dir, true);
      expect(read()).toBe(state);
    }
    writeHookStatus(ev("SessionStart"), "cx-1", dir, true);
    expect(read()).toBe("working");
  });
});
