// A zmx that hangs (a session too stuck to answer it). Bun finds zmx on the PATH it started with, so
// each check runs in a child bun with a stand-in zmx that never answers first on its PATH.
import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const src = join(import.meta.dir, "..", "src");

async function withHungZmx(script: string): Promise<any> {
  const dir = mkdtempSync(join(tmpdir(), "blimp-hung-zmx-"));
  try {
    writeFileSync(join(dir, "zmx"), "#!/bin/sh\nexec sleep 60\n");
    chmodSync(join(dir, "zmx"), 0o755);
    const p = Bun.spawn([process.execPath, "-e", script], {
      cwd: dir,
      // blimpd's own files and Claude's go in the folder too, not yours
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, SRC: src, BLIMPD_SOCKET: join(dir, "blimpd.sock"), CLAUDE_CONFIG_DIR: dir },
      stdout: "pipe",
      stderr: "inherit",
    });
    const out = await new Response(p.stdout).text();
    expect(await p.exited).toBe(0);
    return JSON.parse(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("its list, a permission's screen and a starting Claude's screen are given up on after 5 s: no sessions, the hook's prompt as it is, no trust question", async () => {
  const r = await withHungZmx(`
    const { mkdirSync, writeFileSync } = require("node:fs");
    const { listSessions } = await import(process.env.SRC + "/sessions.ts");
    mkdirSync("status");
    mkdirSync("sessions");
    writeFileSync("sessions/42.json", JSON.stringify({ sessionId: "s-web-1", cwd: "/tmp" }));
    const prompt = { kind: "permission", tool: "Bash", summary: "Ran ls", options: ["Yes", "No"], keys: ["1", "\\x1b"], answerable: true };
    writeFileSync("status/web-1.json", JSON.stringify({ state: "waiting", at: 7000, event: "PermissionRequest", prompt }));
    let t = Date.now();
    const none = listSessions(".", undefined, "status", "kinds.json");
    const listMs = Date.now() - t;
    t = Date.now();
    const [s] = listSessions(".", "  name=web-1\\tpid=42\\tclients=1\\tcreated=5\\tcwd=/tmp\\tcmd=claude", "status", "kinds.json");
    const historyMs = Date.now() - t;
    // No sessionId yet: its screen is read for the folder trust question.
    t = Date.now();
    const [n] = listSessions(".", "  name=web-2\\tpid=43\\tclients=1\\tcreated=5\\tcwd=/tmp\\tcmd=claude", "status", "kinds.json");
    console.log(JSON.stringify({ none, listMs, historyMs, prompt: s.prompt, trustMs: Date.now() - t, trust: [n.state, n.prompt] }));
  `);
  expect(r.none).toEqual([]);
  expect(r.listMs).toBeLessThan(7000);
  expect(r.historyMs).toBeLessThan(7000);
  expect(r.prompt).toEqual({ kind: "permission", tool: "Bash", summary: "Ran ls", options: ["Yes", "No"], keys: ["1", "\x1b"], answerable: true, at: 7000 });
  expect(r.trustMs).toBeLessThan(7000);
  expect(r.trust).toEqual(["unknown", null]);
}, 30000);

test("a phone chat closes as for a failed list instead of staying open", async () => {
  const r = await withHungZmx(`
    const { chatData, openChat } = await import(process.env.SRC + "/chatsocket.ts");
    let closed;
    const ws = { data: chatData("blimpunit-hung"), send() {}, close: (code, reason) => (closed = { code, reason }) };
    const t = Date.now();
    await openChat(ws);
    console.log(JSON.stringify({ closed, ms: Date.now() - t }));
  `);
  expect(r.closed).toEqual({ code: 4000, reason: "ended" });
  expect(r.ms).toBeLessThan(7000);
}, 15000);
