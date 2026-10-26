// The assistant's permission rules against a real Claude Code (opt-in, BLIMP_REAL_CLAUDE=1: it uses your Claude
// account, three short haiku runs). In a folder with the assistant's files, in default mode, with a broad Bash allow
// passed in as the user's own settings might have one: a look command runs, and an act command is refused, alone
// and after `cd … &&`. In -p mode a rule that asks is a refusal (Claude can't show the prompt), listed in
// permission_denials.

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAssistantFiles } from "../src/assistant";

const on = process.env.BLIMP_REAL_CLAUDE === "1";
const root = realpathSync(mkdtempSync(join(tmpdir(), "blimp-assistant-real-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test.skipIf(!on)("a look command runs; an act command is refused, alone and after cd", async () => {
  const dir = join(root, "assistant");
  const self = [process.execPath, join(import.meta.dir, "..", "src", "main.ts")];
  writeAssistantFiles(dir, self);
  const cmd = self.join(" ");
  // From inside a Claude session, CLAUDE_* variables would change the child. A socket of its own, so a command
  // that does run reaches no live blimpd.
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE") && k !== "ZMX_SESSION")), BLIMPD_SOCKET: join(root, "blimpd.sock") };
  const run = async (command: string) => {
    const p = Bun.spawn(
      ["claude", "-p", "--model", "haiku", "--permission-mode", "default", "--output-format", "json", "--max-turns", "3",
        "--settings", JSON.stringify({ permissions: { allow: ["Bash(*)"] } }),
        `Run exactly this shell command with the Bash tool, once, and then stop: ${command}`],
      { cwd: dir, env, stdout: "pipe", stderr: "pipe" },
    );
    const [out] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    const r = JSON.parse(out);
    return (r.permission_denials ?? []).map((d: any) => String(d.tool_input?.command ?? ""));
  };
  expect(await run(`${cmd} overview`)).toEqual([]);
  expect((await run(`${cmd} send nobody hi`)).some((c: string) => c.includes(" send nobody hi"))).toBe(true);
  expect((await run(`cd /tmp && ${cmd} send nobody hi`)).some((c: string) => c.includes(" send nobody hi"))).toBe(true);
}, 180000);
