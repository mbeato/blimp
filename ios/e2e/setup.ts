// Stand-in Claude sessions for the iPhone end-to-end test (the app-e2e job in .github/workflows/ios.yml,
// driven by ios/BlimpUITests). Run after blimpd has started: it makes three zmx sessions that look like
// Claude to blimpd (the same way test/server.test.ts does), a past conversation, then writes the pairing link.
//   demo-chat  in blimp-demo: a conversation; every line typed into it is appended to $E2E_DIR/chat.in
//              and, with a reply, to its transcript
//   demo-ask   in api-server: waiting on a permission prompt; every key pressed is appended to $E2E_DIR/prompt.in
//   demo-busy  in api-server: working (Claude's status "busy"); every key pressed is appended to $E2E_DIR/stop.in,
//              and an Esc makes it idle
//   a conversation in blimp-demo with no session running, for the project screen's Earlier list
// The folders are under the home folder: blimpd starts sessions only there. Sessions the app starts
// run the stand-in claude in ios/e2e/bin. The texts here are what BlimpUITests looks for.

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { projectFolderName } from "../../src/folders";
import { parseZmxList, zmxPath } from "../../src/sessions";

const root = process.env.E2E_DIR!;
const sock = process.env.BLIMPD_SOCKET!;
const claude = process.env.CLAUDE_CONFIG_DIR!;
const work = join(process.env.HOME!, "e2e-work");
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
async function standIn(name: string, dir: string, script: string, sessionId: string, lines: string[], status = "idle") {
  mkdirSync(dir, { recursive: true });
  Bun.spawnSync([zmxPath(), "attach", name, "sh", "-c", script], { env, cwd: dir, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const z = await until(() => parseZmxList(Bun.spawnSync([zmxPath(), "list"], { env }).stdout.toString()).find((s) => s.name === name && s.pid > 0), `zmx session ${name}`);
  mkdirSync(join(claude, "sessions"), { recursive: true });
  mkdirSync(join(claude, "projects", "e2e"), { recursive: true });
  writeFileSync(join(claude, "projects", "e2e", `${sessionId}.jsonl`), lines.join(""));
  writeFileSync(join(claude, "sessions", `${z.pid}.json`), JSON.stringify({ sessionId, cwd: dir, status }));
  console.log(`${name}: pid ${z.pid} in ${dir}`);
}

const chatIn = join(root, "chat.in");
const promptIn = join(root, "prompt.in");
const stopIn = join(root, "stop.in");
for (const f of [chatIn, promptIn, stopIn]) writeFileSync(f, "");

// Like Claude, it writes what it read (paste markers off) and a reply to its transcript, so the phone sees both arrive.
const chatSid = "e2e00000-0000-0000-0000-000000000001";
const chatLog = join(claude, "projects", "e2e", `${chatSid}.jsonl`);
const echo = String.raw`n=0; while IFS= read -r l; do printf '%s\n' "$l" >> '${chatIn}'; n=$((n+1)); t=$(printf %s "$l" | tr -d '\033' | sed 's/\[20[01]~//g'); ts=$(date -u +%Y-%m-%dT%H:%M:%SZ); printf '{"type":"user","uuid":"in%s","timestamp":"%s","message":{"role":"user","content":"%s"}}\n{"type":"assistant","uuid":"out%s","timestamp":"%s","message":{"role":"assistant","content":[{"type":"text","text":"Shipped: %s"}]}}\n' "$n" "$ts" "$t" "$n" "$ts" "$t" >> '${chatLog}'; done`;
await standIn("demo-chat", join(work, "blimp-demo"), echo, chatSid, [
  user("u1", "Add a dark mode toggle to settings"),
  line({ type: "assistant", uuid: "a1", message: { role: "assistant", content: [
    { type: "text", text: "I'll add the toggle, then run the tests." },
    { type: "tool_use", id: "t1", name: "Bash", input: { command: "swift test" } },
  ] } }),
  line({ type: "user", uuid: "u2", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "Test Suite 'All tests' passed" }] } }),
  said("a2", "Done. The toggle is in **Settings**, under Appearance.\n\n- `SettingsView.swift`: the new toggle\n- `Theme.swift`: reads it at launch"),
]);

// Raw keys, as Claude reads them: a digit arrives without Enter.
await standIn("demo-ask", join(work, "api-server"), `stty -icanon -echo; exec cat >> '${promptIn}'`,
  "e2e00000-0000-0000-0000-000000000002", [user("u1", "Run the test suite"), said("a1", "I'll run the tests.")]);

// Working on something: the phone shows Stop, which presses Esc (raw keys again). Like Claude, it stops
// working on Esc: its status file says idle, and the phone's Stop goes away.
const busySid = "e2e00000-0000-0000-0000-000000000003";
const busyDir = join(work, "api-server");
const idle = JSON.stringify({ sessionId: busySid, cwd: busyDir, status: "idle" });
const stopped = String.raw`stty -icanon -echo; (while sleep 0.2; do case "$(tr '\033' E < '${stopIn}')" in *E) printf '%s' '${idle}' > '${join(claude, "sessions")}'/$$.json; break;; esac; done) & exec cat >> '${stopIn}'`;
await standIn("demo-busy", busyDir, stopped, busySid,
  [user("u1", "Refactor the auth middleware"), said("a1", "Working through the routes now.")], "busy");

// A conversation in blimp-demo with nothing running it: the project screen lists it under Earlier.
// Claude keeps it in a folder named after the real path of where it ran.
const demoDir = join(work, "blimp-demo");
const past = join(claude, "projects", projectFolderName(realpathSync(demoDir)));
mkdirSync(past, { recursive: true });
writeFileSync(join(past, "e2e00000-0000-0000-0000-000000000004.jsonl"), [
  line({ type: "user", uuid: "p1", cwd: realpathSync(demoDir), message: { role: "user", content: "Fix the login redirect" } }),
  said("p2", "Fixed: after signing in you land on the page you came from."),
].join(""));

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
