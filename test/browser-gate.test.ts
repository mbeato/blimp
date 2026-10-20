// The gate (src/browser/gate.ts) over a real Chrome: each folder's clients see a browser with only
// that folder's tabs. Skips when the server has no Chrome or Chromium.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome, launchChrome, type CdpMessage, type Chrome } from "../src/browser/chrome";
import { Gate } from "../src/browser/gate";

const path = findChrome();
const live = path ? test : test.skip;
const tmp = mkdtempSync(join(tmpdir(), "blimp-gate-"));
let chrome: Chrome;
let gate: Gate;
let site: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  site = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (r) => new Response(`<title>${new URL(r.url).pathname}</title>hi`, { headers: { "content-type": "text/html" } }) });
  if (!path) return;
  chrome = launchChrome(path, join(tmp, "profile"));
  gate = new Gate(chrome);
  await gate.ready();
});
afterAll(async () => {
  site.stop();
  chrome?.kill();
  await chrome?.exited;
  rmSync(tmp, { recursive: true, force: true });
});

// A client of the gate: every message it got (events and replies, in order), and call().
function client(folder: string, session?: string) {
  const log: CdpMessage[] = [];
  const waits = new Map<number, (m: CdpMessage) => void>();
  let id = 0;
  const conn = gate.connect({
    folder,
    session,
    send(text) {
      const m: CdpMessage = JSON.parse(text);
      log.push(m);
      if (m.id !== undefined) waits.get(m.id)?.(m);
    },
  });
  const call = (method: string, params: any = {}, sessionId?: string) =>
    new Promise<CdpMessage>((done) => {
      const i = ++id;
      waits.set(i, done);
      conn.message(JSON.stringify({ id: i, method, params, ...(sessionId && { sessionId }) }));
    });
  const events = (method: string) => log.filter((m) => m.method === method);
  return { log, call, events, close: conn.close };
}

