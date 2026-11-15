// test/real-claude-files.test.ts
// Photos from the phone against a real Claude Code: two pictures uploaded (POST /uploads) and sent with a message
// through the chat socket's `files` are attached, so Claude sees them without reading a file; the chat shows them as
// pictures; a file that isn't a picture stays in the message as its path.
// Opt-in (BLIMP_REAL_CLAUDE=1): it uses your Claude account.
// Its folder, its uploads and Claude's saved conversation for it are removed afterwards.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import { parseZmxList, zmxPath } from "../src/sessions";

const on = process.env.BLIMP_REAL_CLAUDE === "1";
let tmp = "";
let sock = "";
let dir = "";
// From inside a Claude session, CLAUDE_* variables would turn off the child's transcript.
const env: Record<string, string | undefined> = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE") && k !== "ZMX_SESSION"));
let server: ReturnType<typeof Bun.spawn>;
let token = "";
let name = "";
const uploaded: string[] = [];
const sockets: WebSocket[] = [];

async function until<T>(f: () => T | Promise<T>, what: string, ms = 60000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(200);
  }
}
const api = (path: string, init: RequestInit = {}) => fetch(`http://blimpd${path}`, { ...init, unix: sock, headers: { Authorization: `Bearer ${token}`, ...(init.headers as any) } } as any);
const session = async () => ((await (await api("/sessions")).json()) as any[]).find((s) => s.name === name);

// A 64x64 PNG of one colour.
function png(r: number, g: number, b: number): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const x of buf) c = table[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, sum]);
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(64, 0);
  head.writeUInt32BE(64, 4);
  head[8] = 8;
  head[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array(64).fill([r, g, b]).flat())]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head), chunk("IDAT", deflateSync(Buffer.concat(Array(64).fill(row)))), chunk("IEND", Buffer.alloc(0))]);
}

beforeAll(async () => {
  if (!on) return;
  tmp = mkdtempSync(join(tmpdir(), "blimp-real-files-"));
  sock = join(tmp, "blimpd.sock");
  dir = realpathSync(mkdtempSync(join(homedir(), ".blimptest-real-files-")));
  env.BLIMPD_SOCKET = sock;
  writeFileSync(join(tmp, "config.json"), JSON.stringify({ names: false })); // no naming calls on your account
  // As real-claude.test.ts: this code's hook through --settings, the installed one sent to a decoy folder.
  const hook = `BLIMPD_SOCKET='${sock}' '${process.execPath}' '${join(import.meta.dir, "..", "src", "main.ts")}' hook`;
  const ours = { hooks: [{ type: "command", command: hook, timeout: 5 }] };
  const settings = join(tmp, "test-settings.json");
  writeFileSync(settings, JSON.stringify({ hooks: { Notification: [ours], Stop: [ours], UserPromptSubmit: [ours], PostToolUse: [ours], PermissionRequest: [ours] } }));
  writeFileSync(join(tmp, "kinds.json"), JSON.stringify({ kinds: [{ id: "ask", label: "Ask", command: ["claude", "--permission-mode", "default", "--settings", settings], env: { BLIMPD_SOCKET: join(tmp, "decoy", "blimpd.sock") } }] }));
  server = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "main.ts"), "serve"], { env, stdout: "ignore", stderr: "inherit" });
  await until(() => existsSync(sock) && statSync(sock).isSocket() && (token = readFileSync(join(tmp, "token"), "utf8").trim()), "blimpd", 10000);
});

afterAll(async () => {
  if (!on) return;
  for (const w of sockets) w.close();
  if (name) {
    const pid = parseZmxList(Bun.spawnSync([zmxPath(), "list"], { env }).stdout.toString()).find((s) => s.name === name)?.pid;
    Bun.spawnSync([zmxPath(), "kill", name], { env });
    const alive = () => { try { return !!pid && process.kill(pid, 0); } catch { return false; } };
    for (const end = Date.now() + 10000; alive() && Date.now() < end; ) await Bun.sleep(100);
  }
  server?.kill();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  // Only this test's own uploads: the paths blimpd gave it, with the name it asked for.
  for (const p of uploaded) if (basename(p).startsWith("blimptest-real-")) rmSync(p, { force: true });
  if (dir && dirname(dir) === realpathSync(homedir()) && basename(dir).startsWith(".blimptest-real-files-")) {
    rmSync(dir, { recursive: true, force: true });
    const named = (p: string) => p.replace(/[^A-Za-z0-9]/g, "-");
    const base = basename(dir);
    const mine = new Set([named(dir), named(join("/Users", basename(dirname(dir)), base)), named(join("/home", basename(dirname(dir)), base))]);
    const projects = join(homedir(), ".claude", "projects");
    if (existsSync(projects)) for (const d of readdirSync(projects)) if (mine.has(d)) rmSync(join(projects, d), { recursive: true, force: true });
  }
}, 20000);

