import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserMcpConfigPath, mcpConfig, mcpConfigPath } from "../src/browser/mcp";
import { installed, kindLabel, launchFor, listKinds, readKindsFile } from "../src/kinds";

// A temp home with nothing in it: no Z.ai key, no ~/.codex, no kinds.json.
const home = mkdtempSync(join(tmpdir(), "blimp-kinds-"));
const file = join(home, "kinds.json");
afterAll(() => rmSync(home, { recursive: true, force: true }));

test("a kind whose command the login shell doesn't find is greyed, saying so", () => {
  expect(listKinds(new Set(), home, file)).toEqual([
    { id: "claude", label: "Claude Code", available: false, note: "claude isn't installed" },
    { id: "claude-glm", label: "Claude Code on GLM", available: false, note: "Add a Z.ai key in Settings" },
    { id: "codex", label: "Codex", available: false, note: "codex isn't installed" },
    { id: "shell", label: "Shell", available: true },
  ]);
  // With a key but no claude, GLM can't start either.
  mkdirSync(join(home, ".config", "zai"), { recursive: true });
  writeFileSync(join(home, ".config", "zai", "key"), "a-key-of-sorts\n");
  expect(listKinds(new Set(["codex"]), home, file).find((k) => k.id === "claude-glm")).toEqual({
    id: "claude-glm",
    label: "Claude Code on GLM",
    available: false,
    note: "claude isn't installed",
  });
  // An empty key file is no key.
  writeFileSync(join(home, ".config", "zai", "key"), "\n");
  expect(listKinds(new Set(["claude"]), home, file).find((k) => k.id === "claude-glm")?.note).toBe("Add a Z.ai key in Settings");
});

test("labels for session rows: none for Claude Code and a shell; a custom kind's own", () => {
  writeFileSync(file, JSON.stringify({ kinds: [{ id: "aider", label: "Aider", command: ["aider"] }] }));
  const custom = readKindsFile(file).kinds;
  expect([kindLabel("claude", custom), kindLabel("shell", custom), kindLabel("claude-glm", custom), kindLabel("codex", custom)]).toEqual([undefined, undefined, "GLM", "Codex"]);
  expect(kindLabel("aider", custom)).toBe("Aider");
  expect(kindLabel("gone-from-the-file", custom)).toBe("gone-from-the-file");
  rmSync(file);
});

test("a custom kind whose command the login shell doesn't find is greyed, saying so", () => {
  const f = join(home, "custom.json");
  writeFileSync(f, JSON.stringify({ kinds: [{ id: "aider", label: "Aider", command: ["aider", "--yes"] }] }));
  expect(listKinds(new Set(), home, f).find((k) => k.id === "aider")).toEqual({ id: "aider", label: "Aider", available: false, note: "aider isn't installed" });
  expect(listKinds(new Set(["aider"]), home, f).find((k) => k.id === "aider")).toEqual({ id: "aider", label: "Aider", available: true });
});

// A stand-in login shell that, like bash on Debian, has bin on PATH only when it's interactive
// (.bashrc returns early otherwise, before nvm and ~/.local/bin).
function loginShellWith(bin: string): string {
  mkdirSync(bin, { recursive: true });
  const sh = bin + "-shell";
  writeFileSync(sh, `#!/bin/sh\n[ "$1" = -l ] && shift\nPATH=/nonexistent\n[ "$1" = -i ] && shift && PATH="${bin}"\n[ "$1" = -c ] && shift && exec /bin/sh -c "$@"\n`);
  chmodSync(sh, 0o755);
  return sh;
}
const program = (bin: string, name: string, body = "exit 0") => {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
};
// Each test its own kinds.json, so the 30 s lookup cache (keyed by the names looked for) is fresh.
let n = 0;
const kindsWith = (command: string) => {
  const f = join(home, `kinds-${++n}.json`);
  writeFileSync(f, JSON.stringify({ kinds: [{ id: "mine", label: "Mine", command: [command] }] }));
  return f;
};
const realShell = process.env.SHELL;
afterAll(() => (process.env.SHELL = realShell));

test("the lookup runs the login shell as sessions do (-l -i), custom kinds' commands too", async () => {
  const bin = join(home, "bin-i");
  process.env.SHELL = loginShellWith(bin);
  program(bin, "claude");
  program(bin, "my tool");
  const have = await installed(kindsWith("my tool"));
  expect([...have].sort()).toEqual(["claude", "my tool"]);
});

test("a lookup that finds nothing isn't kept: the next one asks again", async () => {
  const bin = join(home, "bin-later");
  process.env.SHELL = loginShellWith(bin);
  const f = kindsWith("later-tool");
  expect((await installed(f)).size).toBe(0);
  program(bin, "claude");
  expect([...(await installed(f))]).toEqual(["claude"]);
});