async function until<T>(f: () => T, what: string, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

live("a folder's clients see its tabs and only its tabs", async () => {
  const a = client("/p/a", "sa");
  const b = client("/p/b", "sb");
  for (const c of [a, b]) {
    await c.call("Target.setDiscoverTargets", { discover: true });
    await c.call("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  }
  const { result } = await a.call("Target.createTarget", { url: "about:blank" });
  const id = result.targetId;
  await until(() => a.events("Target.attachedToTarget").some((m) => m.params.targetInfo.targetId === id), "A attached to its tab");
  expect(a.events("Target.targetCreated").map((m) => m.params.targetInfo.targetId)).toContain(id);
  await Bun.sleep(200);
  expect(b.events("Target.targetCreated")).toEqual([]);
  expect(b.events("Target.attachedToTarget")).toEqual([]);
  expect((await b.call("Target.getTargets")).result.targetInfos).toEqual([]);
  expect((await a.call("Target.getTargets")).result.targetInfos.map((t: any) => t.targetId)).toEqual([id]);
  // B can't reach A's tab by its id.
  expect((await b.call("Target.attachToTarget", { targetId: id, flatten: true })).error?.message).toBe("No target with given id found");
  expect((await b.call("Target.closeTarget", { targetId: id })).error).toBeDefined();
  // A's session works, and answers come back under A's own ids.
  const s = a.events("Target.attachedToTarget").find((m) => m.params.targetInfo.targetId === id)!.params.sessionId;
  const r = await a.call("Runtime.evaluate", { expression: "1 + 1", returnByValue: true }, s);
  expect(r.result.result.value).toBe(2);
  // B can't use A's session either.
  expect((await b.call("Runtime.evaluate", { expression: "1" }, s)).error).toBeDefined();
  expect(gate.tabs().find((t) => t.id === id)).toMatchObject({ folder: "/p/a", openedBy: "sa" });
  a.close();
  b.close();
}, 20_000);

live("a later client of the folder hears of its tabs before the answer, as Chrome does", async () => {
  const id = await gate.createTab("/p/c", `http://127.0.0.1:${site.port}/c`);
  const c = client("/p/c");
  const d = await c.call("Target.setDiscoverTargets", { discover: true });
  const created = c.log.findIndex((m) => m.method === "Target.targetCreated" && m.params.targetInfo.targetId === id);
  expect(created).toBeGreaterThanOrEqual(0);
  expect(created).toBeLessThan(c.log.indexOf(d));
  const at = await c.call("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  const attached = c.log.findIndex((m) => m.method === "Target.attachedToTarget" && m.params.targetInfo.targetId === id);
  expect(attached).toBeGreaterThanOrEqual(0);
  expect(attached).toBeLessThan(c.log.indexOf(at));
  c.close();
}, 20_000);

live("a page a tab opens stays in the tab's folder", async () => {
  const id = await gate.createTab("/p/pop", `http://127.0.0.1:${site.port}/opener`, "s1");
  const att = await chrome.call("Target.attachToTarget", { targetId: id, flatten: true });
  await until(() => gate.tabs().find((t) => t.id === id)?.url.endsWith("/opener"), "the opener to load");
  await chrome.call("Runtime.evaluate", { expression: `window.open("http://127.0.0.1:${site.port}/popup")`, userGesture: true }, att.result.sessionId);
  const popup = await until(() => gate.tabs().find((t) => t.url.endsWith("/popup")), "the popup");
  expect(popup).toMatchObject({ folder: "/p/pop", openedBy: "s1" });
}, 20_000);

live("tabs blimp opens and closes, and the changes it hears of", async () => {
  let changes = 0;
  gate.onChange(() => changes++);
  const id = await gate.createTab("/p/d", `http://127.0.0.1:${site.port}/d`);
  // Its own title comes in through refresh(): Chrome doesn't announce it.
  const end = Date.now() + 5000;
  while (!gate.tabs().some((t) => t.id === id && t.title === "/d") && Date.now() < end) await gate.refresh();
  expect(gate.tabs().find((t) => t.id === id)).toEqual({ id, folder: "/p/d", url: `http://127.0.0.1:${site.port}/d`, title: "/d" });
  expect(changes).toBeGreaterThan(0);
  const before = changes;
  await gate.closeTab(id);
  await until(() => !gate.tabs().some((t) => t.id === id), "the tab to close");
  expect(changes).toBeGreaterThan(before);
}, 20_000);

live("a client can't close or crash the browser everyone shares, or reach another folder's tab by any command", async () => {
  const e = client("/p/e");
  expect((await e.call("Browser.close")).result).toEqual({});
  expect((await e.call("Browser.crash")).error).toBeDefined();
  expect((await e.call("Browser.crashGpuProcess")).error).toBeDefined();
  expect((await chrome.call("Browser.getVersion")).result.product).toMatch(/Chrom/);
  // Nor reach every tab through a browser session, or another client's session by message.
  expect((await e.call("Target.attachToBrowserTarget")).error).toBeDefined();
  expect((await e.call("Target.sendMessageToTarget", { sessionId: "X", message: "{}" })).error).toBeDefined();
  const other = await gate.createTab("/p/other", "about:blank");
  expect((await e.call("Browser.getWindowForTarget", { targetId: other })).error?.message).toBe("No target with given id found");
  e.close();
});

live("blimp's own attach (the app's live view) is never handed to a client attaching at the same time", async () => {
  const id = await gate.createTab("/p/v", `http://127.0.0.1:${site.port}/v`);
  const c = client("/p/v");
  await c.call("Target.setDiscoverTargets", { discover: true });
  // Both at once: blimp's first, then the client's.
  const mine = gate.attachDirect(id);
  const theirs = c.call("Target.attachToTarget", { targetId: id, flatten: true });
  const [sid, r] = await Promise.all([mine, theirs]);
  expect(sid).toBeString();
  expect(r.result.sessionId).toBeString();
  expect(r.result.sessionId).not.toBe(sid);
  // The client's event is its own session, and it can use it.
  await until(() => c.events("Target.attachedToTarget").some((m) => m.params.sessionId === r.result.sessionId), "the client's attach event");
  expect(c.events("Target.attachedToTarget").some((m) => m.params.sessionId === sid)).toBe(false);
  expect((await c.call("Runtime.evaluate", { expression: "2 * 3", returnByValue: true }, r.result.sessionId)).result.result.value).toBe(6);
  c.close();
}, 20_000);
