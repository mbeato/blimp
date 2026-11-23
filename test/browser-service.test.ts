// The server browser in blimpd (src/browser/service.ts): the gate's listener, a real zmx session
// connecting as itself, the MCP a session runs (blimpd browser-mcp, through npx), and tabs that
// outlive a restart. Its own blimp dir (BLIMPD_SOCKET); the zmx session is blimptest-* and killed
// at the end. Skips without Chrome; the MCP test also without npx.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "blimp-browser-")));
process.env.BLIMPD_SOCKET = join(tmp, "blimp", "blimpd.sock");
mkdirSync(join(tmp, "blimp"), { recursive: true });
const folder = join(tmp, "project");
mkdirSync(folder);

const { findChrome } = await import("../src/browser/chrome");
const { browserTabs, startBrowserGate, stopBrowser, openTab, sleepIdleTabs, wakeTab, closeTab, viewTab, SLEEP_AFTER } = await import("../src/browser/service");
const { HttpError } = await import("../src/files");
const { browserDir, gateKey, browserMcpConfigPath, portFile } = await import("../src/browser/mcp");
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

// 60 s: a fresh CI runner's first Chrome launch takes 8 to over 20 s, and with test files run side by side
// (--parallel) this file's can be it, not browser-chrome.test.ts's.
beforeAll(async () => {
  if (!findChrome()) return;
  Bun.spawnSync([zmxPath(), "attach", session, "sh"], { env: zmxEnv(), cwd: folder, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  await until(() => parseZmxList(Bun.spawnSync([zmxPath(), "list"], { env: zmxEnv() }).stdout.toString()).some((s) => s.name === session), "the zmx session");
  port = await startBrowserGate();
}, 60_000);
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

live("the gate writes its port and the MCP config sessions get: blimp's own and the browser's", () => {
  expect(Number(readFileSync(portFile(), "utf8"))).toBe(port);
  const config = JSON.parse(readFileSync(browserMcpConfigPath(), "utf8"));
  expect(config.mcpServers.blimp.args.at(-1)).toBe("visuals-mcp");
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
    // The guard for the pinned MCP: a tool call on a page marks it used (sleeping tabs).
    const untouched = await openTab(folder, `${base}/untouched`);
    await until(() => browserTabs().some((t) => t.id === untouched), "the untouched tab");
    await Bun.sleep(30);
    const mid = Date.now();
    await tool("list_console_messages", { pageId });
    await sleepIdleTabs(Date.now(), Date.now() - mid);
    expect(browserTabs().find((t) => t.url === `${base}/via-mcp`)?.asleep).toBeUndefined();
    expect(browserTabs().find((t) => t.id === untouched)?.asleep).toBe(true);
    // The tests below expect their tabs awake, and none asleep.
    for (const t of browserTabs().filter((t) => t.asleep)) await wakeTab(t.id);
  } finally {
    p.kill();
  }
}, 90_000);

live("tabs outlive a restart of blimpd and its Chrome", async () => {
  const id = await openTab(folder, `${base}/kept`);
  await until(() => browserTabs().some((t) => t.id === id), "the tab");
  // tabs.json is written half a second after the last change, and a title that comes in late puts it
  // off; a stop drops a write still to come (runs 40137489265 and 40137899113).
  await until(() => readFileSync(join(browserDir(), "tabs.json"), "utf8").includes(`${base}/kept`), "the tab in tabs.json");
  await stopBrowser();
  expect(browserTabs()).toEqual([]);
  port = await startBrowserGate();
  const back = await until(() => browserTabs().find((t) => t.url === `${base}/kept`), "the tab back");
  expect(back.folder).toBe(folder);
  // And the session's tab, with who opened it.
  expect(browserTabs().find((t) => t.url === `${base}/made-by-session`)?.openedBy).toBe(session);
}, 30_000);

// As after an update: the last blimpd's Chrome still holds the profile for a moment (it quits
// some seconds after losing its pipe), so the first Chrome this one starts quits at once (code 21).
live("tabs come back when the last blimpd's Chrome still holds the profile as this one starts", async () => {
  await stopBrowser();
  const { launchChrome } = await import("../src/browser/chrome");
  const old = launchChrome(findChrome()!, join(browserDir(), "profile"));
  await Bun.sleep(500);
  setTimeout(() => old.kill(), 2000);
  port = await startBrowserGate();
  await until(() => browserTabs().some((t) => t.url === `${base}/kept`), "the tab back", 20_000);
}, 40_000);

// A Chrome that dies by itself (a crash, or killed) comes back with its tabs without waiting for
// something to need it.
live("tabs come back after Chrome dies by itself", async () => {
  await until(() => browserTabs().some((t) => t.url === `${base}/kept`), "the tab");
  const pids = Bun.spawnSync(["pgrep", "-f", `user-data-dir=${join(browserDir(), "profile")}`]).stdout.toString().trim().split("\n").filter(Boolean);
  expect(pids.length).toBeGreaterThan(0);
  for (const pid of pids) Bun.spawnSync(["kill", "-9", pid]);
  await until(() => browserTabs().length === 0, "the tabs gone with Chrome");
  await until(() => browserTabs().some((t) => t.url === `${base}/kept`), "the tab back", 20_000);
}, 40_000);

// Sleeping tabs (docs/superpowers/specs/2026-11-23-sleeping-tabs-design.md). Last: the tests above
// expect their tabs awake.
const far = () => Date.now() + 2 * SLEEP_AFTER; // every tab without a view is past the limit
const saved = (): any[] => {
  try {
    return JSON.parse(readFileSync(join(browserDir(), "tabs.json"), "utf8"));
  } catch {
    return [];
  }
};

live("a tab nobody used for the limit sleeps, and stays in the list", async () => {
  const old = await openTab(folder, `${base}/old`);
  await until(() => browserTabs().some((t) => t.id === old), "the old tab");
  await Bun.sleep(30);
  const mid = Date.now();
  const fresh = await openTab(folder, `${base}/fresh`);
  await until(() => browserTabs().some((t) => t.id === fresh), "the fresh tab");
  const c = await cdp(`/s/${session}`);
  await c.call("Target.setDiscoverTargets", { discover: true });
  await sleepIdleTabs(Date.now(), Date.now() - mid);
  expect(browserTabs().find((t) => t.id === old)).toMatchObject({ id: old, folder, url: `${base}/old`, asleep: true });
  expect(browserTabs().find((t) => t.id === fresh)?.asleep).toBeUndefined();
  // Saved before Chrome closed it.
  expect(saved().find((t) => t.url === `${base}/old`)).toMatchObject({ id: old, asleep: true });
  const row = saved().find((t) => t.url === `${base}/fresh`);
  expect(row.usedAt).toBeNumber();
  expect(row.madeAt).toBeNumber();
  // To a session, it's closed.
  await until(() => c.log.some((m) => m.method === "Target.targetDestroyed" && m.params.targetId === old), "targetDestroyed for the old tab");
  const { result } = await c.call("Target.getTargets");
  expect(result.targetInfos.map((t: any) => t.url)).not.toContain(`${base}/old`);
  c.ws.close();
}, 30_000);

live("a tab with a view open doesn't sleep; it does once the view closes and the limit passes", async () => {
  const id = await openTab(folder, `${base}/watched`);
  await until(() => browserTabs().some((t) => t.id === id), "the watched tab");
  const v = await viewTab(id, { send() {}, close() {} });
  await sleepIdleTabs(far());
  expect(browserTabs().find((t) => t.id === id)?.asleep).toBeUndefined();
  v.close();
  await sleepIdleTabs(far());
  expect(browserTabs().find((t) => t.id === id)?.asleep).toBe(true);
}, 30_000);

live("waking a tab: a new id, the same folder, address, opener and place", async () => {
  await sleepIdleTabs(far());
  const old = browserTabs().find((t) => t.url === `${base}/made-by-session`)!;
  expect(old).toMatchObject({ openedBy: session, asleep: true });
  const after = await openTab(folder, `${base}/after`);
  await until(() => browserTabs().some((t) => t.id === after), "the tab after it");
  const at = browserTabs().findIndex((t) => t.id === old.id);
  expect(at).toBeLessThan(browserTabs().findIndex((t) => t.id === after));
  const id2 = await wakeTab(old.id);
  expect(id2).not.toBe(old.id);
  const tabs = browserTabs();
  expect(tabs.some((t) => t.id === old.id)).toBe(false);
  const woken = tabs.find((t) => t.id === id2)!;
  expect(woken).toMatchObject({ folder, url: `${base}/made-by-session`, openedBy: session });
  expect(woken.asleep).toBeUndefined();
  expect(tabs.indexOf(woken)).toBe(at);
  const again = wakeTab(old.id);
  await expect(again).rejects.toBeInstanceOf(HttpError);
  await expect(again).rejects.toMatchObject({ status: 404 });
}, 30_000);

live("two wakes of one tab at once make one tab", async () => {
  await sleepIdleTabs(far());
  const s = browserTabs().find((t) => t.url === `${base}/old`)!;
  expect(s.asleep).toBe(true);
  const [a, b] = await Promise.all([wakeTab(s.id), wakeTab(s.id)]);
  expect(a).toBe(b);
  expect(browserTabs().filter((t) => t.url === `${base}/old`).map((t) => t.id)).toEqual([a]);
}, 30_000);

live("closing a sleeping tab removes it", async () => {
  await sleepIdleTabs(far());
  const s = browserTabs().find((t) => t.url === `${base}/fresh`)!;
  expect(s.asleep).toBe(true);
  await closeTab(s.id);
  expect(browserTabs().some((t) => t.id === s.id)).toBe(false);
  await until(() => !saved().some((t) => t.url === `${base}/fresh`), "the tab gone from tabs.json");
}, 30_000);

live("over a restart: sleeping tabs stay asleep and don't load, a tab just used loads", async () => {
  await sleepIdleTabs(far());
  const sleeping = browserTabs().filter((t) => t.asleep);
  expect(sleeping.length).toBeGreaterThan(0);
  await openTab(folder, `${base}/recent`);
  await until(() => saved().some((t) => t.url === `${base}/recent` && !t.asleep), "the recent tab in tabs.json");
  await stopBrowser();
  port = await startBrowserGate();
  await until(() => browserTabs().some((t) => t.url === `${base}/recent` && !t.asleep), "the recent tab back, awake", 20_000);
  expect(browserTabs().find((t) => t.id === sleeping[0].id)).toMatchObject({ url: sleeping[0].url, asleep: true });
  const c = await cdp(`/s/${session}`);
  const urls = await until(async () => {
    const u: string[] = (await c.call("Target.getTargets")).result.targetInfos.map((t: any) => t.url);
    return u.includes(`${base}/recent`) && u;
  }, "the recent tab in Chrome");
  for (const t of sleeping) expect(urls).not.toContain(t.url);
  c.ws.close();
}, 40_000);

live("tabs from before this change (no usedAt) come back asleep, and Chrome doesn't start for them", async () => {
  await stopBrowser();
  writeFileSync(join(browserDir(), "tabs.json"), JSON.stringify([{ folder, url: `${base}/legacy-a` }, { folder, url: `${base}/legacy-b`, openedBy: session }]));
  port = await startBrowserGate();
  const tabs = browserTabs();
  expect(tabs.map((t) => t.url)).toEqual([`${base}/legacy-a`, `${base}/legacy-b`]);
  for (const t of tabs) expect(t).toMatchObject({ folder, title: "", asleep: true });
  for (const t of tabs) expect(t.id).toBeString();
  expect(tabs[0].openedBy).toBeUndefined();
  expect(tabs[1].openedBy).toBe(session);
  await Bun.sleep(1500);
  expect(Bun.spawnSync(["pgrep", "-f", `user-data-dir=${join(browserDir(), "profile")}`]).stdout.toString().trim()).toBe("");
  const id = await wakeTab(tabs[0].id);
  expect(browserTabs()[0]).toMatchObject({ id, url: `${base}/legacy-a` });
  expect(browserTabs()[0].asleep).toBeUndefined();
}, 40_000);
