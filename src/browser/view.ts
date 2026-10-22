// A live view of one server browser tab, for the app (GET /browser/tabs/<id>/view). blimpd opens
// its own CDP session on the tab, straight on Chrome's pipe beside the gate, and streams
// Page.startScreencast frames (JPEG, binary messages). Chrome keeps at most 3 frames unacked
// (each ack lets one more out), and blimpd acks only when the app says it drew one, so a slow link
// gets fewer frames instead of a queue. Input, navigation, the view's size, dialogs and copy come back as
// JSON (docs/DESIGN.md, Server browser). A phone's view lays the page out as a phone's (touch, a
// phone's user agent), and the view used last sets the page's size (see `tabs`).

import { phoneUserAgentFor, type CdpMessage, type Chrome } from "./chrome";

export type ViewSocket = { send(data: string | Uint8Array): void; close(code?: number, reason?: string): void };

const MOUSE = new Set(["mousePressed", "mouseReleased", "mouseMoved", "mouseWheel"]);
const KEY = new Set(["keyDown", "keyUp", "rawKeyDown", "char"]);
const TOUCH = new Set(["touchStart", "touchMove", "touchEnd", "touchCancel"]);
const clamp = (n: unknown, lo: number, hi: number, d: number) => (typeof n === "number" && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

// What the selection is: text selected in the focused text field, else the page's selection.
const SELECTION = `(() => {
  const a = document.activeElement;
  if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA") && typeof a.selectionStart === "number" && a.selectionStart !== a.selectionEnd) return a.value.slice(a.selectionStart, a.selectionEnd);
  return String(getSelection());
})()`;

// Whether what has focus takes typing, so a phone shows its keyboard.
const EDITABLE = `(() => {
  const a = document.activeElement;
  if (!a) return false;
  if (a.isContentEditable || a.tagName === "TEXTAREA") return true;
  return a.tagName === "INPUT" && !/^(button|checkbox|color|file|hidden|image|radio|range|reset|submit)$/i.test(a.type);
})()`;

// The phone's user agent, from this Chrome's version: asked once per Chrome.
const phoneAgents = new WeakMap<Chrome, Promise<string>>();
function phoneAgent(chrome: Chrome) {
  let ua = phoneAgents.get(chrome);
  if (!ua) phoneAgents.set(chrome, (ua = chrome.call("Browser.getVersion").then((v) => phoneUserAgentFor(String(v.result?.product ?? "")))));
  return ua;
}

// Each tab's views, and the one whose size the page has: the one used last (sent a size, or input
// that's more than a pointer passing over). Chrome keeps the size of the CDP session that set it
// last and drops it when that session leaves, so blimpd sets the next one itself: when the owner
// closes, the newest view with a size takes over. `pending`: the last change of owner, which input
// waits for, so a click lands on the page laid out for the screen it came from.
type Owner = { size(): Size | null; take(): Promise<unknown>; drop(): Promise<unknown> };
type Size = { width: number; height: number; scale: number; mobile: boolean };
const tabs = new Map<string, { views: Owner[]; owner: Owner | null; pending: Promise<unknown> }>();

// attach: the gate's attachDirect, so the view's session is never taken for a client's.
export async function openView(chrome: Chrome, attach: (targetId: string) => Promise<string | undefined>, targetId: string, sock: ViewSocket): Promise<{ message(text: string): void; close(): void }> {
  const s = await attach(targetId);
  if (!s) throw new Error("That browser tab is closed.");
  const call = (method: string, params: any = {}) => chrome.call(method, params, s);
  let closed = false;
  // Chrome keeps up to 3 frames unacked. They carry the screencast's id, not their own, and every
  // ack lets one more out, so each of the app's acks is passed on, even two that come together.
  let frame: number | null = null; // the screencast's id, from its frames
  let owed = 0; // frames sent to the app it hasn't acked
  // Sharp, and light while in use: Chrome draws at 2x and the screencast sends frames at the
  // screen's ratio, but from a scroll, click, drag or key until 400 ms after the last, at the
  // page's size (a quarter of the pixels), so what you do shows sooner on a slow link.
  let size: Size | null = null;
  let light = false;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const cast = async () => {
    if (!size) return;
    const k = light ? 1 : size.scale;
    frame = null;
    owed = 0;
    await call("Page.stopScreencast");
    await call("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: Math.round(size.width * k), maxHeight: Math.round(size.height * k), everyNthFrame: 1 });
  };
  // What this view set on the page, while it's the owner, and taking it off again for the next one.
  let set: Size | null = null;
  const me: Owner = {
    size: () => size,
    async take() {
      if (!size) return;
      const was = set;
      set = size;
      await call("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: size.scale, mobile: size.mobile });
      if (size.mobile === !!was?.mobile) return;
      await call("Emulation.setTouchEmulationEnabled", { enabled: size.mobile, ...(size.mobile && { maxTouchPoints: 5 }) });
      await call("Emulation.setUserAgentOverride", { userAgent: size.mobile ? await phoneAgent(chrome) : "" });
    },
    async drop() {
      const was = set;
      set = null;
      if (!was) return;
      await call("Emulation.clearDeviceMetricsOverride");
      if (!was.mobile) return;
      await call("Emulation.setTouchEmulationEnabled", { enabled: false });
      await call("Emulation.setUserAgentOverride", { userAgent: "" });
    },
  };
  let tab = tabs.get(targetId);
  if (!tab) tabs.set(targetId, (tab = { views: [], owner: null, pending: Promise.resolve() }));
  const shared = tab;
  shared.views.push(me);
  // This view's size goes on the page (again, if it changed), after any change already under way.
  const claim = () => {
    if (!size) return;
    const was = shared.owner;
    shared.owner = me;
    shared.pending = shared.pending.then(async () => {
      if (was && was !== me) await was.drop();
      await me.take();
    });
  };
  // Input: in order, once the page is laid out for this view. Using the page claims it.
  const send = (using: boolean, method: string, params: object) => {
    if (using) {
      busy();
      if (shared.owner !== me) claim();
    }
    return (input = shared.pending.then(() => call(method, params)));
  };
  const busy = () => {
    if (!size || size.scale <= 1) return;
    clearTimeout(idle);
    idle = setTimeout(() => ((light = false), void cast()), 400);
    if (!light) (light = true), void cast();
  };
  let loading = false;
  // The last input sent: Chrome answers it once the page has handled it. Runtime.evaluate reaches
  // the page another way and can overtake it, so the selection is read only after.
  let input: Promise<unknown> = Promise.resolve();

  const text = (m: object) => !closed && sock.send(JSON.stringify(m));
  const info = async () => {
    const [h, t] = await Promise.all([call("Page.getNavigationHistory"), chrome.call("Target.getTargetInfo", { targetId })]);
    const entries: { id: number; url: string }[] = h.result?.entries ?? [];
    const i: number = h.result?.currentIndex ?? 0;
    text({ type: "info", url: entries[i]?.url ?? t.result?.targetInfo?.url ?? "", title: t.result?.targetInfo?.title ?? "", loading, canGoBack: i > 0, canGoForward: i < entries.length - 1 });
  };
  const history = async (step: number) => {
    const h = await call("Page.getNavigationHistory");
    const e = h.result?.entries?.[(h.result?.currentIndex ?? 0) + step];
    if (e) await call("Page.navigateToHistoryEntry", { entryId: e.id });
  };

  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(idle);
    off();
    void call("Page.stopScreencast");
    void chrome.call("Target.detachFromTarget", { sessionId: s });
    // Leaving takes this view's size off the page (Chrome drops it with the session); the newest
    // view left with a size puts its own on.
    shared.views.splice(shared.views.indexOf(me), 1);
    if (!shared.views.length && tabs.get(targetId) === shared) tabs.delete(targetId);
    if (shared.owner !== me) return;
    shared.owner = shared.views.findLast((v) => v.size()) ?? null;
    const next = shared.owner;
    if (next) shared.pending = shared.pending.then(() => next.take());
  };

  const off = chrome.onMessage((m: CdpMessage) => {
    // The tab closed (or Chrome detached the view): the view ends.
    if (m.method === "Target.detachedFromTarget" && m.params?.sessionId === s) {
      close();
      return sock.close(1000, "Tab closed");
    }
    if (m.sessionId !== s || closed) return;
    const p = m.params ?? {};
    switch (m.method) {
      // Each frame's page size (CSS pixels) comes just before it: headless Chrome's frames are at
      // that size whatever the device scale, so the app can't tell it from the frame's pixels.
      case "Page.screencastFrame":
        frame = p.sessionId;
        owed++;
        text({ type: "frame", width: p.metadata?.deviceWidth, height: p.metadata?.deviceHeight });
        return sock.send(Buffer.from(p.data, "base64"));
      case "Page.frameNavigated":
        if (!p.frame?.parentId) void info();
        return;
      case "Page.navigatedWithinDocument":
        if (p.frameId === targetId) void info();
        return;
      case "Page.frameStartedLoading":
      case "Page.frameStoppedLoading":
        if (p.frameId !== targetId) return;
        loading = m.method === "Page.frameStartedLoading";
        return void info();
      case "Page.javascriptDialogOpening":
        return text({ type: "dialog", kind: p.type, message: p.message ?? "", defaultPrompt: p.defaultPrompt ?? "" });
      case "Page.javascriptDialogClosed":
        return text({ type: "dialog-closed" });
    }
  });

  await call("Page.enable");
  await info();

  return {
    close,
    message(raw: string) {
      if (closed) return;
      let m: any;
      try {
        m = JSON.parse(raw);
      } catch {
        return;
      }
      switch (m?.type) {
        case "ack":
          if (frame !== null && owed > 0) owed--, void call("Page.screencastFrameAck", { sessionId: frame });
          return;
        case "size": {
          const width = Math.round(clamp(m.width, 1, 8000, 800));
          const height = Math.round(clamp(m.height, 1, 8000, 600));
          const scale = clamp(m.scale, 0.5, 4, 1);
          size = { width, height, scale, mobile: m.mobile === true };
          claim();
          void shared.pending.then(cast);
          return;
        }
        case "mouse":
          if (!MOUSE.has(m.event)) return;
          // Not a pointer passing over.
          return void send(m.event !== "mouseMoved" || !!m.buttons, "Input.dispatchMouseEvent", {
            type: m.event,
            x: clamp(m.x, -1e5, 1e5, 0),
            y: clamp(m.y, -1e5, 1e5, 0),
            button: ["none", "left", "middle", "right", "back", "forward"].includes(m.button) ? m.button : "none",
            buttons: clamp(m.buttons, 0, 31, 0),
            clickCount: clamp(m.clickCount, 0, 3, 0),
            modifiers: clamp(m.modifiers, 0, 15, 0),
            deltaX: clamp(m.deltaX, -1e5, 1e5, 0),
            deltaY: clamp(m.deltaY, -1e5, 1e5, 0),
          });
        case "key":
          if (!KEY.has(m.event)) return;
          return void send(true, "Input.dispatchKeyEvent", {
            type: m.event,
            key: str(m.key),
            code: str(m.code),
            windowsVirtualKeyCode: clamp(m.keyCode, 0, 255, 0),
            nativeVirtualKeyCode: clamp(m.keyCode, 0, 255, 0),
            text: str(m.text),
            unmodifiedText: str(m.text),
            modifiers: clamp(m.modifiers, 0, 15, 0),
          });
        case "text":
          if (typeof m.text === "string" && m.text) send(true, "Input.insertText", { text: m.text });
          return;
        // A phone's fingers: the ones down after the change (none once the last lifts). Chrome
        // scrolls, glides, taps and zooms from them. After a lift, whether a text field has focus.
        case "touch": {
          if (!TOUCH.has(m.event) || !Array.isArray(m.points)) return;
          const touchPoints = m.points.slice(0, 5).map((p: any, i: number) => ({ x: clamp(p?.x, -1e5, 1e5, 0), y: clamp(p?.y, -1e5, 1e5, 0), id: Math.round(clamp(p?.id, 0, 1e6, i)) }));
          const done = send(true, "Input.dispatchTouchEvent", { type: m.event, touchPoints });
          if (m.event === "touchEnd")
            void done
              .then(() => call("Runtime.evaluate", { expression: EDITABLE, returnByValue: true }))
              .then((r) => text({ type: "focus", editable: r.result?.result?.value === true }));
          return;
        }
        case "go":
          if (typeof m.url === "string" && /^https?:\/\/[^/\s]/i.test(m.url)) void call("Page.navigate", { url: m.url });
          return;
        case "nav":
          if (m.action === "back") void history(-1);
          else if (m.action === "forward") void history(1);
          else if (m.action === "reload") void call("Page.reload");
          return;
        case "copy":
          return void input
            .then(() => call("Runtime.evaluate", { expression: SELECTION, returnByValue: true }))
            .then((r) => text({ type: "copied", text: String(r.result?.result?.value ?? "") }));
        case "dialog":
          return void call("Page.handleJavaScriptDialog", { accept: !!m.accept, ...(typeof m.text === "string" && { promptText: m.text }) });
      }
    },
  };
}
