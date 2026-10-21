// A live view of one server browser tab, for the app (GET /browser/tabs/<id>/view). blimpd opens
// its own CDP session on the tab, straight on Chrome's pipe beside the gate, and streams
// Page.startScreencast frames (JPEG, binary messages). Chrome sends the next frame only once the
// last is acked, and blimpd acks only when the app says it drew it, so a slow link gets fewer
// frames instead of a queue. Input, navigation, the view's size, dialogs and copy come back as
// JSON (docs/DESIGN.md, Server browser).

import type { CdpMessage, Chrome } from "./chrome";

export type ViewSocket = { send(data: string | Uint8Array): void; close(code?: number, reason?: string): void };

const MOUSE = new Set(["mousePressed", "mouseReleased", "mouseMoved", "mouseWheel"]);
const KEY = new Set(["keyDown", "keyUp", "rawKeyDown", "char"]);
const clamp = (n: unknown, lo: number, hi: number, d: number) => (typeof n === "number" && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

// What the selection is: text selected in the focused text field, else the page's selection.
const SELECTION = `(() => {
  const a = document.activeElement;
  if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA") && typeof a.selectionStart === "number" && a.selectionStart !== a.selectionEnd) return a.value.slice(a.selectionStart, a.selectionEnd);
  return String(getSelection());
})()`;

// attach: the gate's attachDirect, so the view's session is never taken for a client's.
export async function openView(chrome: Chrome, attach: (targetId: string) => Promise<string | undefined>, targetId: string, sock: ViewSocket): Promise<{ message(text: string): void; close(): void }> {
  const s = await attach(targetId);
  if (!s) throw new Error("That browser tab is closed.");
  const call = (method: string, params: any = {}) => chrome.call(method, params, s);
  let closed = false;
  let frame: number | null = null; // the frame Chrome waits to have acked
  // Sharp: Chrome draws at 2x and the screencast sends frames at the screen's ratio, always.
  let size: { width: number; height: number; scale: number } | null = null;
  const cast = async () => {
    if (!size) return;
    frame = null;
    await call("Page.stopScreencast");
    await call("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: Math.round(size.width * size.scale), maxHeight: Math.round(size.height * size.scale), everyNthFrame: 1 });
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
    off();
    void call("Page.stopScreencast");
    void chrome.call("Target.detachFromTarget", { sessionId: s });
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
          if (frame !== null) void call("Page.screencastFrameAck", { sessionId: frame });
          frame = null;
          return;
        case "size": {
          const width = Math.round(clamp(m.width, 1, 8000, 800));
          const height = Math.round(clamp(m.height, 1, 8000, 600));
          const scale = clamp(m.scale, 0.5, 4, 1);
          size = { width, height, scale };
          void (async () => {
            await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false });
            await cast();
          })();
          return;
        }
        case "mouse":
          if (!MOUSE.has(m.event)) return;
          return void (input = call("Input.dispatchMouseEvent", {
            type: m.event,
            x: clamp(m.x, -1e5, 1e5, 0),
            y: clamp(m.y, -1e5, 1e5, 0),
            button: ["none", "left", "middle", "right", "back", "forward"].includes(m.button) ? m.button : "none",
            buttons: clamp(m.buttons, 0, 31, 0),
            clickCount: clamp(m.clickCount, 0, 3, 0),
            modifiers: clamp(m.modifiers, 0, 15, 0),
            deltaX: clamp(m.deltaX, -1e5, 1e5, 0),
            deltaY: clamp(m.deltaY, -1e5, 1e5, 0),
          }));
        case "key":
          if (!KEY.has(m.event)) return;
          return void (input = call("Input.dispatchKeyEvent", {
            type: m.event,
            key: str(m.key),
            code: str(m.code),
            windowsVirtualKeyCode: clamp(m.keyCode, 0, 255, 0),
            nativeVirtualKeyCode: clamp(m.keyCode, 0, 255, 0),
            text: str(m.text),
            unmodifiedText: str(m.text),
            modifiers: clamp(m.modifiers, 0, 15, 0),
          }));
        case "text":
          if (typeof m.text === "string" && m.text) input = call("Input.insertText", { text: m.text });
          return;
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
