// The assistant (src/assistant.ts): its folder's files, its permission rules, the switch, and the keep-alive.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assistantOn, assistantSettings, assistantTick, blimpMd, CLAUDE_MD, hasConversation, type KeepDeps, newKeepState, writeAssistantFiles } from "../src/assistant";
import { projectFolderName } from "../src/folders";
import { readConfig, saveConfig } from "../src/names";

const fresh = () => realpathSync(mkdtempSync(join(tmpdir(), "blimp-assistant-")));

describe("assistantSettings", () => {
  test("act commands and send tools ask, under the bare name and blimpd's own path; look commands and home reads are allowed", () => {
    const s = assistantSettings("/opt/blimpd");
    expect(s.permissions.defaultMode).toBe("default");
    for (const sub of ["start:*", "send:*", "answer:*"]) {
      expect(s.permissions.ask).toContain(`Bash(blimpd ${sub})`);
      expect(s.permissions.ask).toContain(`Bash(/opt/blimpd ${sub})`);
    }
    expect(s.permissions.ask).toContain("mcp__claude_ai_Gmail__send_message");
    expect(s.permissions.ask).toContain("mcp__claude_ai_Slack__slack_send_message");
    expect(s.permissions.ask).toContain("mcp__claude_ai_Google_Drive__share_file");
    expect(s.permissions.allow).toEqual(["Bash(blimpd overview)", "Bash(/opt/blimpd overview)", "Bash(blimpd read:*)", "Bash(/opt/blimpd read:*)", "Read(~/**)"]);
    expect(s.permissions.allow.filter((r) => s.permissions.ask.includes(r))).toEqual([]);
    expect(s.permissions.deny).toEqual([
      "Read(~/.ssh/**)",
      "Read(~/.aws/**)",
      "Read(~/.blimp/token)",
      "Read(~/.blimp/phone-token)",
      "Read(~/.blimp/secrets/**)",
      "Read(~/.blimp/browser/key)",
      "Read(~/.blimp/apns.p8)",
      "Read(~/.config/zai/**)",
      "Read(~/.claude/.credentials.json)",
      "Read(~/.codex/auth.json)",
    ]);
    expect(s.permissions.deny.filter((r) => s.permissions.allow.includes(r) || s.permissions.ask.includes(r))).toEqual([]);
  });

  test("blimpd on PATH as plain blimpd: each rule once", () => {
    const s = assistantSettings("blimpd");
    expect(s.permissions.ask.filter((r) => r === "Bash(blimpd send:*)")).toHaveLength(1);
    expect(s.permissions.allow.filter((r) => r === "Bash(blimpd overview)")).toHaveLength(1);
  });
});

describe("blimpMd", () => {
  test("names every command with blimpd's own path, says which ones ask, and the browser rule; for any user", () => {
    const md = blimpMd("/opt/blimpd");
    for (const c of ["overview", "read <session or conversation id>", "start <folder> <message>", "send <session> <message>", "answer <session> <option number>"])
      expect(md).toContain(`\`/opt/blimpd ${c}`);
    // The file wraps its lines; the sentences are checked with the line breaks taken out.
    const flat = md.replace(/\s+/g, " ");
    expect(flat).toContain("each one shows the user a permission prompt first");
    expect(flat).toContain("Before anything that buys, books, sends, posts, signs up or accepts terms, stop and ask in the chat");
    expect(md).toContain("`/opt/blimpd start <folder> <message> [--job <a few words>]`");
    expect(flat).toContain('Give each one `--job "<a few words>"` saying what it\'s for');
    expect(md).not.toContain("Max");
    expect(md).not.toContain("recense");
  });
});

