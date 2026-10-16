// Starts a real blimpd on a temp socket and talks to it like the app does, against real zmx sessions.
// Every zmx session made here is named blimptest-* and killed at the end; nothing else is touched.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseZmxList, zmxPath } from "../src/sessions";

const tmp = mkdtempSync(join(tmpdir(), "blimp-server-"));
const sock = join(tmp, "blimpd.sock");
const env: Record<string, string | undefined> = { ...process.env, BLIMPD_SOCKET: sock, CLAUDE_CONFIG_DIR: join(tmp, "claude") };
delete env.ZMX_SESSION; // inside zmx, `zmx attach` would switch sessions instead of creating one
const tag = `blimptest-${process.pid}`;
const made: string[] = [];
let server: ReturnType<typeof Bun.spawn>;
let token = "";
// Files tests need a folder inside the real home; it's removed afterwards.
const homeDir = realpathSync(mkdtempSync(join(homedir(), ".blimptest-")));

const zmx = (...args: string[]) => Bun.spawnSync([zmxPath(), ...args], { env, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
const zmxNames = () => parseZmxList(zmx("list").stdout.toString()).map((s) => s.name);

async function until<T>(f: () => T | Promise<T>, what: string, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
}

// A zmx session running sh. No pipes: the session daemon would inherit them.
async function shSession(suffix: string): Promise<string> {
  const name = `${tag}-${suffix}`;
  made.push(name);
  Bun.spawnSync([zmxPath(), "attach", name, "sh"], { env, cwd: tmp, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  await until(() => zmxNames().includes(name), `zmx session ${name}`);
  return name;
}

const api = (path: string, init: RequestInit = {}, auth = true) =>
  fetch(`http://blimpd${path}`, {
    ...init,
    unix: sock,
    headers: { ...(auth ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers as any) },
  } as any);

// A WebSocket that records everything it gets.
function socket(path: string) {
  const ws = new WebSocket(`ws+unix://${sock}:${path}${path.includes("?") ? "&" : "?"}token=${token}`);
  ws.binaryType = "arraybuffer";
  const s = { ws, text: "", messages: [] as any[], closed: undefined as undefined | { code: number; reason: string } };
  ws.onmessage = (e) => {
    if (typeof e.data === "string") s.messages.push(JSON.parse(e.data));
    else s.text += new TextDecoder().decode(e.data);
  };
  ws.onclose = (e) => (s.closed = { code: e.code, reason: e.reason });
  const opened = new Promise<typeof s>((res, rej) => {
    ws.onopen = () => res(s);
    ws.onerror = () => rej(new Error(`websocket ${path} failed`));
  });
  return opened;
}
const type = (ws: WebSocket, keys: string) => ws.send(new TextEncoder().encode(keys));

beforeAll(async () => {
  server = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "main.ts"), "serve"], { env, stdout: "pipe", stderr: "inherit" });
  await until(() => {
    try {
      return statSync(sock).isSocket() && (token = readFileSync(join(tmp, "token"), "utf8").trim());
    } catch {
      return false;
    }
  }, "blimpd to start");
});

afterAll(() => {
  server?.kill();
  for (const name of made) zmx("kill", name);
  rmSync(tmp, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

describe("token", () => {
  test("token file is 64 hex chars, readable only by you; socket and folder too", () => {
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(join(tmp, "token")).mode & 0o777).toBe(0o600);
    expect(statSync(sock).mode & 0o777).toBe(0o600);
    expect(statSync(tmp).mode & 0o777).toBe(0o700);
  });

  test("401 without or with a wrong token, CORS on every response", async () => {
    const none = await api("/health", {}, false);
    expect(none.status).toBe(401);
    expect(none.headers.get("access-control-allow-origin")).toBe("*");
    expect((await api("/health", { headers: { Authorization: "Bearer " + "0".repeat(64) } }, false)).status).toBe(401);
    expect((await api("/sessions?token=nope", {}, false)).status).toBe(401);

    const ok = await api("/health");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe("*");
    expect(await ok.json()).toEqual({ version: "0.2.0", home: realpathSync(homedir()) });
  });

  test("preflight needs no token", async () => {
    const r = await api("/sessions", { method: "OPTIONS" }, false);
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-headers")).toBe("Authorization, Content-Type");
    expect(r.headers.get("access-control-allow-methods")).toBe("GET, POST, PUT, OPTIONS");
  });
});

describe("terminal", () => {
  test("404 for an unknown session, and no session gets created", async () => {
    const r = await api(`/sessions/${tag}-nope/attach?token=${token}`);
    expect(r.status).toBe(404);
    expect(zmxNames()).not.toContain(`${tag}-nope`);
  });

  test("attach, type, resize, a second socket, close: the session lives on", async () => {
    const name = await shSession("a");
    const a = await socket(`/sessions/${name}/attach?cols=80&rows=24`);
    // The quotes keep the typed command from matching what we wait for: only the output can.
    type(a.ws, 'echo hel""lo\r');
    await until(() => a.text.includes("hello"), "echo output");

    a.ws.send(JSON.stringify({ type: "resize", cols: 101, rows: 33 }));
    await Bun.sleep(100);
    type(a.ws, "stty size\r");
    await until(() => a.text.includes("33 101"), "resized terminal");

    const b = await socket(`/sessions/${name}/attach?cols=101&rows=33`);
    type(b.ws, 'echo two""sockets\r');
    await until(() => a.text.includes("twosockets") && b.text.includes("twosockets"), "output on both sockets");

    a.ws.close();
    b.ws.close();
    await until(() => a.closed && b.closed, "sockets to close");
    // Each socket's zmx client is gone, the session itself isn't.
    const clients = () => parseZmxList(zmx("list").stdout.toString()).find((s) => s.name === name)?.clients;
    await until(() => clients() === 0, "zmx clients to detach");
    expect(zmxNames()).toContain(name);
    // And it can be attached again.
    const c = await socket(`/sessions/${name}/attach`);
    type(c.ws, 'echo ag""ain\r');
    await until(() => c.text.includes("again"), "output after reattach");
    c.ws.close();
  });

  test("closes with 4000 'ended' when the session ends", async () => {
    const name = await shSession("b");
    const s = await socket(`/sessions/${name}/attach`);
    type(s.ws, "exit\r");
    await until(() => s.closed, "socket to close");
    expect(s.closed).toEqual({ code: 4000, reason: "ended" });
  });
});

describe("events", () => {
  test("sends the session list on connect, with state", async () => {
    const name = await shSession("c");
    const e = await socket("/events");
    const msg = await until(() => e.messages.find((m) => m.type === "sessions"), "sessions message");
    const s = msg.sessions.find((x: any) => x.name === name);
    expect(s).toMatchObject({ name, title: "(new session)", state: "unknown" });

    // A hook file for it shows up within the 1 s check.
    mkdirSync(join(tmp, "status"), { recursive: true });
    writeFileSync(join(tmp, "status", `${name}.json`), JSON.stringify({ state: "waiting", at: Date.now() }));
    await until(
      () => e.messages.some((m) => m.type === "sessions" && m.sessions.some((x: any) => x.name === name && x.state === "waiting")),
      "waiting state",
      3000,
    );
    e.ws.close();
  });

  test("watched folders and files report changes, debounced; paths outside home are ignored", async () => {
    const file = join(homeDir, "notes.md");
    writeFileSync(file, "one");
    const e = await socket("/events");
    e.ws.send(JSON.stringify({ type: "watch", paths: [homeDir, file, tmp] }));
    await Bun.sleep(100);
    writeFileSync(file, "two");
    writeFileSync(join(tmp, "outside.txt"), "x");
    const fs = await until(() => e.messages.find((m) => m.type === "fs"), "fs message");
    expect(fs.paths.sort()).toEqual([homeDir, file].sort());

    // A save by rename (what blimp and most editors do) keeps the file watched.
    e.messages.length = 0;
    expect((await api(`/fs/file?path=${encodeURIComponent(file)}`, { method: "PUT", body: "three" })).status).toBe(200);
    await until(() => e.messages.some((m) => m.type === "fs" && m.paths.includes(file)), "fs after rename save");
    await Bun.sleep(300);
    e.messages.length = 0;
    writeFileSync(file, "four");
    await until(() => e.messages.some((m) => m.type === "fs" && m.paths.includes(file)), "fs after a later write");
    expect(e.messages.flatMap((m) => m.paths ?? [])).not.toContain(tmp);
    e.ws.close();
  });
});

describe("files over HTTP", () => {
  test("read, conflict, overwrite, list, 403 outside home", async () => {
    const file = join(homeDir, "a.txt");
    writeFileSync(file, "hello");
    const q = (p: string) => encodeURIComponent(p);

    const r = await api(`/fs/file?path=${q(file)}`);
    expect(await r.text()).toBe("hello");
    expect(r.headers.get("access-control-expose-headers")).toBe("X-Blimp-Mtime");
    const mtime = Number(r.headers.get("x-blimp-mtime"));

    const put = await api(`/fs/file?path=${q(file)}&baseMtime=${mtime}`, { method: "PUT", body: "edited" });
    expect(put.status).toBe(200);
    const { mtime: m2 } = await put.json();
    const stale = await api(`/fs/file?path=${q(file)}&baseMtime=${mtime - 1000}`, { method: "PUT", body: "mine" });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "changed on the server", mtime: m2 });
    expect(readFileSync(file, "utf8")).toBe("edited");

    const list = await (await api(`/fs/list?path=${q(homeDir)}`)).json();
    expect(list.path).toBe(homeDir);
    expect(list.entries.map((e: any) => e.name)).toContain("a.txt");

    expect((await api(`/fs/list?path=${q(tmp)}`)).status).toBe(403);
    expect((await api(`/fs/file?path=${q("/etc/passwd")}`)).status).toBe(403);
    expect((await api(`/fs/list?path=${q(join(homeDir, "missing"))}`)).status).toBe(404);
    expect((await api(`/fs/files?root=${q(homeDir)}`)).status).toBe(200);
  });

  test("POST /sessions checks resume ids and the home folder", async () => {
    const post = (body: object) => api("/sessions", { method: "POST", body: JSON.stringify(body) });
    expect((await post({ dir: homeDir, resume: "$(touch /tmp/x)" })).status).toBe(400);
    expect((await post({ dir: tmp })).status).toBe(403);
    expect((await post({})).status).toBe(400);
  });
});
