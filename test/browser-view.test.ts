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
// A long page with a text field at its top, for a phone's touches.
const TALL = `<!doctype html><meta name="viewport" content="width=device-width"><title>tall</title>
<body style="margin:0"><input id="i" style="position:fixed;left:10px;top:10px;width:200px;height:30px"><div style="height:5000px"></div>`;
const site = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (r) => new Response({ "/two": "<title>two</title>2", "/tall": TALL }[new URL(r.url).pathname] ?? PAGE, { headers: { "content-type": "text/html" } }),
});
const base = `http://127.0.0.1:${site.port}`;

// 60 s: a fresh CI runner's first Chrome launch takes 8 to over 20 s, and with test files run side by side
// (--parallel) this file's can be it, not browser-chrome.test.ts's.
beforeAll(async () => {
  if (!path) return;
  chrome = launchChrome(path, join(tmp, "profile"));
  gate = new Gate(chrome);
  await gate.ready();
}, 60_000);
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
  v = await openView(chrome, (t) => gate.attachDirect(t), id, {
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
  expect(w.msgs.find((m) => m.type === "frame")).toEqual({ type: "frame", width: 400, height: 300 });
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

// Every ack lets one more frame out, even acks that come together: Chrome keeps up to 3 unacked,
// so a slow link still has frames on the way while the last is drawn.
live("each ack lets one more frame out, even acks that come together", async () => {
  const id = await gate.createTab("/f", base + "/");
  await until(async () => (await title(id)) === "start", "the page");
  const w = await viewer(id, false);
  w.send({ type: "size", width: 400, height: 300, scale: 1 });
  await evalIn(id, "setInterval(() => (document.body.style.background = document.body.style.background === 'red' ? 'blue' : 'red'), 30)");
  await until(() => w.frames.length === 3, "3 frames before any ack");
  for (const n of [6, 9]) {
    for (let i = 0; i < 3; i++) w.send({ type: "ack" });
    await until(() => w.frames.length === n, `${n} frames after 3 more acks`);
  }
  await Bun.sleep(300);
  expect(w.frames.length).toBe(9);
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
  await expect(openView(chrome, (t) => gate.attachDirect(t), "F00D", { send() {}, close() {} })).rejects.toThrow();
});

live("a tab keeps streaming and taking input when another tab is brought to the front", async () => {
  const id = await gate.createTab("/f", base + "/");
  await until(async () => (await title(id)) === "start", "the page");
  const w = await viewer(id);
  w.send({ type: "size", width: 400, height: 300, scale: 1 });
  await until(() => w.frames.length > 0, "a frame");
  // Another tab comes to the front, as a session's select_page would make it.
  const other = await gate.createTab("/f", "about:blank");
  const s = (await chrome.call("Target.attachToTarget", { targetId: other, flatten: true })).result.sessionId;
  await chrome.call("Page.bringToFront", {}, s);
  await Bun.sleep(300);
  const before = w.frames.length;
  await evalIn(id, "document.body.style.background='blue'");
  await until(() => w.frames.length > before, "a frame from the tab behind", 5000);
  for (const event of ["mousePressed", "mouseReleased"]) w.send({ type: "mouse", event, x: 50, y: 30, button: "left", buttons: event === "mousePressed" ? 1 : 0, clickCount: 1, modifiers: 0 });
  await until(async () => (await title(id)) === "clicked", "the click on the tab behind");
  w.v.close();
}, 30_000);

// A JPEG's width and height, from its start-of-frame marker.
function jpegSize(b: Uint8Array): [number, number] | undefined {
  for (let i = 2; i + 9 < b.length; ) {
    const m = b[i + 1];
    if (m >= 0xc0 && m <= 0xc2) return [(b[i + 7] << 8) | b[i + 8], (b[i + 5] << 8) | b[i + 6]];
    i += 2 + ((b[i + 2] << 8) | b[i + 3]);
  }
}

// Sharp, and light while you use the page: frames at the screen's ratio (a blinking caret or a
// spinner stays sharp), at the page's size (a quarter of the pixels) from a scroll, click or key
// until it's been left alone a moment. At 1x there's nothing sharper to send.
live("frames are sharp, and at the page's size while it's being scrolled, clicked or typed in", async () => {
  const id = await gate.createTab("/f", base + "/");
  await until(async () => (await title(id)) === "start", "the page");
  const w = await viewer(id);
  const last = () => JSON.stringify(jpegSize(w.frames.at(-1) ?? new Uint8Array()));
  w.send({ type: "size", width: 400, height: 300, scale: 2 });
  await until(() => last() === "[800,600]", "a sharp frame");
  expect(w.msgs.filter((m) => m.type === "frame").at(-1)).toEqual({ type: "frame", width: 400, height: 300 });
  // Scrolling: light frames while it goes on.
  const n = w.frames.length;
  const scroll = setInterval(() => w.send({ type: "mouse", event: "mouseWheel", x: 100, y: 100, button: "none", buttons: 0, clickCount: 0, modifiers: 0, deltaX: 0, deltaY: 40 }), 100);
  await evalIn(id, "document.body.style.background='red'");
  await until(() => w.frames.length > n && last() === "[400,300]", "a light frame while scrolling");
  clearInterval(scroll);
  // Left alone: sharp again.
  await until(() => last() === "[800,600]", "sharp again", 3000);
  // At 1x: only frames at the page's size.
  w.send({ type: "size", width: 400, height: 300, scale: 1 });
  await until(() => last() === "[400,300]", "a frame at 1x");
  const m = w.frames.length;
  await evalIn(id, "document.body.style.background='blue'");
  await Bun.sleep(1000);
  expect(w.frames.slice(m).every((f) => JSON.stringify(jpegSize(f)) === "[400,300]")).toBe(true);
  expect(await evalIn(id, "innerWidth")).toBe(400);
  w.v.close();
}, 30_000);

// The phone: a size with mobile set lays the page out as a phone (touch, a phone's user agent), and
// the screen used last sets the size, so the Mac's comes back once the phone leaves or is used again.
const PHONE = { type: "size", width: 390, height: 700, scale: 2, mobile: true };
const layout = (id: string) => evalIn(id, "JSON.stringify({ w: innerWidth, coarse: matchMedia('(pointer: coarse)').matches, android: /Android/.test(navigator.userAgent) })");

live("a phone view lays the page out as a phone; the Mac's size comes back when it leaves", async () => {
  const id = await gate.createTab("/f", base + "/tall");
  await until(async () => (await title(id)) === "tall", "the page");
  const mac = await viewer(id);
  mac.send({ type: "size", width: 800, height: 600, scale: 1 });
  await until(async () => (await layout(id)) === JSON.stringify({ w: 800, coarse: false, android: false }), "the Mac's layout");
  const phone = await viewer(id);
  phone.send(PHONE);
  await until(async () => (await layout(id)) === JSON.stringify({ w: 390, coarse: true, android: true }), "the phone's layout");
  // Both still get frames, the Mac's at the phone's page size.
  const n = mac.frames.length;
  await evalIn(id, "document.body.style.background='red'");
  await until(() => mac.frames.length > n, "a frame for the Mac");
  expect(mac.msgs.filter((m) => m.type === "frame").at(-1)).toEqual({ type: "frame", width: 390, height: 700 });
  phone.v.close();
  await until(async () => (await layout(id)) === JSON.stringify({ w: 800, coarse: false, android: false }), "the Mac's layout again");
  mac.v.close();
}, 30_000);

live("using a screen takes the size: a click on the Mac, then a touch on the phone", async () => {
  const id = await gate.createTab("/f", base + "/tall");
  await until(async () => (await title(id)) === "tall", "the page");
  const mac = await viewer(id);
  mac.send({ type: "size", width: 800, height: 600, scale: 1 });
  const phone = await viewer(id);
  phone.send(PHONE);
  await until(async () => (await layout(id)).includes('"w":390'), "the phone's size");
  // A pointer passing over the Mac's page isn't using it.
  mac.send({ type: "mouse", event: "mouseMoved", x: 300, y: 300, button: "none", buttons: 0, clickCount: 0, modifiers: 0 });
  await Bun.sleep(300);
  expect(await layout(id)).toContain('"w":390');
  mac.send({ type: "mouse", event: "mousePressed", x: 300, y: 300, button: "left", buttons: 1, clickCount: 1, modifiers: 0 });
  mac.send({ type: "mouse", event: "mouseReleased", x: 300, y: 300, button: "left", buttons: 0, clickCount: 1, modifiers: 0 });
  await until(async () => (await layout(id)) === JSON.stringify({ w: 800, coarse: false, android: false }), "the Mac's size after its click");
  phone.send({ type: "touch", event: "touchStart", points: [{ x: 200, y: 400, id: 1 }] });
  phone.send({ type: "touch", event: "touchEnd", points: [] });
  await until(async () => (await layout(id)) === JSON.stringify({ w: 390, coarse: true, android: true }), "the phone's size after its touch");
  mac.v.close();
  phone.v.close();
}, 30_000);

live("a swipe scrolls the page and keeps gliding; a tap says whether a text field took it", async () => {
  const id = await gate.createTab("/f", base + "/tall");
  await until(async () => (await title(id)) === "tall", "the page");
  const phone = await viewer(id);
  phone.send(PHONE);
  await until(async () => (await layout(id)).includes('"w":390'), "the phone's size");
  phone.send({ type: "touch", event: "touchStart", points: [{ x: 200, y: 600, id: 1 }] });
  for (let y = 560; y >= 280; y -= 40) {
    phone.send({ type: "touch", event: "touchMove", points: [{ x: 200, y, id: 1 }] });
    await Bun.sleep(8);
  }
  phone.send({ type: "touch", event: "touchEnd", points: [] });
  await until(async () => (await evalIn(id, "scrollY")) > 0, "a scroll");
  const released = await evalIn(id, "scrollY");
  await until(async () => (await evalIn(id, "scrollY")) > released + 50, "the glide after the finger lifts");

  const tap = (x: number, y: number) => {
    phone.send({ type: "touch", event: "touchStart", points: [{ x, y, id: 2 }] });
    phone.send({ type: "touch", event: "touchEnd", points: [] });
  };
  // A tap while it glides only stops the glide, as on a phone: wait for it to settle.
  let last = -1;
  await until(async () => {
    const y = await evalIn(id, "scrollY");
    return y === last || ((last = y), (await Bun.sleep(200), false));
  }, "the glide to stop");
  tap(50, 25);
  await until(() => phone.msgs.filter((m) => m.type === "focus").at(-1)?.editable === true, "a text field focused");
  expect(await evalIn(id, "document.activeElement.id")).toBe("i");
  tap(200, 400);
  await until(() => phone.msgs.filter((m) => m.type === "focus").at(-1)?.editable === false, "no text field focused");
  phone.v.close();
}, 30_000);