describe("writeAssistantFiles", () => {
  test("blimp.md and the settings every time, CLAUDE.md only when missing, settings.local.json never", () => {
    const dir = join(fresh(), "assistant");
    writeAssistantFiles(dir, ["/opt/blimpd"]);
    expect(readFileSync(join(dir, "blimp.md"), "utf8")).toBe(blimpMd("/opt/blimpd"));
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe(CLAUDE_MD);
    expect(CLAUDE_MD).toStartWith("@blimp.md\n");
    expect(JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"))).toEqual(assistantSettings("/opt/blimpd"));
    expect(statSync(dir).mode & 0o777).toBe(0o700);

    writeFileSync(join(dir, "CLAUDE.md"), "@blimp.md\nmine\n");
    writeFileSync(join(dir, "blimp.md"), "old");
    writeFileSync(join(dir, ".claude", "settings.local.json"), '{"mine":true}');
    writeAssistantFiles(dir, ["/usr/bin/bun", "/src/main.ts"]);
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe("@blimp.md\nmine\n");
    expect(readFileSync(join(dir, "blimp.md"), "utf8")).toBe(blimpMd("/usr/bin/bun /src/main.ts"));
    expect(readFileSync(join(dir, ".claude", "settings.local.json"), "utf8")).toBe('{"mine":true}');
    expect(existsSync(join(dir, "blimp.md.tmp"))).toBe(false);
  });
});

describe("hasConversation", () => {
  test("only once Claude's projects folder for it has a transcript", () => {
    const root = fresh();
    const dir = join(root, "assistant");
    mkdirSync(dir);
    const claude = join(root, "claude");
    expect(hasConversation(dir, claude)).toBe(false);
    const folder = join(claude, "projects", projectFolderName(dir));
    mkdirSync(folder, { recursive: true });
    expect(hasConversation(dir, claude)).toBe(false);
    writeFileSync(join(folder, "notes.txt"), "");
    expect(hasConversation(dir, claude)).toBe(false);
    writeFileSync(join(folder, "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1.jsonl"), "");
    expect(hasConversation(dir, claude)).toBe(true);
  });
});

describe("the switch", () => {
  test("off unless config.json says assistant: true; saveConfig keeps the other settings, 600", () => {
    const file = join(fresh(), "config.json");
    expect(assistantOn(file)).toBe(false);
    writeFileSync(file, JSON.stringify({ names: false }));
    expect(assistantOn(file)).toBe(false);
    saveConfig({ assistant: true }, file);
    expect(readConfig(file)).toEqual({ names: false, assistant: true });
    expect(assistantOn(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    saveConfig({ assistant: "yes" }, file);
    expect(assistantOn(file)).toBe(false);
  });
});

describe("assistantTick", () => {
  const T = 1_800_000_000_000;
  function deps(o: Partial<KeepDeps> = {}) {
    const root = fresh();
    const started: { dir: string; opts: any }[] = [];
    const logs: string[] = [];
    let now = T;
    const d: KeepDeps = {
      on: () => true,
      running: async () => false,
      launch: async () => ({ script: 'exec claude "$@"', args: ["claude", "--mcp-config", "/m.json"] }),
      start: async (dir, opts) => (started.push({ dir, opts }), "assistant"),
      dir: join(root, "assistant"),
      claude: join(root, "claude"),
      self: ["/opt/blimpd"],
      now: () => now,
      log: (m) => void logs.push(m),
      ...o,
    };
    return { d, started, logs, later: (ms: number) => void (now += ms) };
  }

  test("off, or already running: nothing starts", async () => {
    const off = deps({ on: () => false });
    await assistantTick(off.d, newKeepState());
    const up = deps({ running: async () => true });
    await assistantTick(up.d, newKeepState());
    expect([off.started, up.started]).toEqual([[], []]);
  });

  test("switched off after launch (blimpd assistant off from another process): nothing starts", async () => {
    let calls = 0;
    const t = deps({ on: () => ++calls === 1 });
    await assistantTick(t.d, newKeepState());
    expect(t.started).toEqual([]);
  });

  test("on and not running: its files, then a Claude session named exactly assistant in its folder, in default mode", async () => {
    const t = deps();
    await assistantTick(t.d, newKeepState());
    expect(t.started).toEqual([
      { dir: t.d.dir, opts: { name: "assistant", exact: true, kind: "claude", run: { script: 'exec claude "$@"', args: ["claude", "--mcp-config", "/m.json", "--permission-mode", "default"] } } },
    ]);
    expect(existsSync(join(t.d.dir, "blimp.md"))).toBe(true);
  });

  test("with a conversation in its folder, it continues it", async () => {
    const t = deps();
    mkdirSync(t.d.dir, { recursive: true });
    const folder = join(t.d.claude, "projects", projectFolderName(realpathSync(t.d.dir)));
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2.jsonl"), "");
    await assistantTick(t.d, newKeepState());
    expect(t.started[0].opts.run.args.slice(-3)).toEqual(["--permission-mode", "default", "--continue"]);
  });

  test("three starts within 2 minutes: it waits 10 minutes, then tries again", async () => {
    const t = deps();
    const state = newKeepState();
    for (let i = 0; i < 3; i++) {
      await assistantTick(t.d, state);
      t.later(5000);
    }
    expect(t.started).toHaveLength(3);
    await assistantTick(t.d, state);
    expect(t.started).toHaveLength(3);
    expect(t.logs).toEqual(["assistant: it stopped 3 times in 2 minutes; trying again in 10 minutes"]);
    t.later(9 * 60_000);
    await assistantTick(t.d, state);
    expect(t.started).toHaveLength(3);
    t.later(60_000);
    await assistantTick(t.d, state);
    expect(t.started).toHaveLength(4);
  });

  test("a start that fails is logged and counts as a try", async () => {
    const t = deps({ start: async () => { throw new Error("zmx didn't start assistant"); } });
    const state = newKeepState();
    await assistantTick(t.d, state);
    expect(t.logs).toEqual(["assistant: couldn't start it: zmx didn't start assistant"]);
    expect(state.tries).toHaveLength(1);
  });
});