test.if(on)("two pictures and a note sent from the phone: Claude sees the pictures, the chat shows them, the note's path stays text", async () => {
  const up = async (file: string, body: Buffer) => {
    const r = await api(`/uploads?name=${encodeURIComponent(file)}`, { method: "POST", body });
    expect(r.status).toBe(201);
    const { path } = (await r.json()) as { path: string };
    uploaded.push(path);
    return path;
  };
  const red = await up("blimptest-real-first.png", png(255, 0, 0));
  const blue = await up("blimptest-real-second.png", png(0, 0, 255));
  const note = await up("blimptest-real-note.mp4", Buffer.from("not really a video"));

  name = ((await (await api("/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dir, kind: "ask" }) })).json()) as any).name;
  const term = new WebSocket(`ws+unix://${sock}:/sessions/${name}/attach?cols=120&rows=36&token=${token}`);
  sockets.push(term);
  await until(async () => (await session())?.sessionId, "Claude's session id", 60000);
  const got: any[] = [];
  const chat = new WebSocket(`ws+unix://${sock}:/sessions/${name}/chat?token=${token}`);
  sockets.push(chat);
  chat.onmessage = (e) => got.push(JSON.parse(e.data as string));
  await until(() => got.some((m) => m.type === "history"), "the history", 15000);
  const texts = () => got.flatMap((m) => m.messages ?? []);

  chat.send(JSON.stringify({ type: "input", id: "m1", text: "Without using any tool, say the one main colour of each picture I attached, in order, as two words.", files: [red, blue] }));
  await until(() => got.find((m) => m.id === "m1"), "the message's reply", 20000);
  expect(got.find((m) => m.id === "m1")).toEqual({ type: "ack", id: "m1" });
  const reply = await until(() => texts().find((m) => m.role === "assistant" && /red/i.test(m.text ?? "") && /blue/i.test(m.text ?? "")), "Claude naming both colours", 120000);
  expect(reply.text.toLowerCase().indexOf("red")).toBeLessThan(reply.text.toLowerCase().indexOf("blue"));
  // No tool ran: the pictures came with the message.
  expect(texts().filter((m) => m.role === "tool")).toEqual([]);
  // In the chat: my words without Claude Code's marks for the pictures, then each picture as a card.
  expect(texts().filter((m) => m.role === "user").map((m) => m.text)).toEqual(["Without using any tool, say the one main colour of each picture I attached, in order, as two words."]);
  expect(texts().filter((m) => m.role === "file")).toMatchObject([
    { file: red, name: "blimptest-real-first.png", image: true, summary: "Sent blimptest-real-first.png" },
    { file: blue, name: "blimptest-real-second.png", image: true, summary: "Sent blimptest-real-second.png" },
  ]);

  // A file that isn't a picture: its path is in the message as text.
  await until(async () => (await session())?.state === "done", "the turn to end", 90000);
  chat.send(JSON.stringify({ type: "input", id: "m2", text: "Without using any tool, repeat the file path in this message exactly.", files: [note] }));
  await until(() => texts().some((m) => m.role === "assistant" && (m.text ?? "").includes(note)), "Claude repeating the path", 120000);
  expect(texts().filter((m) => m.role === "user").at(-1).text).toBe("Without using any tool, repeat the file path in this message exactly.");
  const sent = texts().filter((m) => m.role === "file").at(-1);
  expect(sent).toMatchObject({ file: note, name: "blimptest-real-note.mp4", summary: "Sent blimptest-real-note.mp4" });
  expect(sent.image).toBeUndefined();
}, 300000);
