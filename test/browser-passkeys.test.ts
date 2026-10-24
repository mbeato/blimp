// A page that asks for a passkey (src/browser/passkeys.ts): Chrome's own passkey dialog can't be
// seen in headless Chrome, and while it's open the page takes no input. Over a real Chrome; skips
// without Chrome or Chromium.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome, launchChrome, type Chrome } from "../src/browser/chrome";
import { Gate } from "../src/browser/gate";
import { keepPasskeyDialogsOff } from "../src/browser/passkeys";
import { openView } from "../src/browser/view";

const path = findChrome();
const live = path ? test : test.skip;
const tmp = mkdtempSync(join(tmpdir(), "blimp-passkeys-"));
let chrome: Chrome;
let gate: Gate;

const ask = (what: "get" | "create") =>
  what === "get"
    ? "navigator.credentials.get({publicKey:{challenge:new Uint8Array(32),timeout:2000}})"
    : "navigator.credentials.create({publicKey:{challenge:new Uint8Array(32),rp:{name:'t'},user:{id:new Uint8Array(8),name:'u',displayName:'u'},pubKeyCredParams:[{type:'public-key',alg:-7}],timeout:2000}})";
const PAGE = `<!doctype html><title>start</title>
<style>body{margin:0} button{position:absolute;left:10px;width:100px;height:40px}</style>
<button style="top:10px" onclick="document.title='clicked'">b</button>
<button style="top:60px" onclick="window.r='asking';${ask("get")}.then(()=>window.r='ok',(e)=>window.r=e.name)">get</button>
<button style="top:110px" onclick="window.r='asking';${ask("create")}.then(()=>window.r='ok',(e)=>window.r=e.name)">create</button>`;
const site = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(PAGE, { headers: { "content-type": "text/html" } }) });
// localhost, not 127.0.0.1: a passkey's site has to be a name.
const base = `http://localhost:${site.port}`;

beforeAll(async () => {
  if (!path) return;
  chrome = launchChrome(path, join(tmp, "profile"));
  gate = new Gate(chrome);
  keepPasskeyDialogsOff(chrome, (t) => gate.attachDirect(t));
  await gate.ready();
});
afterAll(async () => {
  site.stop();
  chrome?.kill();
  await chrome?.exited;
  rmSync(tmp, { recursive: true, force: true });
});

async function until<T>(f: () => T | Promise<T>, what: string, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(30);
  }
}

const title = async (id: string) => (await chrome.call("Target.getTargetInfo", { targetId: id })).result.targetInfo.title;
const evalIn = async (id: string, expression: string) => {
  const s = (await chrome.call("Target.attachToTarget", { targetId: id, flatten: true })).result.sessionId;
  const r = await chrome.call("Runtime.evaluate", { expression, returnByValue: true }, s);
  await chrome.call("Target.detachFromTarget", { sessionId: s });
  return r.result.result.value;
};
const view = () => ({ send() {}, close() {} });
const click = (v: Awaited<ReturnType<typeof openView>>, y: number) => {
  for (const event of ["mousePressed", "mouseReleased"]) v.message(JSON.stringify({ type: "mouse", event, x: 50, y, button: "left", buttons: event === "mousePressed" ? 1 : 0, clickCount: 1, modifiers: 0 }));
};

for (const what of ["get", "create"] as const)
  live(`a page that asks for a passkey (${what}) still takes clicks, after views come and go; the page hears no`, async () => {
    const id = await gate.createTab("/f", base + "/");
    await until(async () => (await title(id)) === "start", "the page");
    // Chrome turns the setting off for the whole tab whenever any session on it leaves.
    (await openView(chrome, (t) => gate.attachDirect(t), id, view())).close();
    const v = await openView(chrome, (t) => gate.attachDirect(t), id, view());
    click(v, what === "get" ? 80 : 130);
    await until(async () => (await evalIn(id, "window.r")) === "asking", "the passkey ask");
    await Bun.sleep(1000); // Chrome's dialog takes a moment to open; a click before it gets through
    click(v, 30);
    await until(async () => (await title(id)) === "clicked", "the click after the ask");
    // Nothing answers it: no passkey is made or used, and the page hears no when its own wait ends.
    await until(async () => (await evalIn(id, "window.r")) === "NotAllowedError", "the page's no", 6000);
    v.close();
    await gate.closeTab(id);
  }, 30_000);
