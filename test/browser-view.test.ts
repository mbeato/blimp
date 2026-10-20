// A live view of a server browser tab (src/browser/view.ts): frames out, input in, over a real
// Chrome. Skips without Chrome or Chromium.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome, launchChrome, type Chrome } from "../src/browser/chrome";
import { Gate } from "../src/browser/gate";
import { openView } from "../src/browser/view";

const path = findChrome();
const live = path ? test : test.skip;
const tmp = mkdtempSync(join(tmpdir(), "blimp-view-"));
let chrome: Chrome;
let gate: Gate;

const PAGE = `<!doctype html><title>start</title>
<style>body{margin:0} button{position:absolute;left:10px;top:10px;width:100px;height:40px}</style>
<button onclick="document.title='clicked'">b</button>
<form style="position:absolute;top:80px" onsubmit="event.preventDefault();document.title='sent:'+document.querySelector('input').value"><input autofocus></form>
<p style="position:absolute;top:140px" id="p">pick me</p>`;
const site = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (r) => new Response(new URL(r.url).pathname === "/two" ? "<title>two</title>2" : PAGE, { headers: { "content-type": "text/html" } }),
});
const base = `http://127.0.0.1:${site.port}`;

beforeAll(async () => {
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

async function until<T>(f: () => T | Promise<T>, what: string, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(30);
  }
}

// A viewer: the frames and messages it got; it acks each frame as the app does after drawing it.
async function viewer(id: string, autoAck = true) {
  const frames: Uint8Array[] = [];
  const msgs: any[] = [];
  let closed: { code?: number; reason?: string } | undefined;
  let v: Awaited<ReturnType<typeof openView>>;
  v = await openView(chrome, id, {
    send(data) {
      if (typeof data === "string") msgs.push(JSON.parse(data));
      else {
        frames.push(data);
        if (autoAck) queueMicrotask(() => v.message(JSON.stringify({ type: "ack" })));
      }
    },
    close: (code, reason) => (closed = { code, reason }),
  });
  const send = (m: object) => v.message(JSON.stringify(m));
  const info = () => msgs.filter((m) => m.type === "info").at(-1);
  return { v, frames, msgs, send, info, closed: () => closed };
}

const title = async (id: string) => (await chrome.call("Target.getTargetInfo", { targetId: id })).result.targetInfo.title;
const evalIn = async (id: string, expression: string) => {
  const s = (await chrome.call("Target.attachToTarget", { targetId: id, flatten: true })).result.sessionId;
  const r = await chrome.call("Runtime.evaluate", { expression, returnByValue: true }, s);
  await chrome.call("Target.detachFromTarget", { sessionId: s });
  return r.result.result.value;
};

live("frames at the asked size; a click, typing and Enter reach the page", async () => {
  const id = await gate.createTab("/f", base + "/");
  await until(async () => (await title(id)) === "start", "the page");
  const w = await viewer(id);
  expect(w.info()).toMatchObject({ url: base + "/", title: "start", canGoBack: false });
  w.send({ type: "size", width: 400, height: 300, scale: 1 });
  await until(() => w.frames.length > 0, "a frame");
  expect([w.frames[0][0], w.frames[0][1]]).toEqual([0xff, 0xd8]); // a JPEG
  expect(await evalIn(id, "innerWidth")).toBe(400);
  // Frames keep coming while each is acked.
  const before = w.frames.length;
  await evalIn(id, "document.body.style.background='red'");
  await until(() => w.frames.length > before, "a frame after a change");

  for (const event of ["mousePressed", "mouseReleased"]) w.send({ type: "mouse", event, x: 50, y: 30, button: "left", buttons: event === "mousePressed" ? 1 : 0, clickCount: 1, modifiers: 0 });
  await until(async () => (await title(id)) === "clicked", "the click");

  await evalIn(id, "document.querySelector('input').focus()");
  w.send({ type: "text", text: "héllo 👋" });
  w.send({ type: "key", event: "keyDown", key: "Enter", code: "Enter", keyCode: 13, text: "\r", modifiers: 0 });
  w.send({ type: "key", event: "keyUp", key: "Enter", code: "Enter", keyCode: 13, modifiers: 0 });
  await until(async () => (await title(id)) === "sent:héllo 👋", "the form sent");
  w.v.close();
}, 30_000);

live("go, back, forward and reload; the info follows", async () => {
  const id = await gate.createTab("/f", base + "/");
  await until(async () => (await title(id)) === "start", "the page");
  const w = await viewer(id);
  w.send({ type: "go", url: base + "/two" });
  await until(() => w.info()?.url === base + "/two" && w.info()?.title === "two" && w.info()?.canGoBack, "on /two");
  w.send({ type: "nav", action: "back" });
  await until(() => w.info()?.url === base + "/" && w.info()?.canGoForward, "back");
  w.send({ type: "nav", action: "forward" });
  await until(() => w.info()?.url === base + "/two", "forward");
  w.send({ type: "nav", action: "reload" });
  await until(() => w.msgs.some((m) => m.type === "info" && m.loading), "loading");
  await until(() => w.info()?.loading === false, "loaded");
  // Only web addresses.
  w.send({ type: "go", url: "file:///etc/passwd" });
  await Bun.sleep(300);
  expect(w.info()?.url).toBe(base + "/two");
  w.v.close();
}, 30_000);

live("a dialog is shown to the viewer and answered there; copy gives the selection", async () => {
  const id = await gate.createTab("/f", base + "/");
  await until(async () => (await title(id)) === "start", "the page");
  const w = await viewer(id);
  // Select the paragraph, then copy.
  await evalIn(id, "getSelection().selectAllChildren(document.getElementById('p'))");
  w.send({ type: "copy" });
  await until(() => w.msgs.find((m) => m.type === "copied")?.text === "pick me", "copied");
  // A confirm() blocks the page until it's answered.
  void evalIn(id, "document.title = String(confirm('Sure?'))");
  const d = await until(() => w.msgs.find((m) => m.type === "dialog"), "the dialog");
  expect(d).toMatchObject({ kind: "confirm", message: "Sure?" });
  w.send({ type: "dialog", accept: true });
  await until(() => w.msgs.some((m) => m.type === "dialog-closed"), "closed");
  await until(async () => (await title(id)) === "true", "the answer");
  w.v.close();
}, 30_000);

live("two viewers of one tab both get frames; a closed tab ends its views", async () => {
  const id = await gate.createTab("/f", base + "/");
  await until(async () => (await title(id)) === "start", "the page");
  const a = await viewer(id);
  const b = await viewer(id);
  a.send({ type: "size", width: 300, height: 200, scale: 1 });
  b.send({ type: "size", width: 320, height: 240, scale: 2 });
  await until(() => a.frames.length > 0 && b.frames.length > 0, "frames for both");
  await gate.closeTab(id);
  await until(() => a.closed() && b.closed(), "the views to end");
}, 30_000);

live("a tab that isn't there can't be viewed", async () => {
  await expect(openView(chrome, "F00D", { send() {}, close() {} })).rejects.toThrow();
});
