// test/real-claude.test.ts
// The chat socket against a real Claude Code: a message, a permission prompt, and a question, all
// answered through /chat. Opt-in (BLIMP_REAL_CLAUDE=1): it uses your Claude account.
// Its folder and Claude's saved conversation for it are removed afterwards.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { zmxPath } from "../src/sessions";

const on = process.env.BLIMP_REAL_CLAUDE === "1";
let tmp = "";
let sock = "";
let dir = "";
// From inside a Claude session, CLAUDE_* variables would turn off the child's transcript.
const env: Record<string, string | undefined> = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE") && k !== "ZMX_SESSION"));
let server: ReturnType<typeof Bun.spawn>;
let token = "";
let name = "";
const sockets: WebSocket[] = []; // closed in afterAll
const open = (url: string) => {
  const w = new WebSocket(url);
  sockets.push(w);
  return w;
};

async function until<T>(f: () => T | Promise<T>, what: string, ms = 60000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(200);
  }
}
const api = (path: string, init: RequestInit = {}) => fetch(`http://blimpd${path}`, { ...init, unix: sock, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } } as any);
const session = async () => ((await (await api("/sessions")).json()) as any[]).find((s) => s.name === name);

beforeAll(async () => {
  if (!on) return;
  tmp = mkdtempSync(join(tmpdir(), "blimp-real-"));
  sock = join(tmp, "blimpd.sock");
  dir = realpathSync(mkdtempSync(join(homedir(), ".blimptest-real-")));
  env.BLIMPD_SOCKET = sock;
  // Permission prompts need the default mode: Max's settings run auto mode, which asks nothing.
  // The hooks in ~/.claude/settings.json run the installed blimpd, not this code, so this session
  // gets this code's hook through --settings, and the installed one writes to a decoy folder
  // (it finds its folder from BLIMPD_SOCKET; ours is told the real one).
  const hook = `BLIMPD_SOCKET='${sock}' '${process.execPath}' '${join(import.meta.dir, "..", "src", "main.ts")}' hook`;
  const ours = { hooks: [{ type: "command", command: hook, timeout: 5 }] };
  const settings = join(tmp, "test-settings.json");
  writeFileSync(settings, JSON.stringify({ hooks: {
    Notification: [ours], Stop: [ours], UserPromptSubmit: [ours], PostToolUse: [ours], PermissionRequest: [ours],
    PreToolUse: [{ matcher: "AskUserQuestion", ...ours }], Elicitation: [ours] } }));
  writeFileSync(join(tmp, "kinds.json"), JSON.stringify({ kinds: [{ id: "ask", label: "Ask",
    command: ["claude", "--permission-mode", "default", "--settings", settings],
    env: { BLIMPD_SOCKET: join(tmp, "decoy", "blimpd.sock") } }] }));
  server = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "main.ts"), "serve"], { env, stdout: "ignore", stderr: "inherit" });
  await until(() => existsSync(sock) && statSync(sock).isSocket() && (token = readFileSync(join(tmp, "token"), "utf8").trim()), "blimpd", 10000);
});

afterAll(() => {
  if (!on) return;
  for (const w of sockets) w.close();
  if (name) Bun.spawnSync([zmxPath(), "kill", name], { env });
  server?.kill();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  // Only this test's own folder: under the home folder, with the name beforeAll gave it.
  if (dir && dirname(dir) === realpathSync(homedir()) && basename(dir).startsWith(".blimptest-real-")) {
    rmSync(dir, { recursive: true, force: true });
    // Claude names its saved-conversation folder from the path it was started in, which may be the
    // other spelling of this one (/Users/x vs /home/x). Match whole names, never a suffix.
    const named = (p: string) => p.replace(/[^A-Za-z0-9]/g, "-");
    const base = basename(dir);
    const mine = new Set([named(dir), named(join("/Users", basename(dirname(dir)), base)), named(join("/home", basename(dirname(dir)), base))]);
    const projects = join(homedir(), ".claude", "projects");
    if (existsSync(projects)) for (const d of readdirSync(projects)) if (mine.has(d)) rmSync(join(projects, d), { recursive: true, force: true });
  }
});

