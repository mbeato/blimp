// Stand-in Claude sessions for the iPhone end-to-end test (the app-e2e job in .github/workflows/ios.yml,
// driven by ios/BlimpUITests). Run after blimpd has started: it makes two zmx sessions that look like
// Claude to blimpd (the same way test/server.test.ts does), then writes the pairing link.
//   demo-chat  in blimp-demo: a conversation; every line typed into it is appended to $E2E_DIR/chat.in
//   demo-ask   in api-server: waiting on a permission prompt; every key pressed is appended to $E2E_DIR/prompt.in
// The texts here are what BlimpUITests looks for.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseZmxList, zmxPath } from "../../src/sessions";

const root = process.env.E2E_DIR!;
const sock = process.env.BLIMPD_SOCKET!;
const claude = process.env.CLAUDE_CONFIG_DIR!;
const env: Record<string, string | undefined> = { ...process.env };
delete env.ZMX_SESSION;

const T = new Date().toISOString();
const line = (o: object) => JSON.stringify({ timestamp: T, ...o }) + "\n";
const user = (uuid: string, text: string) => line({ type: "user", uuid, message: { role: "user", content: text } });
const said = (uuid: string, text: string) => line({ type: "assistant", uuid, message: { role: "assistant", content: [{ type: "text", text }] } });

async function until<T>(f: () => T, what: string, ms = 10000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

// A zmx session running `script` in dir, with Claude's status file and transcript for its pid.
async function standIn(name: string, dir: string, script: string, sessionId: string, lines: string[]) {
  mkdirSync(dir, { recursive: true });
  Bun.spawnSync([zmxPath(), "attach", name, "sh", "-c", script], { env, cwd: dir, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const z = await until(() => parseZmxList(Bun.spawnSync([zmxPath(), "list"], { env }).stdout.toString()).find((s) => s.name === name && s.pid > 0), `zmx session ${name}`);
  mkdirSync(join(claude, "sessions"), { recursive: true });
  mkdirSync(join(claude, "projects", "e2e"), { recursive: true });
  writeFileSync(join(claude, "projects", "e2e", `${sessionId}.jsonl`), lines.join(""));
  writeFileSync(join(claude, "sessions", `${z.pid}.json`), JSON.stringify({ sessionId, cwd: dir, status: "idle" }));
  console.log(`${name}: pid ${z.pid} in ${dir}`);
}

const chatIn = join(root, "chat.in");
const promptIn = join(root, "prompt.in");
writeFileSync(chatIn, "");
writeFileSync(promptIn, "");

await standIn("demo-chat", join(root, "work", "blimp-demo"), `while IFS= read -r l; do printf '%s\\n' "$l" >> '${chatIn}'; done`,
  "e2e00000-0000-0000-0000-000000000001", [
    user("u1", "Add a dark mode toggle to settings"),
    said("a1", "Done. The toggle is in **Settings**, under Appearance.\n\n- `SettingsView.swift`: the new toggle\n- `Theme.swift`: reads it at launch"),
  ]);

// Raw keys, as Claude reads them: a digit arrives without Enter.
await standIn("demo-ask", join(root, "work", "api-server"), `stty -icanon -echo; exec cat >> '${promptIn}'`,
  "e2e00000-0000-0000-0000-000000000002", [user("u1", "Run the test suite"), said("a1", "I'll run the tests.")]);

// What Claude's PermissionRequest hook would write: after the session started, or blimpd takes it for an older one's.
const status = join(dirname(sock), "status");
mkdirSync(status, { recursive: true });
writeFileSync(
  join(status, "demo-ask.json"),
  JSON.stringify({ state: "waiting", at: Date.now(), sessionId: "e2e00000-0000-0000-0000-000000000002", event: "PermissionRequest",
    prompt: { kind: "permission", tool: "Bash", summary: "Ran `npm test`", options: ["Yes", "No"], keys: ["1", "\u001b"], answerable: true } }),
);

const token = readFileSync(join(dirname(sock), "token"), "utf8").trim();
writeFileSync(join(root, "link"), `blimp://pair?url=${encodeURIComponent("http://127.0.0.1:7425")}&token=${token}`);
console.log("stand-ins ready");
