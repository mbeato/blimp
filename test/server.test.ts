// Starts a real blimpd on a temp socket and talks to it like the app does, against real zmx sessions.
// Every zmx session made here is named blimptest-* and killed at the end; nothing else is touched.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json";
import { promptFromHook } from "../src/prompt";
import { findChrome } from "../src/browser/chrome";
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

// A zmx session running sh (or cmd). No pipes: the session daemon would inherit them.
async function shSession(suffix: string, cmd = ["sh"]): Promise<string> {
  const name = `${tag}-${suffix}`;
  made.push(name);
  Bun.spawnSync([zmxPath(), "attach", name, ...cmd], { env, cwd: tmp, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
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
// A busy session can be listed as unreachable, with no pid or client count: that's not 0 clients.
const clients = (name: string) => parseZmxList(zmx("list").stdout.toString()).find((s) => s.name === name && s.pid > 0)?.clients;

// POST /sessions runs `$SHELL -l -i -c 'exec claude "$@"' claude`. This stand-in for the login shell
// runs such a script with sh (blimpd's lookup too), after $BLIMP_TEST_PROFILE as a login profile
// when there is one, and is a plain shell that echoes input otherwise. The scripts find the stand-ins for claude and codex
// below, first on PATH: they print the terminal size they were started with, their arguments and
// the GLM settings they got, then echo input, so no real Claude starts.
const fakeShell = join(tmp, "fake-shell");
writeFileSync(
  fakeShell,
  `#!/bin/sh
[ "$1" = -l ] && shift
[ "$1" = -i ] && shift
[ -n "$BLIMP_TEST_PROFILE" ] && [ -f "$BLIMP_TEST_PROFILE" ] && . "$BLIMP_TEST_PROFILE"
[ "$1" = -c ] && shift && exec /bin/sh -c "$@"
echo "fake-shell size=$(stty size)"
exec cat
`,
);
chmodSync(fakeShell, 0o755);
const fakeBin = join(tmp, "bin");
mkdirSync(fakeBin);
for (const cmd of ["claude", "codex"]) {
  writeFileSync(
    join(fakeBin, cmd),
    `#!/bin/sh
echo "fake-${cmd} size=$(stty size)"
echo "args:[$*]"
echo "url=$ANTHROPIC_BASE_URL zaitoken=\${BLIMP_ZAI_TOKEN-unset} window=\${CLAUDE_CODE_MAX_CONTEXT_TOKENS-unset}"
echo "model=$ANTHROPIC_MODEL fast=$ANTHROPIC_DEFAULT_HAIKU_MODEL apikey=\${ANTHROPIC_API_KEY-unset} custom=$CUSTOM_VAR"
[ -n "$ANTHROPIC_AUTH_TOKEN" ] && [ "$ANTHROPIC_AUTH_TOKEN" = "$(cat "$HOME/.config/zai/key")" ] && echo "token=from-key-file"
exec cat
`,
  );
  chmodSync(join(fakeBin, cmd), 0o755);
}

// A stand-in gh: `gh pr list --head <branch> …` lists one pull request naming the folder it ran in and the branch.
writeFileSync(
  join(fakeBin, "gh"),
  `#!/bin/sh
[ "$1 $2 $3" = "pr list --head" ] || exit 1
printf '[{"number":7,"title":"in %s for %s","state":"OPEN","url":"https://github.com/o/r/pull/7"}]\\n' "$(basename "$(pwd)")" "$4"
`,
);
chmodSync(join(fakeBin, "gh"), 0o755);

beforeAll(async () => {
  // No naming here: the stand-in claude above isn't one that answers with a name (see "names").
  writeFileSync(join(tmp, "config.json"), JSON.stringify({ names: false }));
  server = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "main.ts"), "serve"], {
    env: { ...env, SHELL: fakeShell, PATH: `${fakeBin}:${env.PATH}` },
    stdout: "pipe",
    stderr: "inherit",
  });
  await until(() => {
    try {
      return statSync(sock).isSocket() && (token = readFileSync(join(tmp, "token"), "utf8").trim());
    } catch {
      return false;
    }
  }, "blimpd to start");
});

// More than the default 5 s: this many zmx kills one after another take longer.
afterAll(() => {
  server?.kill();
  // --force: a session flooding its terminal (`yes`) is too busy to answer a plain kill, and stayed on.
  for (const name of made) zmx("kill", name, "--force");
  rmSync(tmp, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
}, 30000);

describe("token", () => {
  test("token file is 64 hex chars, readable only by you; socket and folder too", () => {
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(join(tmp, "token")).mode & 0o777).toBe(0o600);
    expect(statSync(sock).mode & 0o777).toBe(0o600);
    expect(statSync(tmp).mode & 0o777).toBe(0o700);
  });

  test("401 without or with a wrong token, CORS only once authorized", async () => {
    const none = await api("/health", {}, false);
    expect(none.status).toBe(401);
    // A readable 401 would tell any web page that this port is blimp.
    expect(none.headers.get("access-control-allow-origin")).toBeNull();
    expect((await api("/health", { headers: { Authorization: "Bearer " + "0".repeat(64) } }, false)).status).toBe(401);
    expect((await api("/sessions?token=nope", {}, false)).status).toBe(401);

    const ok = await api("/health");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe("*");
    expect(await ok.json()).toEqual({ version: pkg.version, home: realpathSync(homedir()) });
  });

  test("preflight needs no token", async () => {
    const r = await api("/sessions", { method: "OPTIONS" }, false);
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-headers")).toBe("Authorization, Content-Type");
    expect(r.headers.get("access-control-allow-methods")).toBe("GET, POST, PUT, DELETE, OPTIONS");
  });
});

describe("phone token", () => {
  const phoneFile = join(tmp, "phone-token");
  const phone = "c0ffee".repeat(10) + "abcd";
  const asPhone = (path: string) => api(path, { headers: { Authorization: `Bearer ${phone}` } }, false);
  const ws = (path: string, t: string) => {
    const w = new WebSocket(`ws+unix://${sock}:${path}?token=${t}`);
    const s = { w, messages: [] as any[], closed: undefined as undefined | { code: number; reason: string } };
    w.onmessage = (e) => s.messages.push(JSON.parse(e.data as string));
    w.onclose = (e) => (s.closed = { code: e.code, reason: e.reason });
    return s;
  };

  test("works for HTTP and a WebSocket; deleted, it's refused at once, open sockets close, the Mac's goes on", async () => {
    writeFileSync(phoneFile, phone + "\n", { mode: 0o600 });
    const ok = await asPhone("/health");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe("*");
    const events = ws("/events", phone);
    await until(() => events.messages.some((m) => m.type === "sessions"), "the phone's events socket");

    rmSync(phoneFile);
    // No restart and no wait: the next request already fails.
    const no = await asPhone("/health");
    expect(no.status).toBe(401);
    expect(no.headers.get("access-control-allow-origin")).toBeNull();
    const refused = ws("/events", phone);
    await until(() => refused.closed, "the refused socket to close");
    expect(refused.messages).toEqual([]);
    // The socket opened before the revoke is closed too.
    await until(() => events.closed, "the open phone socket to close", 3000);
    expect(events.closed!.code).toBe(4001);

    expect((await api("/health")).status).toBe(200);
    const mac = await socket("/events");
    await Bun.sleep(1500); // past the check that closed the phone's socket
    expect(mac.closed).toBeUndefined();
    mac.ws.close();
  });

  test("a Mac socket stays open while a phone token comes and goes", async () => {
    const mac = await socket("/events");
    writeFileSync(phoneFile, phone, { mode: 0o600 });
    await Bun.sleep(1200);
    rmSync(phoneFile);
    await Bun.sleep(1200);
    expect(mac.closed).toBeUndefined();
    mac.ws.close();
  });

  test("an empty or missing phone-token file lets no empty token in", async () => {
    for (const write of [true, false]) {
      if (write) writeFileSync(phoneFile, "\n", { mode: 0o600 });
      expect((await api("/health?token=", {}, false)).status).toBe(401);
      expect((await api("/health", { headers: { Authorization: "Bearer " } }, false)).status).toBe(401);
      const s = ws("/events", "");
      await until(() => s.closed, "the empty-token socket to close");
      expect(s.messages).toEqual([]);
    }
    rmSync(phoneFile, { force: true });
  });
});

test("refuses to start when zmx's socket folder is writable by others", async () => {
  // Whoever can write that folder can swap a session's socket for their own and get what you type.
  const dir = mkdtempSync(join(tmpdir(), "bz"));
  mkdirSync(join(dir, "zmx"));
  chmodSync(join(dir, "zmx"), 0o777);
  const p = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "main.ts"), "serve"], {
    env: { ...env, BLIMPD_SOCKET: join(dir, "s.sock"), ZMX_DIR: join(dir, "zmx") },
    stdout: "pipe",
    stderr: "pipe",
  });
  const killer = setTimeout(() => p.kill(), 3000); // before the test timeout, which would kill the main blimpd too
  const [err, code] = [await new Response(p.stderr).text(), await p.exited];
  clearTimeout(killer);
  rmSync(dir, { recursive: true, force: true });
  expect(code).toBe(1);
  expect(err).toContain(`blimpd: zmx's socket folder ${join(dir, "zmx")} is writable by others`);
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
    await until(() => clients(name) === 0, "zmx clients to detach");
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

  test("closes with 4001 'detached' on ctrl+\\, and the session keeps running", async () => {
    const name = await shSession("d");
    const s = await socket(`/sessions/${name}/attach`);
    type(s.ws, "\x1c");
    await until(() => s.closed, "socket to close");
    expect(s.closed).toEqual({ code: 4001, reason: "detached" });
    expect(zmxNames()).toContain(name);
  });

  test("a client that stops reading is closed with 1013 past 8 MB, and its zmx client is killed", async () => {
    const name = await shSession("flood", ["yes"]);
    // A separate process that upgrades, then blocks its thread (so it reads nothing) until `go` exists.
    // Then it reads on until the close frame and prints its code.
    const go = join(tmp, "go");
    const script = join(tmp, "stalled-client.js");
    writeFileSync(
      script,
      `import { existsSync } from "node:fs";
      const [sock, path, go] = process.argv.slice(2);
      let tail = Buffer.alloc(0), stalled = false;
      await Bun.connect({ unix: sock, socket: {
        open(s) { s.write("GET " + path + " HTTP/1.1\\r\\nHost: blimpd\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\n" +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\\r\\nSec-WebSocket-Version: 13\\r\\n\\r\\n"); },
        data(s, d) {
          if (!stalled) { stalled = true; while (!existsSync(go)) Bun.sleepSync(50); }
          tail = Buffer.concat([tail, d]).subarray(-256);
          // An unmasked close frame at the very end: 0x88, length, 2-byte code, reason.
          for (let i = tail.length - 4; i >= 0; i--)
            if (tail[i] === 0x88 && tail[i + 1] === tail.length - i - 2) { console.log(tail.readUInt16BE(i + 2)); process.exit(0); }
        },
      }});`,
    );
    const child = Bun.spawn(["bun", script, sock, `/sessions/${name}/attach?token=${token}`, go], { stdout: "pipe", stderr: "inherit" });
    try {
      await until(() => clients(name) === 1, "the stalled client to attach");
      await until(() => clients(name) === 0, "blimpd to drop the stalled client", 15000);
      writeFileSync(go, "");
      expect((await new Response(child.stdout).text()).trim()).toBe("1013");
      expect(zmxNames()).toContain(name);
    } finally {
      child.kill();
      zmx("kill", name);
    }
  }, 30000);
});

