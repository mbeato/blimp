// The server browser in blimpd (src/browser/service.ts): the gate's listener, a real zmx session
// connecting as itself, the MCP a session runs (blimpd browser-mcp, through npx), and tabs that
// outlive a restart. Its own blimp dir (BLIMPD_SOCKET); the zmx session is blimptest-* and killed
// at the end. Skips without Chrome; the MCP test also without npx.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "blimp-browser-")));
process.env.BLIMPD_SOCKET = join(tmp, "blimp", "blimpd.sock");
mkdirSync(join(tmp, "blimp"), { recursive: true });
const folder = join(tmp, "project");
mkdirSync(folder);

const { findChrome } = await import("../src/browser/chrome");
const { browserTabs, startBrowserGate, stopBrowser, openTab } = await import("../src/browser/service");
const { gateKey, mcpConfigPath, portFile } = await import("../src/browser/mcp");
const { zmxPath, zmxEnv, parseZmxList } = await import("../src/sessions");

const live = findChrome() ? test : test.skip;
const session = `blimptest-browser-${process.pid}`;
let port = 0;
const site = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === "/api") return Response.json({ answer: 42 });
    return new Response(`<title>Page ${u.pathname}</title><h1>${u.pathname}</h1><script>fetch("/api")</script>`, { headers: { "content-type": "text/html" } });
  },
});
const base = `http://127.0.0.1:${site.port}`;

