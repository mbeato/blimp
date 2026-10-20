// A live view of a server browser tab (components/PageView.tsx): blimpd streams the tab's
// frames (JPEG, binary messages) and takes input, navigation and size as JSON (docs/DESIGN.md,
// Server browser). The server's Chrome runs on Linux, so the Mac's editing keys are mapped to
// Linux's: ⌘A/⌘X/⌘Z/⌘Y → Ctrl, ⌘←/⌘→ → Home/End, ⌥←/⌥→/⌥⌫ → Ctrl. ⌘C and ⌘V go through the Mac
// clipboard instead (copy and paste events), and other ⌘ keys stay the app's.

export type ViewInfo = { url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean };
export type ViewDialog = { kind: "alert" | "confirm" | "prompt" | "beforeunload"; message: string; defaultPrompt: string };
export type KeyMsg = { type: "key"; event: "keyDown" | "rawKeyDown" | "keyUp"; key: string; code: string; keyCode: number; text?: string; modifiers: number };
export type MouseMsg = {
  type: "mouse";
  event: "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel";
  x: number;
  y: number;
  button: "none" | "left" | "middle" | "right";
  buttons: number;
  clickCount: number;
  modifiers: number;
  deltaX?: number;
  deltaY?: number;
};

type Mods = Pick<KeyboardEvent, "altKey" | "ctrlKey" | "metaKey" | "shiftKey">;
// CDP's modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8.
export const modifiers = (e: Mods) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);

const EDIT_KEYS = new Set(["a", "x", "z", "y"]);
const KEY_CODES: Record<string, number> = { Home: 36, End: 35, ArrowLeft: 37, ArrowRight: 39, Backspace: 8 };

// A key as the server's Chrome should get it, or null when it isn't the page's: the app's ⌘
// shortcuts, ⌘C and ⌘V (the clipboard events do those), and keys an input method is composing
// (the text comes when it's done).
export function keyMessage(e: KeyboardEvent, dir: "down" | "up"): KeyMsg | null {
  if (e.isComposing || e.key === "Process" || e.key === "Dead") return null;
  const shift = e.shiftKey ? 8 : 0;
  let { key, code, keyCode } = e;
  let mods = modifiers(e);
  if (e.metaKey && !e.ctrlKey) {
    const k = key.toLowerCase();
    if (EDIT_KEYS.has(k)) mods = 2 | shift;
    else if (key === "ArrowLeft" || key === "ArrowRight") {
      key = code = key === "ArrowLeft" ? "Home" : "End";
      keyCode = KEY_CODES[key];
      mods = shift;
    } else return null;
  } else if (e.altKey && !e.ctrlKey && (key === "ArrowLeft" || key === "ArrowRight" || key === "Backspace")) mods = 2 | shift;
  const event = dir === "up" ? "keyUp" : undefined;
  // Typed text: one character with no Ctrl or ⌘ (⌥ on a Mac types characters too, é say).
  const text = key === "Enter" ? "\r" : key.length === 1 || [...key].length === 1 ? key : undefined;
  if (text && !(mods & 6)) {
    if (event) return { type: "key", event, key, code, keyCode, modifiers: shift };
    return { type: "key", event: "keyDown", key, code, keyCode, text, modifiers: key === "Enter" ? mods : shift };
  }
  return { type: "key", event: event ?? "rawKeyDown", key, code, keyCode, modifiers: mods };
}

const BUTTONS = ["left", "middle", "right"] as const;

export function mouseMessage(e: MouseEvent, event: MouseMsg["event"], rect: DOMRect): MouseMsg {
  const button = event === "mouseMoved" ? (e.buttons & 1 ? "left" : e.buttons & 2 ? "right" : e.buttons & 4 ? "middle" : "none") : (BUTTONS[e.button] ?? "none");
  return {
    type: "mouse",
    event,
    x: e.clientX - rect.left,
    y: e.clientY - rect.top,
    button,
    buttons: e.buttons,
    clickCount: event === "mouseMoved" ? 0 : Math.max(1, e.detail),
    modifiers: modifiers(e),
  };
}

// Wheel deltas in pixels (a line is 16).
export function wheelMessage(e: WheelEvent, rect: DOMRect): MouseMsg {
  const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 800 : 1;
  return { type: "mouse", event: "mouseWheel", x: e.clientX - rect.left, y: e.clientY - rect.top, button: "none", buttons: 0, clickCount: 0, modifiers: modifiers(e), deltaX: e.deltaX * k, deltaY: e.deltaY * k };
}

export type ViewHandlers = {
  frame(image: ImageBitmap): void;
  info(i: ViewInfo): void;
  dialog(d: ViewDialog | null): void;
  copied(text: string): void;
  closed(reason: string): void;
};

// The view socket. Each frame is acked once drawn, so blimpd sends the next.
export class ServerView {
  private ws: WebSocket;
  private done = false;

  constructor(url: string, private h: ViewHandlers) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";
    this.ws.onmessage = (e) => {
      if (typeof e.data !== "string") {
        createImageBitmap(new Blob([e.data], { type: "image/jpeg" })).then(
          (b) => {
            if (!this.done) this.h.frame(b);
            this.send({ type: "ack" });
          },
          () => this.send({ type: "ack" }),
        );
        return;
      }
      let m: any;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.type === "info") this.h.info(m);
      else if (m.type === "dialog") this.h.dialog(m);
      else if (m.type === "dialog-closed") this.h.dialog(null);
      else if (m.type === "copied") this.h.copied(String(m.text ?? ""));
    };
    this.ws.onclose = (e) => {
      if (!this.done) this.h.closed(e.reason || "Lost the connection");
      this.done = true;
    };
  }

  send(m: object) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
    else if (this.ws.readyState === WebSocket.CONNECTING) this.ws.addEventListener("open", () => this.send(m), { once: true });
  }

  close() {
    this.done = true;
    this.ws.close();
  }
}