describe("chat", () => {
  // A stand-in Claude: reads lines, answers `size` with its terminal size, echoes the rest with
  // ESC shown as ~ (zmx draws output through a terminal emulator, which would swallow a raw ESC).
  const LOOP = `while IFS= read -r l; do case "$l" in size) echo "sz=$(stty size)";; *wait-now*) [ -n "$WAIT_FILE" ] && printf %s "$WAIT_JSON" > "$WAIT_FILE"; printf 'got:%s\n' "$(printf %s "$l" | tr '\033' '~')";; ask) printf 'Do you want to proceed?\\n 1. Yes\\n 2. Yes, and always\\n 3. No\\n';; *) printf 'got:%s\\n' "$(printf %s "$l" | tr '\\033' '~')";; esac; done`;
  const claudeDir = join(tmp, "claude");
  const T = new Date().toISOString();
  const tline = (o: object) => JSON.stringify({ timestamp: T, ...o }) + "\n";

  // A session that looks like Claude to blimpd: its pid has a status file naming a transcript.
  async function fakeClaude(suffix: string, sessionId: string, lines: string[]) {
    const name = await shSession(suffix, ["sh", "-c", LOOP]);
    const pid = parseZmxList(zmx("list").stdout.toString()).find((s) => s.name === name)!.pid;
    mkdirSync(join(claudeDir, "sessions"), { recursive: true });
    mkdirSync(join(claudeDir, "projects", "p"), { recursive: true });
    const transcript = join(claudeDir, "projects", "p", `${sessionId}.jsonl`);
    writeFileSync(transcript, lines.join(""));
    writeFileSync(join(claudeDir, "sessions", `${pid}.json`), JSON.stringify({ sessionId, cwd: tmp, status: "idle" }));
    return { name, pid, transcript };
  }
  const user = (uuid: string, text: string) => tline({ type: "user", uuid, message: { role: "user", content: text } });
  const said = (uuid: string, text: string) => tline({ type: "assistant", uuid, message: { role: "assistant", content: [{ type: "text", text }] } });
  // Enter from the viewer until what the chat client typed shows up: under load the chat client's
  // keys can land after the viewer's first Enter.
  const enterUntil = (v: Awaited<ReturnType<typeof socket>>, want: string, what: string) =>
    until(() => (type(v.ws, "\r"), v.text.includes(want)), what);

  test("history on connect, appends as the transcript grows, reset on a new conversation", async () => {
    const sid = "11111111-1111-1111-1111-111111111111";
    const { pid, transcript, name } = await fakeClaude("chat1", sid, [user("u1", "hello"), said("a1", "hi there")]);
    const c = await socket(`/sessions/${name}/chat`);
    await until(() => c.messages.find((m) => m.type === "history"), "history");
    expect(c.messages[0].messages.map((m: any) => [m.role, m.text])).toEqual([["user", "hello"], ["assistant", "hi there"]]);

    appendFileSync(transcript, said("a2", "more"));
    await until(() => c.messages.find((m) => m.type === "append"), "append", 3000);
    expect(c.messages.find((m) => m.type === "append").messages[0].text).toBe("more");

    const sid2 = "22222222-2222-2222-2222-222222222222";
    writeFileSync(join(claudeDir, "projects", "p", `${sid2}.jsonl`), user("u9", "fresh"));
    writeFileSync(join(claudeDir, "sessions", `${pid}.json`), JSON.stringify({ sessionId: sid2, cwd: tmp, status: "idle" }));
    await until(() => c.messages.some((m) => m.type === "reset"), "reset", 4000);
    await until(() => c.messages.filter((m) => m.type === "history").length === 2, "second history");
    expect(c.messages.at(-1).messages.map((m: any) => m.text)).toEqual(["fresh"]);
    c.ws.close();
  });

  test("a reply after blimpd started is unread until an app says it was on screen", async () => {
    const sid = "5eee5eee-5eee-4eee-8eee-5eee5eee5eee";
    // after blimpd's start, unlike T
    const late = (uuid: string, text: string) =>
      JSON.stringify({ timestamp: new Date(Date.now() + 1000).toISOString(), type: "assistant", uuid, message: { role: "assistant", content: [{ type: "text", text }] } }) + "\n";
    const { name, transcript } = await fakeClaude("unread", sid, [user("u1", "hi"), said("a1", "an old reply")]);
    const listed = async () => (await (await api("/sessions")).json()).find((s: any) => s.name === name);
    expect((await listed()).unread).toBe(false);
    appendFileSync(transcript, late("a2", "a new reply"));
    await until(async () => (await listed()).unread === true, "the new reply to be unread");
    const seen = (sessionId: string) => api("/seen", { method: "POST", body: JSON.stringify({ sessionId }) });
    expect((await seen(sid)).status).toBe(204);
    expect((await listed()).unread).toBe(false);
    expect((await seen("not-an-id")).status).toBe(400);
  });

  test("two Claude sessions on the same branch that edited the same file each show the other, with the branch's pull requests", async () => {
    const repo = join(realpathSync(tmp), "work-repo");
    mkdirSync(repo);
    const git = (...args: string[]) => Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, stdout: "ignore", stderr: "ignore" }).exitCode;
    expect(git("init", "-q", "-b", "feat")).toBe(0);
    writeFileSync(join(repo, "a.ts"), "a");
    git("add", ".");
    expect(git("commit", "-q", "-m", "a")).toBe(0);
    const edit = (id: string) => tline({ type: "assistant", cwd: repo, message: { role: "assistant", content: [{ type: "tool_use", id, name: "Edit", input: { file_path: join(repo, "a.ts") } }] } });
    const a = await fakeClaude("work1", "8a8a8a8a-8a8a-4a8a-8a8a-8a8a8a8a8a8a", [user("u1", "fix a"), edit("t1")]);
    const b = await fakeClaude("work2", "8b8b8b8b-8b8b-4b8b-8b8b-8b8b8b8b8b8b", [user("u1", "also fix a"), edit("t2")]);
    const listed = async (name: string) => (await (await api("/sessions")).json()).find((s: any) => s.name === name);
    const work = await until(async () => {
      const w = (await listed(a.name)).work;
      return w?.prs && w.clash && w;
    }, "the checkout, pull requests and clash", 10000);
    expect(work).toEqual({
      branch: "feat",
      root: repo,
      prs: [{ number: 7, title: "in work-repo for feat", state: "OPEN", url: "https://github.com/o/r/pull/7" }],
      clash: [{ session: b.name, reason: "branch" }, { session: b.name, reason: "files", files: ["a.ts"] }],
    });
    expect((await listed(b.name)).work.clash).toEqual([{ session: a.name, reason: "branch" }, { session: a.name, reason: "files", files: ["a.ts"] }]);
    // The files Claude edited stay on the server.
    expect(JSON.stringify(await (await api("/sessions")).json())).not.toContain('"files":[{');
  });

  test("GET /conversations/<id>/messages: a past conversation's messages, without starting Claude", async () => {
    const sid = "6eee6eee-6eee-4eee-8eee-6eee6eee6eee";
    const dir = join(homeDir, "past");
    mkdirSync(dir, { recursive: true });
    const folder = join(claudeDir, "projects", dir.replace(/[^A-Za-z0-9]/g, "-"));
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, `${sid}.jsonl`), user("u1", "fix the login") + said("a1", "fixed"));
    const get = (id: string, d: string) => api(`/conversations/${id}/messages?dir=${encodeURIComponent(d)}`);
    const r = await get(sid, dir);
    expect(r.status).toBe(200);
    expect((await r.json()).map((m: any) => [m.role, m.text])).toEqual([["user", "fix the login"], ["assistant", "fixed"]]);
    expect((await get("7eee7eee-7eee-4eee-8eee-7eee7eee7eee", dir)).status).toBe(404);
    expect((await get(sid, tmp)).status).toBe(403);
    expect((await api(`/conversations/${sid}/messages`)).status).toBe(400);
  });

  test("history of a long transcript is its last 200 messages", async () => {
    const lines = Array.from({ length: 3000 }, (_, i) => (i % 2 ? said(`a${i}`, `answer ${i}`) : user(`u${i}`, `prompt ${i}`)));
    const { name } = await fakeClaude("chat10", "99999999-9999-9999-9999-999999999999", lines);
    const c = await socket(`/sessions/${name}/chat`);
    const h = await until(() => c.messages.find((m) => m.type === "history"), "history");
    expect(h.messages.map((m: any) => m.id)).toEqual(Array.from({ length: 200 }, (_, i) => (i % 2 ? `a${2800 + i}#0` : `u${2800 + i}`)));
    c.ws.close();
  });

  test("input is typed as a paste plus Enter, once per id, at the viewer's size", async () => {
    const { name } = await fakeClaude("chat2", "33333333-3333-3333-3333-333333333333", []);
    const viewer = await socket(`/sessions/${name}/attach?cols=101&rows=33`);
    const c = await socket(`/sessions/${name}/chat`);
    await until(() => c.messages.find((m) => m.type === "history"), "history");
    c.ws.send(JSON.stringify({ type: "input", id: "m1", text: "hel\x1blo\nworld" }));
    await until(() => c.messages.find((m) => m.type === "ack" && m.id === "m1"), "ack");
    // ESC is stripped from the text, the paste markers wrap it, and the newline stays inside the paste.
    await until(() => viewer.text.includes("got:~[200~hello"), "pasted text reached the session");
    c.ws.send(JSON.stringify({ type: "input", id: "m1", text: "again" }));
    await until(() => c.messages.filter((m) => m.type === "ack" && m.id === "m1").length === 2, "second ack");
    await Bun.sleep(300);
    expect(viewer.text).not.toContain("again");
    // The chat client attached at the viewer's size, so the session's size is unchanged.
    type(viewer.ws, "size\r");
    await until(() => viewer.text.includes("sz=33 101"), "size unchanged");
    c.ws.close();
    viewer.ws.close();
  });

  test("answer presses the option's key while that prompt is up; a stale one is refused", async () => {
    const { name } = await fakeClaude("chat3", "44444444-4444-4444-4444-444444444444", []);
    const at = Date.now();
    mkdirSync(join(tmp, "status"), { recursive: true });
    writeFileSync(
      join(tmp, "status", `${name}.json`),
      JSON.stringify({ state: "waiting", at, sessionId: "44444444-4444-4444-4444-444444444444", event: "PermissionRequest",
        prompt: { kind: "permission", tool: "Bash", summary: "Ran `ls`", options: ["Yes", "No"], keys: ["1", "\x1b"], answerable: true } }),
    );
    const viewer = await socket(`/sessions/${name}/attach?cols=80&rows=24`);
    const c = await socket(`/sessions/${name}/chat`);
    await until(() => c.messages.find((m) => m.type === "history"), "history");
    c.ws.send(JSON.stringify({ type: "answer", id: "q1", at: at - 1, pick: 0, label: "Yes" }));
    await until(() => c.messages.find((m) => m.id === "q1"), "reply");
    expect(c.messages.find((m) => m.id === "q1")).toEqual({ type: "error", id: "q1", error: "the question changed" });
    c.ws.send(JSON.stringify({ type: "answer", id: "q0", at, pick: 0 })); // no label: not knowing what was shown, nothing is pressed
    await until(() => c.messages.find((m) => m.id === "q0"), "reply");
    expect(c.messages.find((m) => m.id === "q0")).toEqual({ type: "error", id: "q0", error: "the question changed" });
    c.ws.send(JSON.stringify({ type: "answer", id: "q2", at, pick: 0, label: "Yes" }));
    await until(() => c.messages.find((m) => m.type === "ack" && m.id === "q2"), "ack");
    await enterUntil(viewer, "got:1", "the digit reached the session");
    c.ws.close();
    viewer.ws.close();
  });

  test("an answer to options that changed under the same wait is refused", async () => {
    // The hook can fire before Claude draws its dialog: the phone first sees the fallback Yes/No, then
    // the screen's options, with the same `at`. Pick 1 was "No"; on the screen it is "Yes, and always".
    const sid = "dededede-dede-dede-dede-dededededede";
    const { name } = await fakeClaude("chat15", sid, []);
    const at = Date.now();
    mkdirSync(join(tmp, "status"), { recursive: true });
    writeFileSync(
      join(tmp, "status", `${name}.json`),
      JSON.stringify({ state: "waiting", at, sessionId: sid, event: "PermissionRequest",
        prompt: { kind: "permission", tool: "Bash", summary: "Ran `ls`", options: ["Yes", "No"], keys: ["1", "\x1b"], answerable: true } }),
    );
    const options = async () => ((await (await api("/sessions")).json()) as any[]).find((s) => s.name === name)?.prompt?.options;
    expect(await options()).toEqual(["Yes", "No"]);
    const viewer = await socket(`/sessions/${name}/attach?cols=80&rows=24`);
    type(viewer.ws, "ask\r");
    await until(async () => (await options())?.length === 3, "the options on screen", 1500);
    const c = await socket(`/sessions/${name}/chat`);
    await until(() => c.messages.find((m) => m.type === "history"), "history");
    c.ws.send(JSON.stringify({ type: "answer", id: "n1", at, pick: 1, label: "No" }));
    await until(() => c.messages.find((m) => m.id === "n1"), "reply");
    expect(c.messages.find((m) => m.id === "n1")).toEqual({ type: "error", id: "n1", error: "the question changed" });
    type(viewer.ws, "\r");
    await Bun.sleep(500);
    expect(viewer.text).not.toContain("got:2");
    c.ws.send(JSON.stringify({ type: "answer", id: "n2", at, pick: 2, label: "No" }));
    await until(() => c.messages.find((m) => m.type === "ack" && m.id === "n2"), "ack");
    await enterUntil(viewer, "got:3", "the digit for No reached the session");
    c.ws.close();
    viewer.ws.close();
  });

  test("input is refused while Claude is asking something, and typed once it isn't", async () => {
    const sid = "abababab-abab-abab-abab-abababababab";
    const { name } = await fakeClaude("chat14", sid, []);
    mkdirSync(join(tmp, "status"), { recursive: true });
    const status = join(tmp, "status", `${name}.json`);
    writeFileSync(
      status,
      JSON.stringify({ state: "waiting", at: Date.now(), sessionId: sid, event: "PermissionRequest",
        prompt: { kind: "permission", tool: "Bash", summary: "Ran `ls`", options: ["Yes", "No"], keys: ["1", "\x1b"], answerable: true } }),
    );
    const viewer = await socket(`/sessions/${name}/attach?cols=80&rows=24`);
    const c = await socket(`/sessions/${name}/chat`);
    await until(() => c.messages.find((m) => m.type === "history"), "history");
    c.ws.send(JSON.stringify({ type: "input", id: "w1", text: "typed while waiting" }));
    await until(() => c.messages.find((m) => m.id === "w1"), "reply");
    expect(c.messages.find((m) => m.id === "w1")).toEqual({ type: "error", id: "w1", error: "Claude is asking something. Answer it first." });
    type(viewer.ws, "\r");
    await Bun.sleep(500);
    expect(viewer.text).not.toContain("typed while waiting");
    // The refused id wasn't counted as typed: once the wait is over, the same id goes through.
    rmSync(status);
    c.ws.send(JSON.stringify({ type: "input", id: "w1", text: "typed while waiting" }));
    await until(() => c.messages.find((m) => m.type === "ack" && m.id === "w1"), "ack", 4000);
    await enterUntil(viewer, "typed while waiting", "the text reached the session");
    c.ws.close();
    viewer.ws.close();
  });

  test("blimpd send types a message into another session, saying which one it's from; not while it's asking", async () => {
    const sid = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
    const { name, transcript } = await fakeClaude("send1", sid, []);
    // The list says where its conversation is, for another session to read.
    expect((await (await api("/sessions")).json()).find((s: any) => s.name === name).transcript).toBe(transcript);
    const viewer = await socket(`/sessions/${name}/attach?cols=200&rows=24`);
    const send = async (args: string[], from?: string) => {
      const p = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "main.ts"), "send", ...args], { env: { ...env, ZMX_SESSION: from }, stdout: "pipe", stderr: "pipe" });
      return { code: await p.exited, out: await new Response(p.stdout).text(), err: await new Response(p.stderr).text() };
    };
    const ok = await send([name, "hello", "there"], "blimp-other");
    expect([ok.code, ok.out.trim()]).toEqual([0, `sent to ${name}`]);
    await enterUntil(viewer, "hello there", "the message reached the session");
    expect(viewer.text).toContain(`[from blimp session blimp-other; reply with: blimpd send blimp-other "<message>"]`);
    // Not while Claude asks something, as from the phone.
    mkdirSync(join(tmp, "status"), { recursive: true });
    const status = join(tmp, "status", `${name}.json`);
    writeFileSync(status, JSON.stringify({ state: "waiting", at: Date.now(), sessionId: sid, event: "PermissionRequest",
      prompt: { kind: "permission", tool: "Bash", summary: "Ran `ls`", options: ["Yes", "No"], keys: ["1", "\x1b"], answerable: true } }));
    const busy = await send([name, "not now"]);
    expect([busy.code, busy.err.trim()]).toEqual([1, "blimpd send: Claude is asking something. Answer it first."]);
    rmSync(status);
    const none = await send([`${tag}-nope`, "hi"]);
    expect([none.code, none.err.trim()]).toEqual([1, `blimpd send: no session named ${tag}-nope`]);
    viewer.ws.close();
  });

  test("input whose paste starts a question gets no Enter", async () => {
    // The stand-in starts waiting as soon as it reads the paste's first line: the check before the
    // paste passes, the one before Enter doesn't.
    const sid = "efefefef-efef-efef-efef-efefefefefef";
    mkdirSync(join(tmp, "status"), { recursive: true });
    const status = join(tmp, "status", `${tag}-chat16.json`);
    const wait = JSON.stringify({ state: "waiting", at: Date.now() + 60_000, sessionId: sid, event: "PermissionRequest",
      prompt: { kind: "permission", tool: "Bash", summary: "Ran `ls`", options: ["Yes", "No"], keys: ["1", "\x1b"], answerable: true } });
    const name = await shSession("chat16", ["env", `WAIT_FILE=${status}`, `WAIT_JSON=${wait}`, "sh", "-c", LOOP]);
    const pid = parseZmxList(zmx("list").stdout.toString()).find((s) => s.name === name)!.pid;
    mkdirSync(join(claudeDir, "sessions"), { recursive: true });
    mkdirSync(join(claudeDir, "projects", "p"), { recursive: true });
    writeFileSync(join(claudeDir, "projects", "p", `${sid}.jsonl`), "");
    writeFileSync(join(claudeDir, "sessions", `${pid}.json`), JSON.stringify({ sessionId: sid, cwd: tmp, status: "idle" }));
    const viewer = await socket(`/sessions/${name}/attach?cols=80&rows=24`);
    const c = await socket(`/sessions/${name}/chat`);
    await until(() => c.messages.find((m) => m.type === "history"), "history");
    c.ws.send(JSON.stringify({ type: "input", id: "e1", text: "wait-now\nrest of it" }));
    await until(() => c.messages.find((m) => m.id === "e1"), "reply");
    expect(c.messages.find((m) => m.id === "e1")).toEqual({ type: "error", id: "e1", error: "Claude is asking something. Answer it first." });
    await until(() => viewer.text.includes("got:~[200~wait-now"), "the paste's first line");
    await Bun.sleep(500);
    expect(viewer.text).not.toContain("got:rest of it"); // the paste's last line, still waiting for Enter
    c.ws.close();
    viewer.ws.close();
  });

  test("interrupt sends Esc", async () => {
    const { name } = await fakeClaude("chat4", "55555555-5555-5555-5555-555555555555", []);
    const viewer = await socket(`/sessions/${name}/attach?cols=80&rows=24`);
    const c = await socket(`/sessions/${name}/chat`);
    await until(() => c.messages.find((m) => m.type === "history"), "history");
    c.ws.send(JSON.stringify({ type: "interrupt", id: "i1" }));
    await until(() => c.messages.find((m) => m.type === "ack" && m.id === "i1"), "ack");
    await enterUntil(viewer, "got:~", "Esc reached the session");
    c.ws.close();
    viewer.ws.close();
  });

  test("a session that isn't Claude is unreadable and takes no input; an ended one closes with 4000", async () => {
    const name = await shSession("chat5");
    const c = await socket(`/sessions/${name}/chat`);
    await until(() => c.messages.find((m) => m.type === "unreadable"), "unreadable");
    c.ws.send(JSON.stringify({ type: "input", id: "x", text: "ls" }));
    await until(() => c.messages.find((m) => m.id === "x"), "reply");
    expect(c.messages.find((m) => m.id === "x").type).toBe("error");
    zmx("kill", name);
    await until(() => c.closed, "socket to close", 5000);
    expect(c.closed?.code).toBe(4000);
  });

  test("a transcript that doesn't exist yet starts as an empty history, then its messages are appended", async () => {
    const sid = "66666666-6666-6666-6666-666666666666";
    const { transcript, name } = await fakeClaude("chat6", sid, [user("u1", "first")]);
    rmSync(transcript);
    const c = await socket(`/sessions/${name}/chat`);
    await until(() => c.messages.find((m) => m.type === "history"), "history");
    expect(c.messages.find((m) => m.type === "history").messages).toEqual([]);
    expect(c.messages.some((m) => m.type === "unreadable")).toBe(false);
    writeFileSync(transcript, user("u1", "first"));
    await until(() => c.messages.find((m) => m.type === "append"), "append", 4000);
    expect(c.messages.find((m) => m.type === "append").messages.map((m: any) => m.text)).toEqual(["first"]);
    c.ws.close();
  });

  test("two inputs sent back to back are typed one after the other", async () => {
    const { name } = await fakeClaude("chat7", "77777777-7777-7777-7777-777777777777", []);
    const viewer = await socket(`/sessions/${name}/attach?cols=80&rows=24`);
    const c = await socket(`/sessions/${name}/chat`);
    await until(() => c.messages.find((m) => m.type === "history"), "history");
    c.ws.send(JSON.stringify({ type: "input", id: "a", text: "one" }));
    c.ws.send(JSON.stringify({ type: "input", id: "b", text: "two" }));
    await until(() => c.messages.filter((m) => m.type === "ack").length === 2, "both acks");
    await until(() => viewer.text.includes("got:~[200~one~[201~") && viewer.text.includes("got:~[200~two~[201~"), "two separate lines");
    c.ws.close();
    viewer.ws.close();
  });

  test("a repeated interrupt id types one Esc", async () => {
    const { name } = await fakeClaude("chat8", "88888888-8888-8888-8888-888888888888", []);
    const viewer = await socket(`/sessions/${name}/attach?cols=80&rows=24`);
    const c = await socket(`/sessions/${name}/chat`);
    await until(() => c.messages.find((m) => m.type === "history"), "history");
    c.ws.send(JSON.stringify({ type: "interrupt", id: "i1" }));
    c.ws.send(JSON.stringify({ type: "interrupt", id: "i1" }));
    await until(() => c.messages.filter((m) => m.type === "ack" && m.id === "i1").length === 2, "both acks");
    await enterUntil(viewer, "got:~", "Esc reached the session");
    await Bun.sleep(300);
    expect(viewer.text).not.toContain("got:~~");
    c.ws.close();
    viewer.ws.close();
  });

  test("control characters are taken out of input: ctrl+\\ doesn't detach the chat client, ctrl+C isn't pressed", async () => {
    const { name } = await fakeClaude("chat11", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", []);
    const viewer = await socket(`/sessions/${name}/attach?cols=80&rows=24`);
    const c = await socket(`/sessions/${name}/chat`);
    await until(() => c.messages.find((m) => m.type === "history"), "history");
    c.ws.send(JSON.stringify({ type: "input", id: "k1", text: "a\x1cb\x03c\x7f\x9b\x00d\te\r\nf\rg" }));
    await until(() => c.messages.find((m) => m.type === "ack" && m.id === "k1"), "ack");
    // \r\n and a lone \r are newlines, so they stay inside the paste; tab stays.
    await until(() => viewer.text.includes("got:~[200~abcd\te") && viewer.text.includes("got:f") && viewer.text.includes("got:g~[201~"), "the text without them");
    await Bun.sleep(300);
    expect(clients(name)).toBe(2); // the viewer and the chat client
    c.ws.send(JSON.stringify({ type: "input", id: "k2", text: "still here" }));
    await until(() => viewer.text.includes("got:~[200~still here~[201~"), "the next input through the same client");
    expect(clients(name)).toBe(2);
    c.ws.close();
    viewer.ws.close();
  });

  test("input sent just before the socket closes is still typed", async () => {
    const { name } = await fakeClaude("chat12", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", []);
    const viewer = await socket(`/sessions/${name}/attach?cols=80&rows=24`);
    const c = await socket(`/sessions/${name}/chat`);
    await until(() => c.messages.find((m) => m.type === "history"), "history");
    c.ws.send(JSON.stringify({ type: "input", id: "z1", text: "last words" }));
    c.ws.close();
    await until(() => viewer.text.includes("got:~[200~last words~[201~"), "the line reached the session");
    await until(() => clients(name) === 1, "the chat client to go");
    viewer.ws.close();
  });

  test("a Stop queued behind an input when the socket closes is still sent", async () => {
    // The phone's link drops right after Stop: the input is still being typed (a new client waits for
    // zmx to attach it), so Stop waits its turn, and the socket closes before it starts.
    const { name } = await fakeClaude("chat17", "bdbdbdbd-bdbd-bdbd-bdbd-bdbdbdbdbdbd", []);
    const viewer = await socket(`/sessions/${name}/attach?cols=80&rows=24`);
    const c = await socket(`/sessions/${name}/chat`);
    await until(() => c.messages.find((m) => m.type === "history"), "history");
    c.ws.send(JSON.stringify({ type: "input", id: "q1", text: "before stop" }));
    c.ws.send(JSON.stringify({ type: "interrupt", id: "q2" }));
    c.ws.close();
    await until(() => viewer.text.includes("got:~[200~before stop~[201~"), "the input reached the session");
    await enterUntil(viewer, "got:~\r", "Stop's Esc reached the session");
    await until(() => clients(name) === 1, "the chat client to go");
    viewer.ws.close();
  });

  test("the same input id sent on two sockets at once is typed once", async () => {
    const { name } = await fakeClaude("chat13", "cccccccc-cccc-cccc-cccc-cccccccccccc", []);
    const viewer = await socket(`/sessions/${name}/attach?cols=80&rows=24`);
    const c1 = await socket(`/sessions/${name}/chat`);
    const c2 = await socket(`/sessions/${name}/chat`);
    await until(() => c1.messages.find((m) => m.type === "history") && c2.messages.find((m) => m.type === "history"), "history");
    c1.ws.send(JSON.stringify({ type: "input", id: "d1", text: "only once" }));
    c2.ws.send(JSON.stringify({ type: "input", id: "d1", text: "only once" }));
    await until(() => c1.messages.find((m) => m.type === "ack") && c2.messages.find((m) => m.type === "ack"), "both acks");
    await until(() => viewer.text.includes("got:~[200~only once~[201~"), "the line reached the session");
    await Bun.sleep(300);
    expect(viewer.text.split("~[200~only once").length - 1).toBe(1); // as the stand-in prints it, not the echo
    c1.ws.close();
    c2.ws.close();
    viewer.ws.close();
  });

  test("a permission prompt's options come from the screen, even when the hook fires before it's drawn", async () => {
    const name = await shSession("chat9");
    const at = Date.now();
    mkdirSync(join(tmp, "status"), { recursive: true });
    writeFileSync(
      join(tmp, "status", `${name}.json`),
      JSON.stringify({ state: "waiting", at, event: "PermissionRequest",
        prompt: { kind: "permission", tool: "Bash", summary: "Ran `ls`", options: ["Yes", "No"], keys: ["1", "\x1b"], answerable: true } }),
    );
    const options = async () => ((await (await api("/sessions")).json()) as any[]).find((s) => s.name === name)?.prompt?.options;
    expect(await options()).toEqual(["Yes", "No"]); // nothing on screen yet
    const viewer = await socket(`/sessions/${name}/attach?cols=80&rows=24`);
    type(viewer.ws, "printf 'Do you want to proceed?\\n 1. Yes\\n 2. Yes, and always\\n 3. No\\n'\r");
    await until(async () => (await options())?.length === 3, "the options on screen", 1500);
    expect(await options()).toEqual(["Yes", "Yes, and always", "No"]);
    viewer.ws.close();
  });

  // A stand-in for Claude's question dialog (ios/e2e/fake-ask.ts), waiting on it as the hook would say.
  async function fakeAsk(suffix: string, sessionId: string, questions: object[]) {
    const dir = join(tmp, `ask-${suffix}`);
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(tmp, "status"), { recursive: true });
    const status = join(tmp, "status", `${tag}-${suffix}.json`);
    const cfg = { questions, keys: join(dir, "keys"), answers: join(dir, "answers.json"), status, sessionId };
    writeFileSync(join(dir, "cfg.json"), JSON.stringify(cfg));
    writeFileSync(cfg.keys, "");
    const name = await shSession(suffix, [process.execPath, join(import.meta.dir, "..", "ios", "e2e", "fake-ask.ts"), join(dir, "cfg.json")]);
    const pid = parseZmxList(zmx("list").stdout.toString()).find((s) => s.name === name)!.pid;
    mkdirSync(join(claudeDir, "sessions"), { recursive: true });
    mkdirSync(join(claudeDir, "projects", "p"), { recursive: true });
    writeFileSync(join(claudeDir, "projects", "p", `${sessionId}.jsonl`), "");
    writeFileSync(join(claudeDir, "sessions", `${pid}.json`), JSON.stringify({ sessionId, cwd: tmp, status: "idle" }));
    const at = Date.now();
    const prompt = promptFromHook({ hook_event_name: "PermissionRequest", tool_name: "AskUserQuestion", tool_input: { questions } });
    writeFileSync(status, JSON.stringify({ state: "waiting", at, sessionId, event: "PermissionRequest", prompt }));
    await until(() => zmx("history", name).stdout.toString().includes("Chat about this"), "the dialog on screen");
    return { name, at, cfg };
  }
  const QS = [
    { question: "Which database?", header: "Database", multiSelect: false, options: [{ label: "Postgres", description: "a server" }, { label: "SQLite", description: "a file" }] },
    { question: "Which checks should run?", header: "Checks", multiSelect: true, options: [{ label: "Lint" }, { label: "Unit tests" }, { label: "E2E" }] },
  ];

  test("answer with answers types every question's keys, each after the screen shows its place", async () => {
    const { name, at, cfg } = await fakeAsk("ask1", "a5a5a5a5-a5a5-a5a5-a5a5-a5a5a5a5a5a5", QS);
    const c = await socket(`/sessions/${name}/chat`);
    await until(() => c.messages.find((m) => m.type === "history"), "history");
    const answers = [{ picks: [1] }, { picks: [0, 2], text: "smoke\x1b[A test" }];
    c.ws.send(JSON.stringify({ type: "answer", id: "x0", at, answers, labels: [["Postgres"], ["Lint", "E2E"]] }));
    await until(() => c.messages.find((m) => m.id === "x0"), "reply");
    expect(c.messages.find((m) => m.id === "x0")).toEqual({ type: "error", id: "x0", error: "the question changed" });
    c.ws.send(JSON.stringify({ type: "answer", id: "x1", at, answers, labels: [["SQLite"], ["Lint", "E2E"]] }));
    await until(() => c.messages.find((m) => m.id === "x1"), "reply", 15000);
    expect(c.messages.find((m) => m.id === "x1")).toEqual({ type: "ack", id: "x1" });
    await until(() => existsSync(cfg.answers), "the answers");
    expect(JSON.parse(readFileSync(cfg.answers, "utf8"))).toEqual({ "Which database?": "SQLite", "Which checks should run?": "Lint, E2E, smoke[A test" });
    // What real Claude needs (the probe): a digit picks and moves on; digits tick, ↓ to the text row, the
    // paste, ↓ to Submit, Enter; 1 on the review screen.
    expect(readFileSync(cfg.keys, "utf8")).toBe("2" + "1" + "3" + "\x1b[B".repeat(3) + "\x1b[200~smoke[A test\x1b[201~" + "\x1b[B" + "\r" + "1");
    c.ws.close();
  }, 20000);

  test("an answer stops, typing nothing more, when the screen isn't where it expects", async () => {
    const { name, at, cfg } = await fakeAsk("ask2", "a6a6a6a6-a6a6-a6a6-a6a6-a6a6a6a6a6a6", [QS[1], QS[0]]);
    const viewer = await socket(`/sessions/${name}/attach?cols=100&rows=30`);
    type(viewer.ws, "1"); // someone on the Mac ticked Lint
    await until(() => zmx("history", name).stdout.toString().includes("[✔] Lint"), "the tick on screen");
    const c = await socket(`/sessions/${name}/chat`);
    await until(() => c.messages.find((m) => m.type === "history"), "history");
    c.ws.send(JSON.stringify({ type: "answer", id: "y1", at, answers: [{ picks: [1] }, { picks: [0] }], labels: [["Unit tests"], ["Postgres"]] }));
    await until(() => c.messages.find((m) => m.id === "y1"), "reply", 10000);
    expect(c.messages.find((m) => m.id === "y1")).toEqual({ type: "error", id: "y1", error: "stopped: Claude's screen didn't show question 1 as expected. Finish it on the Mac." });
    expect(readFileSync(cfg.keys, "utf8")).toBe("1"); // only the viewer's
    c.ws.close();
    viewer.ws.close();
  }, 20000);

  test("a pick for a question with previews moves the cursor there, then presses Enter, even after the Mac moved it", async () => {
    const preview = (l: string) => `+-----+\n| ${l} |\n+-----+`;
    const qs = [{ question: "Pick a layout?", header: "Layout", multiSelect: false, options: ["Alpha", "Beta", "Gamma"].map((label) => ({ label, preview: preview(label) })) }];
    const { name, at, cfg } = await fakeAsk("ask3", "a7a7a7a7-a7a7-a7a7-a7a7-a7a7a7a7a7a7", qs);
    const viewer = await socket(`/sessions/${name}/attach?cols=100&rows=30`);
    type(viewer.ws, "3"); // someone on the Mac looked at Gamma's preview
    await until(() => zmx("history", name).stdout.toString().includes("❯ 3. Gamma"), "the cursor on Gamma");
    const c = await socket(`/sessions/${name}/chat`);
    await until(() => c.messages.find((m) => m.type === "history"), "history");
    c.ws.send(JSON.stringify({ type: "answer", id: "v1", at, pick: 1, label: "Beta" }));
    await until(() => c.messages.find((m) => m.id === "v1"), "reply", 10000);
    expect(c.messages.find((m) => m.id === "v1")).toEqual({ type: "ack", id: "v1" });
    await until(() => existsSync(cfg.answers), "the answers");
    expect(JSON.parse(readFileSync(cfg.answers, "utf8"))).toEqual({ "Pick a layout?": "Beta" });
    expect(readFileSync(cfg.keys, "utf8")).toBe("3" + "2" + "\r");
    c.ws.close();
    viewer.ws.close();
  }, 20000);

  test("interrupt with at dismisses that question with Esc, and only while it's up", async () => {
    const { name, at, cfg } = await fakeAsk("ask4", "a8a8a8a8-a8a8-a8a8-a8a8-a8a8a8a8a8a8", [QS[0]]);
    const c = await socket(`/sessions/${name}/chat`);
    await until(() => c.messages.find((m) => m.type === "history"), "history");
    c.ws.send(JSON.stringify({ type: "interrupt", id: "d0", at: at - 1 }));
    await until(() => c.messages.find((m) => m.id === "d0"), "reply");
    expect(c.messages.find((m) => m.id === "d0")).toEqual({ type: "error", id: "d0", error: "the question changed" });
    c.ws.send(JSON.stringify({ type: "interrupt", id: "d1", at }));
    await until(() => c.messages.find((m) => m.id === "d1"), "reply", 10000);
    expect(c.messages.find((m) => m.id === "d1")).toEqual({ type: "ack", id: "d1" });
    await until(() => zmx("history", name).stdout.toString().includes("User declined to answer questions"), "the dialog dismissed");
    expect(readFileSync(cfg.keys, "utf8").replace("\x1b[200~\x1b[201~", "")).toBe("\x1b"); // a fresh client's Esc goes after an empty paste
    c.ws.send(JSON.stringify({ type: "interrupt", id: "d2", at })); // dismissed already: no Esc for Claude's work
    await until(() => c.messages.find((m) => m.id === "d2"), "reply");
    expect(c.messages.find((m) => m.id === "d2")).toEqual({ type: "error", id: "d2", error: "the question changed" });
    c.ws.close();
  }, 20000);

  // A stand-in for Claude's folder trust question (ios/e2e/fake-trust.ts): Claude Code just started in a new
  // folder, with no status file yet. Yes makes it write one, as Claude does; No ends it.
  async function fakeTrust(suffix: string, sessionId: string) {
    const dir = join(tmp, `trust-${suffix}`);
    mkdirSync(dir, { recursive: true });
    const cfg = { folder: dir, keys: join(dir, "keys"), claudeDir, sessionId };
    writeFileSync(join(dir, "cfg.json"), JSON.stringify(cfg));
    writeFileSync(cfg.keys, "");
    // Started as Claude Code (blimpd's record of kinds), so its screen is read until it has a conversation.
    const memo = join(tmp, "session-kinds.json");
    writeFileSync(memo, JSON.stringify({ ...(existsSync(memo) ? JSON.parse(readFileSync(memo, "utf8")) : {}), [`${tag}-${suffix}`]: "claude" }));
    const name = await shSession(suffix, [process.execPath, join(import.meta.dir, "..", "ios", "e2e", "fake-trust.ts"), join(dir, "cfg.json")]);
    await until(() => zmx("history", name).stdout.toString().includes("Enter to confirm"), "the question on screen");
    return { name, cfg };
  }
  const listed = async (name: string) => ((await (await api("/sessions")).json()) as any[]).find((s) => s.name === name);

  test("Claude's folder trust question is a prompt; Yes through the chat is ↓ then Enter, each once the screen shows its place", async () => {
    const sid = "c1c1c1c1-c1c1-c1c1-c1c1-c1c1c1c1c1c1";
    const { name, cfg } = await fakeTrust("trust1", sid);
    const s = await until(async () => ((await listed(name))?.prompt ? listed(name) : undefined), "the trust prompt", 10000);
    expect(s.state).toBe("waiting");
    expect(s.sessionId).toBeUndefined();
    expect(s.prompt).toEqual({ kind: "trust", folder: cfg.folder, options: ["Yes, I trust this folder", "No, exit"], answerable: true, at: s.created * 1000 });
    expect(s.stateSince).toBe(s.created * 1000);

    const c = await socket(`/sessions/${name}/chat`);
    // No conversation yet: an empty one, as for a new session
    await until(() => c.messages.find((m) => m.type === "history"), "history");
    expect(c.messages.find((m) => m.type === "history").messages).toEqual([]);
    c.ws.send(JSON.stringify({ type: "input", id: "t0", text: "hello" }));
    await until(() => c.messages.find((m) => m.id === "t0"), "reply");
    expect(c.messages.find((m) => m.id === "t0")).toEqual({ type: "error", id: "t0", error: "Claude is asking something. Answer it first." });
    c.ws.send(JSON.stringify({ type: "interrupt", id: "t00" })); // Esc would end Claude here
    await until(() => c.messages.find((m) => m.id === "t00"), "reply");
    expect(c.messages.find((m) => m.id === "t00")).toEqual({ type: "error", id: "t00", error: "open this session on the Mac" });
    c.ws.send(JSON.stringify({ type: "answer", id: "t1", at: s.prompt.at, pick: 0, label: "No, exit" }));
    await until(() => c.messages.find((m) => m.id === "t1"), "reply");
    expect(c.messages.find((m) => m.id === "t1")).toEqual({ type: "error", id: "t1", error: "the question changed" });
    c.ws.send(JSON.stringify({ type: "answer", id: "t2", at: s.prompt.at, pick: 0, label: "Yes, I trust this folder" }));
    await until(() => c.messages.find((m) => m.id === "t2"), "reply", 10000);
    expect(c.messages.find((m) => m.id === "t2")).toEqual({ type: "ack", id: "t2" });
    // The empty paste a new zmx client sends before an ESC (chatsocket.ts), then ↓ and Enter
    expect(readFileSync(cfg.keys, "utf8")).toBe("\x1b[200~\x1b[201~" + "\x1b[B" + "\r");

    // Claude starts: its status file names the conversation, and the chat goes on as for any new session.
    const after = await until(async () => ((await listed(name))?.sessionId ? listed(name) : undefined), "the session id", 3000);
    expect(after.prompt).toBeUndefined();
    expect(after.state).toBe("done");
    await until(() => c.messages.some((m) => m.type === "reset"), "reset", 4000);
    await until(() => c.messages.filter((m) => m.type === "history").length === 2, "the conversation's history");
    expect(c.messages.at(-1)).toEqual({ type: "history", messages: [] });
    c.ws.close();
  }, 20000);

  test("a trust answer stops, typing nothing, when the cursor isn't where it expects; No is Enter", async () => {
    const { name, cfg } = await fakeTrust("trust2", "c2c2c2c2-c2c2-c2c2-c2c2-c2c2c2c2c2c2");
    const s = await until(async () => ((await listed(name))?.prompt ? listed(name) : undefined), "the trust prompt", 10000);
    // Someone on the Mac moved the cursor to Yes (again until it shows: zmx can drop a new client's first ESC)
    const viewer = await socket(`/sessions/${name}/attach?cols=120&rows=36`);
    await until(() => (type(viewer.ws, "\x1b[B"), zmx("history", name).stdout.toString().includes("❯ Yes")), "the cursor on Yes");
    const typed = readFileSync(cfg.keys, "utf8");
    const c = await socket(`/sessions/${name}/chat`);
    await until(() => c.messages.find((m) => m.type === "history"), "history");
    c.ws.send(JSON.stringify({ type: "answer", id: "u1", at: s.prompt.at, pick: 1, label: "No, exit" }));
    await until(() => c.messages.find((m) => m.id === "u1"), "reply", 10000);
    expect(c.messages.find((m) => m.id === "u1")).toEqual({ type: "error", id: "u1", error: "stopped: Claude's screen didn't show the folder trust question as expected. Finish it on the Mac." });
    expect(readFileSync(cfg.keys, "utf8")).toBe(typed);

    await until(() => (type(viewer.ws, "\x1b[A"), zmx("history", name).stdout.toString().includes("❯ No")), "the cursor back on No");
    const before = readFileSync(cfg.keys, "utf8").length;
    c.ws.send(JSON.stringify({ type: "answer", id: "u2", at: s.prompt.at, pick: 1, label: "No, exit" }));
    await until(() => c.messages.find((m) => m.id === "u2"), "reply", 10000);
    expect(c.messages.find((m) => m.id === "u2")).toEqual({ type: "ack", id: "u2" });
    expect(readFileSync(cfg.keys, "utf8").slice(before)).toBe("\r");
    // No ends Claude, and the session with it
    await until(() => c.closed?.code === 4000, "the chat to close as ended", 5000);
    viewer.ws.close();
  }, 20000);

  test("404 for an unknown session", async () => {
    expect((await api(`/sessions/${tag}-none/chat?token=${token}`)).status).toBe(404);
  });
});