async function until<T>(f: () => T | Promise<T>, what: string, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

beforeAll(async () => {
  if (!findChrome()) return;
  Bun.spawnSync([zmxPath(), "attach", session, "sh"], { env: zmxEnv(), cwd: folder, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  await until(() => parseZmxList(Bun.spawnSync([zmxPath(), "list"], { env: zmxEnv() }).stdout.toString()).some((s) => s.name === session), "the zmx session");
  port = await startBrowserGate();
});
afterAll(async () => {
  site.stop();
  await stopBrowser();
  Bun.spawnSync([zmxPath(), "kill", session], { env: zmxEnv(), stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  rmSync(tmp, { recursive: true, force: true });
});

// A CDP client over the gate's WebSocket: with the gate's key unless `key` says otherwise, and
// headers as given (a web page's WebSocket would send Origin).
async function cdp(path: string, key: string | null = gateKey(), headers: Record<string, string> = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}${key === null ? "" : `?key=${key}`}`, { headers } as any);
  const log: any[] = [];
  const waits = new Map<number, (m: any) => void>();
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    log.push(m);
    if (m.id !== undefined) waits.get(m.id)?.(m);
  };
  const closed = new Promise<number>((done) => (ws.onclose = (e) => done(e.code)));
  let id = 0;
  const call = (method: string, params: any = {}, sessionId?: string) =>
    new Promise<any>((done) => {
      const i = ++id;
      waits.set(i, done);
      ws.send(JSON.stringify({ id: i, method, params, ...(sessionId && { sessionId }) }));
    });
  const opened = await Promise.race([new Promise<boolean>((done) => (ws.onopen = () => done(true))), closed.then(() => false)]);
  return { ws, log, call, opened, closed };
}

live("the gate writes its port and the MCP config sessions get", () => {
  expect(Number(readFileSync(portFile(), "utf8"))).toBe(port);
  const config = JSON.parse(readFileSync(mcpConfigPath(), "utf8"));
  expect(config.mcpServers["blimp-browser"].args.at(-1)).toBe("browser-mcp");
});

live("only a client with the gate's key, and no web page, gets in", async () => {
  expect(gateKey()).toMatch(/^[0-9a-f]{64}$/);
  expect((await cdp(`/s/${session}`, null)).opened).toBe(false);
  expect((await cdp(`/s/${session}`, "0".repeat(64))).opened).toBe(false);
  // A page in the server's own Chrome runs as the same user; its WebSocket says where it's from.
  expect((await cdp(`/s/${session}`, gateKey(), { Origin: "https://evil.example" })).opened).toBe(false);
  expect((await cdp(`/s/${session}`, gateKey(), { Host: "evil.example:80" })).opened).toBe(false);
  const ok = await cdp(`/s/${session}`);
  expect(ok.opened).toBe(true);
  ok.ws.close();
});

live("only a session that exists gets in", async () => {
  const c = await cdp("/s/blimptest-no-such-session");
  expect(c.opened).toBe(false);
  const bad = await cdp("/s/..");
  expect(bad.opened).toBe(false);
});

live("a session's tab is in the session's folder, and saved", async () => {
  const c = await cdp(`/s/${session}`);
  expect(c.opened).toBe(true);
  await c.call("Target.setDiscoverTargets", { discover: true });
  const r = await c.call("Target.createTarget", { url: `${base}/made-by-session` });
  const tab = await until(() => browserTabs().find((t) => t.id === r.result.targetId), "the tab");
  expect(tab).toMatchObject({ folder, openedBy: session });
  await until(() => {
    try {
      return JSON.parse(readFileSync(join(tmp, "blimp", "browser", "tabs.json"), "utf8")).some((t: any) => t.url === `${base}/made-by-session` && t.folder === folder);
    } catch {
      return false;
    }
  }, "tabs.json");
  c.ws.close();
}, 20_000);

const mcpTest = findChrome() && Bun.which("npx") ? test : test.skip;
mcpTest("the MCP a session runs reads pages, their network and their source through the gate", async () => {
  const p = Bun.spawn([process.execPath, join(import.meta.dir, "../src/main.ts"), "browser-mcp"], {
    env: { ...process.env, ZMX_SESSION: session },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  const waits = new Map<number, (m: any) => void>();
  let id = 0;
  void (async () => {
    let buf = "";
    for await (const chunk of p.stdout) {
      buf += new TextDecoder().decode(chunk);
      for (let i; (i = buf.indexOf("\n")) >= 0; ) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          const m = JSON.parse(line);
          if (m.id !== undefined) waits.get(m.id)?.(m);
        } catch {}
      }
    }
  })();
  const rpc = (method: string, params: any = {}) =>
    new Promise<any>((done) => {
      const i = ++id;
      waits.set(i, done);
      p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n");
    });
  const tool = async (name: string, args: any = {}) => {
    const r = await rpc("tools/call", { name, arguments: args });
    return (r.result?.content ?? []).map((c: any) => c.text ?? "").join("\n");
  };
  try {
    await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const pages = await tool("new_page", { url: `${base}/via-mcp` });
    // The folder's other tab (made above) is there too; nothing from other folders.
    expect(pages).toContain(`${base}/via-mcp`);
    expect(pages).toContain(`${base}/made-by-session`);
    // "3: Page /via-mcp (http://…/via-mcp)" once its title is in, else "3: http://…/via-mcp".
    const pageId = Number(pages.match(/(\d+): [^\n]*via-mcp/)![1]);
    const net = await tool("list_network_requests", { pageId });
    expect(net).toContain(`${base}/api`);
    const src = await tool("evaluate_script", { pageId, function: "() => document.documentElement.outerHTML" });
    expect(src).toContain("<h1>/via-mcp</h1>");
  } finally {
    p.kill();
  }
}, 90_000);

live("tabs outlive a restart of blimpd and its Chrome", async () => {
  const id = await openTab(folder, `${base}/kept`);
  await until(() => browserTabs().some((t) => t.id === id), "the tab");
  await Bun.sleep(700); // tabs.json is written half a second after a change
  await stopBrowser();
  expect(browserTabs()).toEqual([]);
  port = await startBrowserGate();
  const back = await until(() => browserTabs().find((t) => t.url === `${base}/kept`), "the tab back");
  expect(back.folder).toBe(folder);
  // And the session's tab, with who opened it.
  expect(browserTabs().find((t) => t.url === `${base}/made-by-session`)?.openedBy).toBe(session);
}, 30_000);
