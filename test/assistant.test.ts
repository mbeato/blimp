// The assistant (src/assistant.ts): its folder's files, its permission rules, the switch, and the keep-alive.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assistantOn, assistantSettings, blimpMd, CLAUDE_MD, hasConversation, writeAssistantFiles } from "../src/assistant";
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
    expect(s.permissions.allow).toEqual(["Bash(blimpd overview)", "Bash(/opt/blimpd overview)", "Bash(blimpd read:*)", "Bash(/opt/blimpd read:*)", "Read(~/**)"]);
    expect(s.permissions.allow.filter((r) => s.permissions.ask.includes(r))).toEqual([]);
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