describe("starting sessions", () => {
  test("starts from a 120x36 PTY: the first viewer sees what the session printed before anyone attached", async () => {
    const dir = join(homeDir, tag);
    mkdirSync(dir);
    const r = await api("/sessions", { method: "POST", body: JSON.stringify({ dir, name: "start" }) });
    expect(r.status).toBe(201);
    const { name } = await r.json();
    made.push(name);
    expect(name).toBe(`${tag}-start`);
    // The client that created it is gone; the session isn't.
    await until(() => clients(name) === 0, "the creating zmx client to go");

    const s = await socket(`/sessions/${name}/attach?cols=100&rows=30`);
    await until(() => s.text.includes("fake-claude size=36 120"), "output printed before the first attach");
    type(s.ws, "ping\r");
    await until(() => /ping\r?\n[^]*ping/.test(s.text), "input echoed back by the session");
    s.ws.close();
  }, 15000);

  test("a first message goes to Claude as its prompt, cleaned, after --", async () => {
    const dir = join(homeDir, tag);
    mkdirSync(dir, { recursive: true });
    const post = (body: object) => api("/sessions", { method: "POST", body: JSON.stringify(body) });
    const r = await post({ dir, name: "first", prompt: "-fix\x1b the tests" });
    expect(r.status).toBe(201);
    const { name } = await r.json();
    made.push(name);
    const s = await socket(`/sessions/${name}/attach?cols=100&rows=30`);
    await until(() => s.text.includes("-- -fix the tests]"), "the first message in Claude's arguments");
    s.ws.close();
    expect((await post({ dir, prompt: " \x1b " })).status).toBe(400);
    expect((await post({ dir, prompt: 5 })).status).toBe(400);
    expect((await post({ dir, shell: true, prompt: "hi" })).status).toBe(400);
  }, 15000);

  test("two starts at once get two sessions", async () => {
    const dir = join(homeDir, tag);
    const post = () => api("/sessions", { method: "POST", body: JSON.stringify({ dir, name: "twin" }) }).then((r) => r.json());
    const [a, b] = await Promise.all([post(), post()]);
    made.push(a.name, b.name);
    expect([a.name, b.name].sort()).toEqual([`${tag}-twin`, `${tag}-twin-2`]);
    expect(zmxNames()).toEqual(expect.arrayContaining([a.name, b.name]));
  }, 15000);

  test("shell: true starts the login shell without Claude, listed as kind shell", async () => {
    const dir = join(homeDir, tag);
    const r = await api("/sessions", { method: "POST", body: JSON.stringify({ dir, name: "sh", shell: true }) });
    expect(r.status).toBe(201);
    const { name } = await r.json();
    made.push(name);
    const s = await socket(`/sessions/${name}/attach?cols=100&rows=30`);
    // The fake shell got the login-shell arguments and no "-c exec claude".
    await until(() => s.text.includes("fake-shell size="), "the shell's first output");
    s.ws.close();
    const list = await (await api("/sessions")).json();
    expect(list.find((x: any) => x.name === name)?.kind).toBe("shell");
    const post = (body: object) => api("/sessions", { method: "POST", body: JSON.stringify(body) });
    expect((await post({ dir, shell: "yes" })).status).toBe(400);
    expect((await post({ dir, shell: true, resume: "0123abcd-0123-0123-0123-0123456789ab" })).status).toBe(400);
  }, 15000);

  test("DELETE /sessions/<name> ends the session; 404 for one that isn't there", async () => {
    const name = await shSession("doomed");
    const s = await socket(`/sessions/${name}/attach`);
    const r = await api(`/sessions/${name}`, { method: "DELETE" });
    expect(r.status).toBe(204);
    expect(zmxNames()).not.toContain(name);
    await until(() => s.closed?.code === 4000, "the attached client to see the session end");
    expect((await api(`/sessions/${name}`, { method: "DELETE" })).status).toBe(404);
    expect((await api(`/sessions/..%2F..`, { method: "DELETE" })).status).toBe(404);
    expect((await api(`/sessions/${name}`, { method: "DELETE" }, false)).status).toBe(401);
  }, 15000);
});