test.if(on)("a message, a permission, a question and a Stop, all through /chat", async () => {
  name = ((await (await api("/sessions", { method: "POST", body: JSON.stringify({ dir, kind: "ask" }) })).json()) as any).name;

  // A new folder asks whether to trust it, and no hook says so: answer it on a raw terminal.
  const term = open(`ws+unix://${sock}:/sessions/${name}/attach?cols=120&rows=36&token=${token}`);
  let screen = "";
  term.binaryType = "arraybuffer";
  term.onmessage = (e) => (screen += new TextDecoder().decode(e.data as ArrayBuffer));
  await until(() => screen.includes("trust this folder") || screen.includes("❯"), "Claude's first screen", 30000);
  if (screen.includes("trust this folder")) term.send(new TextEncoder().encode("\x1b[B\r"));
  await until(async () => (await session())?.sessionId, "Claude's session id", 30000);

  const got: any[] = [];
  const chat = open(`ws+unix://${sock}:/sessions/${name}/chat?token=${token}`);
  chat.onmessage = (e) => got.push(JSON.parse(e.data as string));
  await until(() => got.some((m) => m.type === "history"), "history", 10000);
  const send = (m: object) => chat.send(JSON.stringify(m));
  const texts = () => got.flatMap((m) => m.messages ?? []);

  send({ type: "input", id: "m1", text: "Run this exact shell command with the Bash tool: date > real.txt" });
  await until(() => texts().some((m) => m.role === "user" && m.text.includes("date > real.txt")), "my message in the transcript");

  const perm = await until(async () => {
    const s = await session();
    return s?.prompt?.kind === "permission" && s;
  }, "a permission prompt");
  expect(perm.prompt.options[0]).toBe("Yes");
  send({ type: "answer", id: "a1", at: perm.prompt.at, pick: 0, label: perm.prompt.options[0] });
  await until(() => existsSync(join(dir, "real.txt")), "the command to run");

  await until(async () => (await session())?.state === "done", "the turn to end", 90000);
  send({ type: "input", id: "m2", text: "Use the AskUserQuestion tool to ask me which color I like, with options red, green and blue." });
  const q = await until(async () => {
    const s = await session();
    return s?.prompt?.kind === "question" && s;
  }, "a question");
  expect(q.prompt.answerable).toBe(true);
  const green = q.prompt.questions[0].options.findIndex((o: any) => /green/i.test(o.label));
  send({ type: "answer", id: "a2", at: q.prompt.at, pick: green, label: q.prompt.questions[0].options[green].label });
  await until(() => texts().some((m) => m.role === "tool" && m.name === "AskUserQuestion" && /green/i.test(m.output ?? "")), "the answer in the transcript", 90000);

  chat.close();

  // Stop, from a fresh socket: its zmx client is new, and zmx 0.5 drops ESC as a new client's
  // first input unless it's primed (chatsocket.ts). The turn must end, and Claude must not have
  // taken the primer for anything.
  await until(async () => (await session())?.state === "done", "the turn to end", 90000);
  const got2: any[] = [];
  const chat2 = open(`ws+unix://${sock}:/sessions/${name}/chat?token=${token}`);
  chat2.onmessage = (e) => got2.push(JSON.parse(e.data as string));
  await until(() => got2.some((m) => m.type === "history"), "history", 10000);
  chat2.send(JSON.stringify({ type: "input", id: "m3", text: "Count from 1 to 300, one number per line, without using any tools." }));
  await until(async () => (await session())?.state === "working", "Claude to start counting", 60000);
  const fresh = open(`ws+unix://${sock}:/sessions/${name}/chat?token=${token}`);
  const got3: any[] = [];
  fresh.onmessage = (e) => got3.push(JSON.parse(e.data as string));
  await until(() => got3.some((m) => m.type === "history"), "history", 10000);
  fresh.send(JSON.stringify({ type: "interrupt", id: "i1" }));
  await until(() => got3.some((m) => m.type === "ack" && m.id === "i1"), "ack", 10000);
  await until(async () => (await session())?.state !== "working", "the interrupt to stop the turn", 20000);
  const all = [...got2, ...got3].flatMap((m) => m.messages ?? []);
  expect(all.some((m) => m.role === "user" && m.text.includes("[200~"))).toBe(false);
  chat2.close();
  fresh.close();
  term.close();
}, 400000);