test("Claude Code is still tried when the lookup found nothing; other kinds aren't", async () => {
  process.env.SHELL = loginShellWith(join(home, "bin-none"));
  const f = kindsWith("none-tool");
  expect(await launchFor("claude", undefined, home, f)).toEqual({ script: 'exec claude "$@"', args: ["claude"] });
  await expect(launchFor("codex", undefined, home, f)).rejects.toThrow("codex isn't installed");
  await expect(launchFor("mine", undefined, home, f)).rejects.toThrow("none-tool isn't installed");
});

test("GLM: the settings are set by the script, after the profile; the key only in the environment", async () => {
  const bin = join(home, "bin-glm");
  process.env.SHELL = loginShellWith(bin);
  program(bin, "claude", 'echo "$ANTHROPIC_BASE_URL|$ANTHROPIC_MODEL|$ANTHROPIC_AUTH_TOKEN|${BLIMP_ZAI_TOKEN-unset}|${ANTHROPIC_API_KEY-unset}|$*"');
  const f = join(home, "glm.json");
  writeFileSync(f, JSON.stringify({ glm: { model: "it's $(x) `y`" } }));
  writeFileSync(join(home, ".config", "zai", "key"), "zai-unit-key-0123456789");
  const run = await launchFor("claude-glm", "abc", home, f);
  expect(run.env).toEqual({ BLIMP_ZAI_TOKEN: "zai-unit-key-0123456789" });
  expect(run.script).not.toContain("zai-unit-key");
  // What a profile might have set is overridden; the model, odd characters and all, arrives as it is.
  const out = Bun.spawnSync(["/bin/sh", "-c", run.script!, ...run.args], {
    env: { PATH: bin, ...run.env, ANTHROPIC_BASE_URL: "https://elsewhere.example", ANTHROPIC_API_KEY: "theirs" },
  }).stdout.toString();
  expect(out).toBe(`https://api.z.ai/api/anthropic|it's $(x) \`y\`|zai-unit-key-0123456789|unset|unset|--mcp-config ${mcpConfigPath()} --resume abc\n`);
});

test("Claude Code and Codex always get blimp's MCP (the show tool), and the server browser's when there's a Chrome and npx", async () => {
  const bin = join(home, "bin-browser");
  process.env.SHELL = loginShellWith(bin);
  for (const p of ["claude", "codex", "npx"]) program(bin, p);
  const f = kindsWith("browser-tool");
  const yes = () => true;
  const claude = await launchFor("claude", "abc", home, f, yes);
  expect(claude.args).toEqual(["claude", "--mcp-config", browserMcpConfigPath(), "--resume", "abc"]);
  const codex = await launchFor("codex", undefined, home, f, yes);
  expect(codex.args[0]).toBe("codex");
  expect(codex.args.filter((a) => a === "-c")).toHaveLength(4);
  expect(codex.args[2]).toMatch(/^mcp_servers\.blimp\.command=".+"$/);
  expect(codex.args[4]).toMatch(/^mcp_servers\.blimp\.args=\[.*"visuals-mcp"\]$/);
  expect(codex.args[6]).toMatch(/^mcp_servers\.blimp-browser\.command=".+"$/);
  expect(codex.args[8]).toMatch(/^mcp_servers\.blimp-browser\.args=\[.*"browser-mcp"\]$/);
  // No Chrome: blimp's own only.
  expect((await launchFor("claude", undefined, home, f, () => false)).args).toEqual(["claude", "--mcp-config", mcpConfigPath()]);
  const plain = (await launchFor("codex", undefined, home, f, () => false)).args;
  expect(plain).toHaveLength(5);
  expect(plain[4]).toMatch(/^mcp_servers\.blimp\.args=\[.*"visuals-mcp"\]$/);
});

test("no npx: blimp's MCP still, no browser", async () => {
  const bin = join(home, "bin-no-npx");
  process.env.SHELL = loginShellWith(bin);
  program(bin, "claude");
  expect((await launchFor("claude", undefined, home, kindsWith("no-npx-tool"), () => true)).args).toEqual(["claude", "--mcp-config", mcpConfigPath()]);
});

test("mcp.json: blimp's server always, the browser's when asked", () => {
  const self = ["/usr/local/bin/blimpd"];
  expect(JSON.parse(mcpConfig(self, false))).toEqual({ mcpServers: { blimp: { command: "/usr/local/bin/blimpd", args: ["visuals-mcp"] } } });
  expect(JSON.parse(mcpConfig(["bun", "/src/main.ts"], true))).toEqual({
    mcpServers: { blimp: { command: "bun", args: ["/src/main.ts", "visuals-mcp"] }, "blimp-browser": { command: "bun", args: ["/src/main.ts", "browser-mcp"] } },
  });
});