describe("events", () => {
  test("sends the session list on connect, with state", async () => {
    const name = await shSession("c");
    const e = await socket("/events");
    const msg = await until(() => e.messages.find((m) => m.type === "sessions"), "sessions message");
    const s = msg.sessions.find((x: any) => x.name === name);
    expect(s).toMatchObject({ name, title: "(new session)", state: "unknown" });
    expect(msg.digests).toEqual({}); // names are off here

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

  test("ports that programs in a session listen on: listed with the session, over /ports and the events socket", async () => {
    // A free port, then a web server on it inside a session (on IPv4), and one on IPv6 only.
    const free = () => {
      const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
      const p = s.port;
      s.stop(true);
      return p;
    };
    const [p4, p6] = [free(), free()];
    const serve = (host: string, port: number) => [
      "bun",
      "-e",
      `Bun.serve({ hostname: "${host}", port: ${port}, fetch: () => new Response("hi") }); setInterval(() => {}, 1e9)`,
    ];
    const v4 = await shSession("port4", serve("127.0.0.1", p4));
    const v6 = await shSession("port6", serve("::1", p6));
    const ports = await until(async () => {
      const list: any[] = await (await api("/ports")).json();
      return list.some((x) => x.port === p4) && list.some((x) => x.port === p6) && list;
    }, "the two ports", 10_000);
    expect(ports.find((x: any) => x.port === p4)).toMatchObject({ port: p4, host: "127.0.0.1", session: v4, command: "bun" });
    expect(ports.find((x: any) => x.port === p6)).toMatchObject({ port: p6, host: "::1", session: v6 });
    // Only this test's two sessions' ports, not blimpd's own socket. (Real sessions on this
    // machine may be serving something too, so only the test's are counted.)
    expect(ports.filter((x: any) => x.session.startsWith(tag)).map((x: any) => x.port).sort()).toEqual([p4, p6].sort());

    const e = await socket("/events");
    const msg = await until(() => e.messages.find((m) => m.type === "ports"), "ports message", 5000);
    expect(msg.ports.map((x: any) => x.port)).toContain(p4);
    zmx("kill", v4);
    await until(() => e.messages.some((m) => m.type === "ports" && !m.ports.some((x: any) => x.port === p4)), "port gone", 8000);
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

describe("server browser", () => {
  // Chrome is started by the first tab; without one on this server, opening a tab says how to get one.
  const chrome = findChrome();
  const site = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("<title>Served</title>hi", { headers: { "content-type": "text/html" } }) });
  afterAll(() => site.stop());

  test("tabs: bad addresses and folders refused, an unknown tab is 404", async () => {
    const post = (body: object) => api("/browser/tabs", { method: "POST", body: JSON.stringify(body) });
    expect((await post({ dir: homeDir, url: "file:///etc/passwd" })).status).toBe(400);
    expect((await post({ dir: homeDir, url: "javascript:alert(1)" })).status).toBe(400);
    expect((await post({ url: "https://example.com/" })).status).toBe(400);
    expect((await post({ dir: "/etc", url: "https://example.com/" })).status).toBe(403);
    expect((await api("/browser/tabs/nope", { method: "DELETE" })).status).toBe(404);
    expect((await api("/browser/tabs", {}, false)).status).toBe(401);
  });

  (chrome ? test : test.skip)("a tab opened for a folder: listed for it and not for others, over GET and the events socket, then closed", async () => {
    const e = await socket("/events");
    await until(() => e.messages.some((m) => m.type === "browser"), "the first browser message");
    const url = `http://127.0.0.1:${site.port}/a`;
    const r = await api("/browser/tabs", { method: "POST", body: JSON.stringify({ dir: homeDir, url }) });
    expect(r.status).toBe(201);
    const { id } = await r.json();
    const mine = await until(async () => ((await (await api(`/browser/tabs?dir=${encodeURIComponent(homeDir)}`)).json()) as any[]).find((t) => t.id === id), "the tab");
    expect(mine).toMatchObject({ folder: homeDir, url });
    expect(await (await api(`/browser/tabs?dir=${encodeURIComponent(homedir())}`)).json()).toEqual([]);
    await until(() => e.messages.some((m) => m.type === "browser" && m.tabs.some((t: any) => t.id === id && t.title === "Served")), "the tab with its title on the events socket", 8000);
    // A live view: frames (JPEG) once it has a size; a click goes to the page.
    expect((await api(`/browser/tabs/nope/view`)).status).toBe(404);
    const v = await socket(`/browser/tabs/${id}/view`);
    const frames: ArrayBuffer[] = [];
    v.ws.onmessage = (ev) => (typeof ev.data === "string" ? v.messages.push(JSON.parse(ev.data)) : frames.push(ev.data as ArrayBuffer));
    v.ws.send(JSON.stringify({ type: "size", width: 320, height: 200, scale: 1 }));
    await until(() => frames.length > 0, "a frame");
    expect(new Uint8Array(frames[0])[0]).toBe(0xff);
    await until(() => v.messages.some((m) => m.type === "info" && m.url === url), "the view's info");
    v.ws.close();
    expect((await api(`/browser/tabs/${id}`, { method: "DELETE" })).status).toBe(204);
    await until(async () => !((await (await api("/browser/tabs")).json()) as any[]).some((t) => t.id === id), "the tab to close");
    e.ws.close();
  }, 30_000);
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

  test("mkdir and create: new names only, inside home, parent must exist", async () => {
    const post = (route: string, path: string) => api(route, { method: "POST", body: JSON.stringify({ path }) });
    const dir = join(homeDir, "made");
    expect((await post("/fs/mkdir", dir)).status).toBe(201);
    expect(statSync(dir).isDirectory()).toBe(true);
    expect((await post("/fs/mkdir", dir)).status).toBe(409);
    const file = join(dir, "new.txt");
    const r = await post("/fs/create", file);
    expect(r.status).toBe(201);
    expect((await r.json()).mtime).toBeGreaterThan(0);
    expect(readFileSync(file, "utf8")).toBe("");
    writeFileSync(file, "keep me");
    expect((await post("/fs/create", file)).status).toBe(409);
    expect(readFileSync(file, "utf8")).toBe("keep me");
    expect((await post("/fs/mkdir", join(homeDir, "no/such/parent"))).status).toBe(403);
    expect((await post("/fs/mkdir", join(tmp, "outside"))).status).toBe(403);
    expect((await post("/fs/create", "relative.txt")).status).toBe(400);
    expect((await api("/fs/mkdir", { method: "POST", body: "{}" })).status).toBe(400);
  });

  test("download: a file as it is, a folder as .tar.gz; inside home only", async () => {
    const q = (p: string) => encodeURIComponent(p);
    const dir = join(homeDir, "dl");
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "a.bin"), new Uint8Array([0, 1, 2, 255]));
    writeFileSync(join(dir, "sub", "b.txt"), "bee");
    symlinkSync("/etc/passwd", join(dir, "sub", "out"));

    const f = await api(`/fs/download?path=${q(join(dir, "a.bin"))}`);
    expect(f.status).toBe(200);
    expect([...new Uint8Array(await f.arrayBuffer())]).toEqual([0, 1, 2, 255]);
    expect(f.headers.get("content-disposition")).toBe(`attachment; filename*=UTF-8''a.bin`);

    const t = await api(`/fs/download?path=${q(dir)}`);
    expect(t.status).toBe(200);
    expect(t.headers.get("content-disposition")).toBe(`attachment; filename*=UTF-8''dl.tar.gz`);
    const tgz = join(tmp, "dl.tar.gz");
    writeFileSync(tgz, new Uint8Array(await t.arrayBuffer()));
    const listing = Bun.spawnSync(["tar", "-tvzf", tgz]).stdout.toString();
    expect(listing).toContain("dl/a.bin");
    expect(listing).toContain("dl/sub/b.txt");
    // A symlink goes in as a link; what it points at outside home is never read.
    expect(listing).toMatch(/dl\/sub\/out -> \/etc\/passwd/);
    expect(listing).not.toContain("root:");

    // tar failing part way (an unreadable file) fails the download instead of ending it short.
    writeFileSync(join(dir, "sub", "locked"), "x");
    chmodSync(join(dir, "sub", "locked"), 0);
    const bad = await api(`/fs/download?path=${q(dir)}`);
    expect(bad.status).toBe(200);
    expect(await bad.arrayBuffer().then(() => "complete", () => "failed")).toBe("failed");
    chmodSync(join(dir, "sub", "locked"), 0o600);

    expect((await api(`/fs/download?path=${q("/etc/passwd")}`)).status).toBe(403);
    expect((await api(`/fs/download?path=${q(join(dir, "missing"))}`)).status).toBe(404);
  });

  test("upload: new names only unless replace, never into a folder's name, streamed into place", async () => {
    const q = (p: string) => encodeURIComponent(p);
    const dir = join(homeDir, "ul");
    mkdirSync(join(dir, "taken-dir"), { recursive: true });
    const put = (path: string, body: BodyInit, mode = "new") => api(`/fs/upload?path=${q(path)}&mode=${mode}`, { method: "PUT", body });

    const big = new Uint8Array(3 * 1024 * 1024).map((_, i) => i % 251);
    const r = await put(join(dir, "big.bin"), big);
    expect(r.status).toBe(201);
    expect((await r.json()).size).toBe(big.length);
    expect(readFileSync(join(dir, "big.bin")).equals(Buffer.from(big))).toBe(true);

    expect((await put(join(dir, "big.bin"), "other")).status).toBe(409);
    expect(readFileSync(join(dir, "big.bin")).length).toBe(big.length);
    expect((await put(join(dir, "big.bin"), "other", "replace")).status).toBe(201);
    expect(readFileSync(join(dir, "big.bin"), "utf8")).toBe("other");

    // Replace keeps the file's permissions (a 600 key stays 600, a script stays runnable).
    writeFileSync(join(dir, "key"), "old");
    chmodSync(join(dir, "key"), 0o600);
    expect((await put(join(dir, "key"), "new", "replace")).status).toBe(201);
    expect(statSync(join(dir, "key")).mode & 0o777).toBe(0o600);
    rmSync(join(dir, "key"));

    expect((await put(join(dir, "taken-dir"), "x", "replace")).status).toBe(409);
    expect((await put(join(dir, "f.txt"), "x", "sideways")).status).toBe(400);
    expect((await put(join(tmp, "outside.txt"), "x")).status).toBe(403);
    expect((await put(join(dir, "no/such/f.txt"), "x")).status).toBe(403);
    // No temp files left behind.
    expect(readdirSync(dir).sort()).toEqual(["big.bin", "taken-dir"]);
  });

  test("POST /sessions checks resume ids and the home folder", async () => {
    const post = (body: object) => api("/sessions", { method: "POST", body: JSON.stringify(body) });
    expect((await post({ dir: homeDir, resume: "$(touch /tmp/x)" })).status).toBe(400);
    expect((await post({ dir: tmp })).status).toBe(403);
    expect((await post({})).status).toBe(400);
  });
});

// A second blimpd, with a temp home: the Z.ai key, ~/.codex and kinds.json it reads and writes
// are all in there, never in the real home. The fake launchers are first on its PATH.
describe("kinds and keys", () => {
  const kTmp = mkdtempSync(join(tmpdir(), "blimp-kinds-"));
  const kHome = realpathSync(mkdtempSync(join(tmpdir(), "blimp-kinds-home-")));
  const kSock = join(kTmp, "blimpd.sock");
  const keyFile = join(kHome, ".config", "zai", "key");
  const KEY = "zai-test-key.0123456789abcdef";
  let kServer: ReturnType<typeof Bun.spawn>;
  let kToken = "";
  const kApi = (path: string, init: RequestInit = {}) =>
    fetch(`http://blimpd${path}`, { ...init, unix: kSock, headers: { Authorization: `Bearer ${kToken}`, ...(init.headers as any) } } as any);
  const post = (body: object) => kApi("/sessions", { method: "POST", body: JSON.stringify(body) });
  const kinds = async () => (await (await kApi("/kinds")).json()) as { id: string; label: string; available: boolean; note?: string }[];
  const dir = join(kHome, tag);
  const blimpdLog = join(kTmp, "blimpd.log");
  // Claude and Codex get the browser MCP when this blimpd finds a Chrome (in kHome or on PATH) and
  // npx (browser/mcp.ts): what's added to their arguments then.
  const kPath = `${fakeBin}:${env.PATH}`;
  const browserOn = !!findChrome(kHome, (n) => Bun.which(n, { PATH: kPath })) && !!Bun.which("npx", { PATH: kPath });
  const claudeMcp = browserOn ? `--mcp-config ${join(kTmp, "browser", "mcp.json")}` : "";
  const codexMcp = browserOn ? /-c mcp_servers\.blimp-browser\.command="[^"]+" -c mcp_servers\.blimp-browser\.args=\[[^\]]*"browser-mcp"\]/ : /^$/;
  const withMcp = (rest: string) => [claudeMcp, rest].filter(Boolean).join(" ");

  // Starts a session of this kind and returns its name and what it printed first.
  async function startKind(kind: string, name: string, waitFor: string, extra = {}) {
    const r = await post({ dir, name, kind, ...extra });
    expect(r.status).toBe(201);
    const { name: made_ } = await r.json();
    made.push(made_);
    const s = await new Promise<Awaited<ReturnType<typeof socket>>>((res, rej) => {
      const ws = new WebSocket(`ws+unix://${kSock}:/sessions/${made_}/attach?token=${kToken}`);
      ws.binaryType = "arraybuffer";
      const x = { ws, text: "", messages: [] as any[], closed: undefined as any };
      ws.onmessage = (e) => (x.text += typeof e.data === "string" ? "" : new TextDecoder().decode(e.data));
      ws.onopen = () => res(x);
      ws.onerror = () => rej(new Error("attach failed"));
    });
    await until(() => s.text.includes(waitFor), `${kind} output`);
    s.ws.close();
    // Lines the terminal wrapped at 120 columns joined again: with the browser MCP's arguments
    // (on a machine with Chrome), the arguments line is longer than that.
    return { name: made_, text: s.text.replace(/\r\n/g, "") };
  }

  beforeAll(async () => {
    mkdirSync(dir);
    const out = Bun.file(blimpdLog);
    const kEnv: Record<string, string | undefined> = {
      ...env,
      HOME: kHome,
      BLIMPD_SOCKET: kSock,
      SHELL: fakeShell,
      PATH: `${fakeBin}:${env.PATH}`,
      BLIMP_TEST_PROFILE: join(kHome, "profile"),
    };
    delete kEnv.CODEX_HOME;
    writeFileSync(join(kTmp, "config.json"), JSON.stringify({ names: false }));
    kServer = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "main.ts"), "serve"], { env: kEnv, stdout: out, stderr: out });
    await until(() => {
      try {
        return statSync(kSock).isSocket() && (kToken = readFileSync(join(kTmp, "token"), "utf8").trim());
      } catch {
        return false;
      }
    }, "the second blimpd to start");
  });

  afterAll(() => {
    kServer?.kill();
    rmSync(kTmp, { recursive: true, force: true });
    rmSync(kHome, { recursive: true, force: true });
  });

  test("GET /kinds: in order, with why one isn't available, and Codex's sign-in", async () => {
    expect(await kinds()).toEqual([
      { id: "claude", label: "Claude Code", available: true },
      { id: "claude-glm", label: "Claude Code on GLM", available: false, note: "Add a Z.ai key in Settings" },
      { id: "codex", label: "Codex", available: true, note: "not signed in" },
      { id: "shell", label: "Shell", available: true },
    ]);
    mkdirSync(join(kHome, ".codex"));
    writeFileSync(join(kHome, ".codex", "auth.json"), "{}");
    expect((await kinds()).find((k) => k.id === "codex")?.note).toBe("signed in");
    expect((await post({ dir, kind: "claude-glm" })).status).toBe(400);
    expect((await post({ dir, kind: "nope" })).status).toBe(400);
    expect((await post({ dir, kind: 3 })).status).toBe(400);
    expect((await post({ dir, kind: "codex", shell: true })).status).toBe(400);
    expect((await post({ dir, kind: "codex", resume: "0123abcd-0123-0123-0123-0123456789ab" })).status).toBe(400);
  });

  test("PUT /keys/zai: 600 in a 700 folder, 400 for a bad key, never returned; DELETE takes it out", async () => {
    const put = (body: unknown) => kApi("/keys/zai", { method: "PUT", body: JSON.stringify(body) });
    for (const bad of ["short", "has a space in it", "x".repeat(501), "tab\there-and-more", 42, undefined])
      expect((await put({ key: bad })).status).toBe(400);
    expect((await kApi("/keys/zai", { method: "PUT", body: "not json" })).status).toBe(400);
    expect(existsSync(keyFile)).toBe(false);

    expect((await put({ key: KEY })).status).toBe(204);
    expect(readFileSync(keyFile, "utf8")).toBe(KEY);
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(statSync(join(kHome, ".config", "zai")).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(kHome, ".config", "zai"))).toEqual(["key"]); // no temp file left
    const keys = await kApi("/keys");
    expect(await keys.text()).toBe('{"zai":true}');
    expect((await kinds()).find((k) => k.id === "claude-glm")).toEqual({ id: "claude-glm", label: "Claude Code on GLM", available: true });

    expect((await kApi("/keys/zai", { method: "DELETE" })).status).toBe(204);
    expect(existsSync(keyFile)).toBe(false);
    expect(await (await kApi("/keys")).json()).toEqual({ zai: false });
    expect((await kinds()).find((k) => k.id === "claude-glm")?.available).toBe(false);
  });

  test("the fs api never serves blimp's own key files, nor a folder that holds one", async () => {
    expect((await kApi("/keys/zai", { method: "PUT", body: JSON.stringify({ key: KEY }) })).status).toBe(204);
    const q = (p: string) => encodeURIComponent(p);
    const r = await kApi(`/fs/file?path=${q(keyFile)}`);
    expect(r.status).toBe(403); // plain home containment would have served the key here
    expect(await r.text()).not.toContain(KEY);
    expect((await kApi(`/fs/download?path=${q(join(kHome, ".config"))}`)).status).toBe(403);
    expect((await kApi(`/fs/download?path=${q(kHome)}`)).status).toBe(403); // its tar would archive the key
  });

  test("POST /sessions starts each kind's command; the GLM key goes in the environment only", async () => {
    expect((await kApi("/keys/zai", { method: "PUT", body: JSON.stringify({ key: KEY }) })).status).toBe(204);
    // A login profile with its own Anthropic settings: they must not win over GLM's.
    writeFileSync(
      join(kHome, "profile"),
      "export ANTHROPIC_BASE_URL=https://elsewhere.example ANTHROPIC_AUTH_TOKEN=theirs ANTHROPIC_MODEL=their-model ANTHROPIC_API_KEY=theirs\n",
    );
    const claude = await startKind("claude", "k-claude", "custom=");
    expect(claude.text).toContain("fake-claude size=36 120");
    expect(claude.text).toContain(`args:[${claudeMcp}]`);
    expect(claude.text).not.toContain("token=from-key-file");
    const conv = "0123abcd-0123-0123-0123-0123456789ab";
    const glm = await startKind("claude-glm", "k-glm", "token=from-key-file", { resume: conv });
    expect(glm.text).toContain("fake-claude size=36 120");
    expect(glm.text).toContain(`args:[${withMcp(`--resume ${conv}`)}]`);
    // Claude Code's own key is unset, as claude-glm does, so the Z.ai one is used, at Z.ai.
    expect(glm.text).toContain("model=GLM-5.3 fast=GLM-5.3-Flash apikey=unset");
    // GLM-5.3's real window, so Claude Code doesn't compact at the 200k it assumes for a model it doesn't know.
    expect(glm.text).toContain("url=https://api.z.ai/api/anthropic zaitoken=unset window=1048576");
    // Resume with no kind (the apps' Earlier lists): a conversation that ran on GLM goes on on GLM.
    const glmConv = "0123abcd-0123-0123-0123-0123456789ac";
    const convDir = join(tmp, "claude", "projects", dir.replace(/[^A-Za-z0-9]/g, "-"));
    mkdirSync(convDir, { recursive: true });
    writeFileSync(join(convDir, `${glmConv}.jsonl`), JSON.stringify({ type: "assistant", message: { role: "assistant", model: "GLM-5.3", content: [] } }) + "\n");
    const again = await startKind(undefined as any, "k-glm-again", "token=from-key-file", { resume: glmConv });
    expect(again.text).toContain(`args:[${withMcp(`--resume ${glmConv}`)}]`);
    expect(again.text).toContain("model=GLM-5.3 fast=GLM-5.3-Flash apikey=unset");
    const codex = await startKind("codex", "k-codex", "custom=");
    expect(codex.text).toContain("fake-codex size=36 120");
    expect(codex.text.match(/args:\[(.*)\]/)?.[1]).toMatch(codexMcp);
    expect(codex.text).not.toContain("token=from-key-file");
    const login = await startKind("codex-login", "k-login", "custom=");
    expect(login.text).toContain("args:[login --device-auth]");
    const sh = await startKind("shell", "k-sh", "fake-shell size=");
    expect(sh.text).not.toContain("fake-claude");

    // The key is in no command line, no zmx list, no API answer and no log.
    const ps = Bun.spawnSync(["ps", "-eo", "args"]).stdout.toString();
    expect(ps).not.toContain(KEY);
    const zmxList = zmx("list").stdout.toString();
    expect(zmxList).toContain(glm.name);
    expect(zmxList).not.toContain(KEY);
    for (const path of ["/sessions", "/kinds", "/keys"]) expect(await (await kApi(path)).text()).not.toContain(KEY);
    expect(readFileSync(blimpdLog, "utf8")).not.toContain(KEY);
    expect(readFileSync(join(kTmp, "session-kinds.json"), "utf8")).not.toContain(KEY);

    // Each session reports the kind it was started with; one made outside blimp is still a shell.
    const outside = await shSession("k-outside");
    const list: any[] = await (await kApi("/sessions")).json();
    const of = (n: string) => list.find((x) => x.name === n);
    expect(of(claude.name)).toMatchObject({ kind: "claude" });
    expect(of(claude.name).label).toBeUndefined();
    expect(of(glm.name)).toMatchObject({ kind: "claude-glm", label: "GLM" });
    expect(of(codex.name)).toMatchObject({ kind: "codex", label: "Codex" });
    expect(of(login.name)).toMatchObject({ kind: "codex-login", label: "Codex sign-in" });
    expect(of(sh.name)).toMatchObject({ kind: "shell" });
    expect(of(outside)).toMatchObject({ kind: "shell" });

    // Ended sessions leave the remembered kinds at the next start.
    zmx("kill", codex.name);
    await until(() => !zmxNames().includes(codex.name), "codex session to end");
    await startKind("shell", "k-sh2", "fake-shell size=");
    expect(Object.keys(JSON.parse(readFileSync(join(kTmp, "session-kinds.json"), "utf8")))).not.toContain(codex.name);
  }, 30000);

  test("custom kinds from kinds.json: listed before Shell and started; a bad file is ignored with a note", async () => {
    const file = join(kTmp, "kinds.json");
    writeFileSync(
      file,
      JSON.stringify({ kinds: [{ id: "review", label: "Codex review", command: ["codex", "--profile", "x y"], env: { CUSTOM_VAR: "hi" } }], glm: { model: "GLM-9", fast: "GLM-9-Air" } }),
    );
    const list = await kinds();
    expect(list.map((k) => k.id)).toEqual(["claude", "claude-glm", "codex", "review", "shell"]);
    expect(list.find((k) => k.id === "review")).toEqual({ id: "review", label: "Codex review", available: true });
    writeFileSync(
      file,
      JSON.stringify({ kinds: [...JSON.parse(readFileSync(file, "utf8")).kinds, { id: "gone", label: "Gone", command: ["not-installed-anywhere"] }], glm: { model: "GLM-9", fast: "GLM-9-Air" } }),
    );
    expect((await kinds()).find((k) => k.id === "gone")).toEqual({ id: "gone", label: "Gone", available: false, note: "not-installed-anywhere isn't installed" });
    expect((await post({ dir, kind: "gone" })).status).toBe(400);
    const r = await startKind("review", "k-review", "custom=hi");
    expect(r.text).toContain("fake-codex size=");
    expect(r.text).toContain("args:[--profile x y]");
    const glm = await startKind("claude-glm", "k-glm9", "token=from-key-file");
    expect(glm.text).toContain("model=GLM-9 fast=GLM-9-Air");
    const sessions: any[] = await (await kApi("/sessions")).json();
    expect(sessions.find((x) => x.name === r.name)).toMatchObject({ kind: "review", label: "Codex review" });

    for (const [bad, why] of [
      ["{ not json", "is ignored"],
      [JSON.stringify({ kinds: [{ id: "codex", label: "Mine", command: ["x"] }] }), "built-in"],
      [JSON.stringify({ kinds: [{ id: "a b", label: "Mine", command: ["x"] }] }), "plain id"],
      [JSON.stringify({ kinds: [{ id: "mine", label: "Mine", command: "x --y" }] }), "list of words"],
      [JSON.stringify({ kinds: [{ id: "mine", label: "Mine", command: ["x"], env: { A: 1 } }] }), "env"],
    ]) {
      writeFileSync(file, bad);
      const list = await kinds();
      expect(list.map((k) => k.id)).toEqual(["claude", "claude-glm", "codex", "kinds.json", "shell"]);
      const note = list.find((k) => k.id === "kinds.json")!;
      expect(note.available).toBe(false);
      expect(note.note).toContain(why);
    }
    expect((await post({ dir, kind: "review" })).status).toBe(400);
    expect((await post({ dir, kind: "kinds.json" })).status).toBe(400);
    rmSync(file);
  }, 30000);
});

// blimp names Claude sessions itself (names.ts), with a stand-in claude first on this blimpd's PATH:
// it records its arguments and what it got on stdin, one pair of files per call, and answers with
// whatever the answer file says.
describe("names", () => {
  const nTmp = mkdtempSync(join(tmpdir(), "blimp-names-"));
  const nSock = join(nTmp, "blimpd.sock");
  const nClaude = join(nTmp, "claude");
  const nBin = join(nTmp, "bin");
  const calls = join(nTmp, "calls");
  const answer = join(nTmp, "answer");
  let nServer: ReturnType<typeof Bun.spawn>;
  let nToken = "";
  const list = async () => (await (await fetch("http://blimpd/sessions", { unix: nSock, headers: { Authorization: `Bearer ${nToken}` } } as any)).json()) as any[];
  const titleOf = async (name: string) => (await list()).find((s) => s.name === name)?.title;
  const stdins = () => readdirSync(calls).filter((f) => f.endsWith(".stdin")).map((f) => readFileSync(join(calls, f), "utf8"));
  const T = new Date().toISOString();
  const tline = (o: object) => JSON.stringify({ timestamp: T, ...o }) + "\n";
  const user = (uuid: string, text: string) => tline({ type: "user", uuid, message: { role: "user", content: text } });
  const said = (uuid: string, text: string) => tline({ type: "assistant", uuid, message: { role: "assistant", content: [{ type: "text", text }] } });

  // A session that looks like Claude to this blimpd: its pid has a status file naming a transcript.
  async function fakeClaude(suffix: string, sessionId: string, lines: string[]) {
    const name = await shSession(suffix, ["sh", "-c", "exec cat"]);
    const pid = parseZmxList(zmx("list").stdout.toString()).find((s) => s.name === name)!.pid;
    writeFileSync(join(nClaude, "projects", "p", `${sessionId}.jsonl`), lines.join(""));
    writeFileSync(join(nClaude, "sessions", `${pid}.json`), JSON.stringify({ sessionId, cwd: tmp, status: "idle" }));
    return name;
  }

  beforeAll(async () => {
    for (const d of [nBin, calls, join(nClaude, "sessions"), join(nClaude, "projects", "p")]) mkdirSync(d, { recursive: true });
    writeFileSync(
      join(nBin, "claude"),
      `#!/bin/sh
n="$(date +%s%N)-$$"
printf '%s\\n' "$@" > "${calls}/$n.argv"
cat > "${calls}/$n.stdin"
cat "${answer}"
`,
    );
    chmodSync(join(nBin, "claude"), 0o755);
    writeFileSync(answer, "Mobile App Fixes\n");
    nServer = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "main.ts"), "serve"], {
      env: { ...env, BLIMPD_SOCKET: nSock, CLAUDE_CONFIG_DIR: nClaude, SHELL: fakeShell, PATH: `${nBin}:${env.PATH}` },
      stdout: "ignore",
      stderr: "inherit",
    });
    await until(() => {
      try {
        return statSync(nSock).isSocket() && (nToken = readFileSync(join(nTmp, "token"), "utf8").trim());
      } catch {
        return false;
      }
    }, "the names blimpd to start");
  });

  afterAll(() => {
    nServer?.kill();
    rmSync(nTmp, { recursive: true, force: true });
  });

  test("a session gets the model's name; the conversation goes on stdin, never in the arguments", async () => {
    const sid = "55555555-5555-5555-5555-555555555555";
    const name = await fakeClaude("n1", sid, [user("u1", "make the mobile app login work again"), said("a1", "Fixed the token refresh.")]);
    expect(await titleOf(name)).toBe("make the mobile app login work again");
    await until(async () => (await titleOf(name)) === "Mobile App Fixes", "the name in the session list", 15000);
    const [argv] = readdirSync(calls).filter((f) => f.endsWith(".argv")).map((f) => readFileSync(join(calls, f), "utf8"));
    expect(argv.split("\n").slice(0, -1)).toEqual(["-p", "--model", "haiku", "--no-session-persistence", "--strict-mcp-config", "--tools", "", "--max-turns", "1", "--settings", '{"disableAllHooks":true}']);
    expect(argv).not.toContain("mobile app");
    expect(stdins()[0]).toContain("make the mobile app login work again");
    expect(stdins()[0]).toContain("Fixed the token refresh.");
    const file = join(nTmp, "names.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))[sid]).toMatchObject({ name: "Mobile App Fixes", prompts: 1 });
  }, 20000);

  test("an answer that isn't a name leaves the old title", async () => {
    writeFileSync(answer, "Here is a name: Fixing The Mobile App Login Flow Today\n");
    const sid = "66666666-6666-6666-6666-666666666666";
    const name = await fakeClaude("n2", sid, [user("u1", "look at the billing page"), tline({ type: "ai-title", aiTitle: "Billing page review" }), said("a1", "ok")]);
    await until(() => stdins().some((t) => t.includes("look at the billing page")), "the call for the second session", 15000);
    await Bun.sleep(500);
    expect(await titleOf(name)).toBe("Billing page review");
    expect(JSON.parse(readFileSync(join(nTmp, "names.json"), "utf8"))[sid]).toBeUndefined();
  }, 20000);

  // The project paragraphs (digests.ts) come with the session list, for the folders with sessions running.
  test("the events socket carries each running folder's paragraph", async () => {
    await fakeClaude("n4", "88888888-8888-8888-8888-888888888888", [user("u1", "write the docs"), said("a1", "Wrote them.")]);
    const dir = (await list()).find((s) => s.sessionId === "88888888-8888-8888-8888-888888888888")!.dir;
    const d = { text: "[The docs](1) are written.", sessions: ["x"], at: 5, key: "k" };
    writeFileSync(join(nTmp, "digests.json"), JSON.stringify({ [dir]: d, "/nowhere": { ...d, text: "gone" } }));
    const ws = new WebSocket(`ws+unix://${nSock}:/events?token=${nToken}`);
    const got: any[] = [];
    ws.onmessage = (e) => got.push(JSON.parse(String(e.data)));
    try {
      const m = await until(() => got.find((x) => x.type === "sessions" && x.digests?.[dir]), "the paragraph on the events socket");
      expect(m.digests).toEqual({ [dir]: { text: "[The docs](1) are written.", sessions: ["x"], at: 5 } });
    } finally {
      ws.close();
    }
  }, 20000);

  test('nothing is called with "names": false, and Claude\'s titles show again', async () => {
    writeFileSync(join(nTmp, "config.json"), JSON.stringify({ names: false }));
    writeFileSync(answer, "Should Not Show\n");
    const before = stdins().length;
    const name = await fakeClaude("n3", "77777777-7777-7777-7777-777777777777", [user("u1", "tidy the readme"), said("a1", "done")]);
    await Bun.sleep(6000); // past the next naming check
    expect(stdins().length).toBe(before);
    const sessions = await list();
    expect(sessions.find((s) => s.name === name)?.title).toBe("tidy the readme");
    expect(sessions.find((s) => s.sessionId === "55555555-5555-5555-5555-555555555555")?.title).toBe("make the mobile app login work again");
  }, 20000);
});
