import { useEffect, useRef, useState } from "react";
import type { BrowserTab } from "../lib/api";
import { serverTabTarget, typedUrl } from "../lib/browser";
import type { ServerLink } from "../lib/connection";
import { openWebLink } from "../lib/links";
import { closePort, openPort } from "../lib/ports";
import { keyMessage, mouseMessage, ServerView, wheelMessage, type ViewDialog, type ViewInfo } from "../lib/serverview";

// A session Send to session can paste into.
export type Target = { name: string; title: string };

// A browser tab: a tab of the server's Chrome, shown live (lib/serverview.ts). The bar has Back,
// Forward, Reload, the address, Open in Browser and Send to session. While the tab is on screen
// (`shown`, and the window can be seen: not minimized or behind other apps) the view socket is open: frames come in and are drawn to a canvas at the page's size;
// clicks, scrolling and typing go out. Typing goes through a hidden text field, so
// input methods, accents and emoji work. Copy, Cut and Paste use the Mac clipboard.
export function PageView(props: {
  tab: BrowserTab;
  link: ServerLink;
  shown: boolean;
  targets: () => Target[];
  onSend: (to: string, text: string) => Promise<void>;
  onNotice: (text: string) => void;
}) {
  const { tab, link } = props;
  const [info, setInfo] = useState<ViewInfo | null>(null);
  const [dialog, setDialog] = useState<ViewDialog | null>(null);
  const [answer, setAnswer] = useState("");
  const [state, setState] = useState<"connecting" | "open" | "lost">("connecting");
  const [seen, setSeen] = useState(!document.hidden);
  useEffect(() => {
    const f = () => setSeen(!document.hidden);
    document.addEventListener("visibilitychange", f);
    return () => document.removeEventListener("visibilitychange", f);
  }, []);
  const [drawn, setDrawn] = useState(false);
  const [retry, setRetry] = useState(0);
  const failures = useRef(0); // in a row, for the wait before the next try
  const url = info?.url || tab.url;
  const [draft, setDraft] = useState(url);
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState<Target[] | null>(null);
  const area = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const keys = useRef<HTMLTextAreaElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const view = useRef<ServerView | null>(null);
  const forwarded = useRef(new Set<number>());

  useEffect(() => {
    if (!editing) setDraft(url);
  }, [url, editing]);
  // A new tab (at the start page) starts in the address field, once it's on screen (the server
  // may list it before it's brought forward).
  const focused = useRef(false);
  useEffect(() => {
    if (!props.shown || focused.current) return;
    focused.current = true;
    if (/^https:\/\/www\.google\.com\/?$/.test(tab.url)) input.current?.focus();
  }, [props.shown]);
  useEffect(
    () => () => {
      for (const port of forwarded.current) closePort(link, { port, host: "127.0.0.1" });
    },
    [],
  );

  // The page is laid out at the area's width and down to the window's bottom, at this screen's
  // pixel ratio: the terminal below covers the page's bottom rather than resizing it.
  const lastSize = useRef("");
  const sendSize = () => {
    const r = area.current?.getBoundingClientRect();
    const bottom = area.current?.closest(".wb-right")?.getBoundingClientRect().bottom ?? r?.bottom ?? 0;
    if (!r || !r.width || bottom <= r.top || !view.current) return;
    const m = { type: "size", width: Math.round(r.width), height: Math.round(bottom - r.top), scale: window.devicePixelRatio || 1 };
    const k = JSON.stringify(m);
    if (k === lastSize.current) return;
    lastSize.current = k;
    view.current.send(m);
  };

  // The view socket, while the tab is on screen.
  useEffect(() => {
    const api = link.api;
    if (!props.shown || !seen || !api) return;
    setState("connecting");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const v = new ServerView(api.viewUrl(tab.id), {
      frame(b, size) {
        const c = canvas.current;
        if (!c) return b.close();
        if (c.width !== b.width || c.height !== b.height) {
          c.width = b.width;
          c.height = b.height;
        }
        // At the page's size: the canvas's CSS pixels are then the page's, for the mouse.
        const dpr = window.devicePixelRatio || 1;
        c.style.width = `${size?.width ?? b.width / dpr}px`;
        c.style.height = `${size?.height ?? b.height / dpr}px`;
        c.getContext("2d")?.drawImage(b, 0, 0);
        b.close();
        setState("open");
        setDrawn(true);
      },
      info: (i) => {
        failures.current = 0;
        setInfo(i);
        setState("open");
        askSelection();
      },
      dialog: (d) => (setDialog(d), setAnswer(d?.defaultPrompt ?? "")),
      // The page's selection, kept selected in the typing field: the Mac's Copy and Cut (the Edit
      // menu, and ⌘C and ⌘X, which the menu takes) then copy it there and then. A copy that waited
      // for the server's answer would be too late for the Mac to let it write the clipboard.
      copied: (text) => {
        const k = keys.current;
        if (!k || k.value === text) return;
        k.value = text;
        k.setSelectionRange(0, text.length);
      },
      // Tried again after 1 s, then longer each time in a row it fails, up to 10 s. A tab that's
      // gone leaves the strip (the server stops listing it), and this view with it.
      closed: (reason) => {
        setState("lost");
        if (reason === "Tab closed") return;
        const wait = Math.min(10_000, 1000 * 2 ** failures.current++);
        timer = setTimeout(() => setRetry((n) => n + 1), wait);
      },
    });
    view.current = v;
    lastSize.current = "";
    sendSize();
    return () => {
      clearTimeout(timer);
      v.close();
      if (view.current === v) view.current = null;
    };
  }, [props.shown, seen, tab.id, link.api, retry]);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    let frame = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(sendSize);
    });
    ro.observe(el);
    const right = el.closest(".wb-right");
    if (right) ro.observe(right);
    return () => (ro.disconnect(), cancelAnimationFrame(frame));
  }, []);

  const send = (m: object) => view.current?.send(m);
  const go = (text: string) => {
    const to = typedUrl(text);
    if (!to) return;
    setEditing(false);
    input.current?.blur();
    send({ type: "go", url: to });
    keys.current?.focus();
  };

  // After anything that may change what's selected, the server says what is (see copied above).
  // Until it does, there's nothing to copy, rather than what was selected before.
  const askSelection = () => {
    if (keys.current) keys.current.value = "";
    send({ type: "copy" });
  };

  const openOutside = () => {
    const to = serverTabTarget(url);
    if (!("port" in to)) return openWebLink(url);
    const u = new URL(url);
    openPort(link, { port: to.port, host: "127.0.0.1" }).then(
      (base) => {
        forwarded.current.add(to.port);
        openWebLink(base + u.pathname + u.search + u.hash);
      },
      (e) => props.onNotice(`Couldn't open it: ${e instanceof Error ? e.message : String(e)}`),
    );
  };

  const icon = (d: string) => (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <path d={d} fill="none" stroke="currentColor" />
    </svg>
  );
  const canvasRect = () => canvas.current!.getBoundingClientRect();
  return (
    <div className="page-view">
      <form
        className="page-bar"
        onSubmit={(e) => {
          e.preventDefault();
          go(draft);
        }}
      >
        <button type="button" className="icon-button small" title="Back" aria-label="Back" disabled={!info?.canGoBack} onClick={() => send({ type: "nav", action: "back" })}>
          {icon("M10 3.5L5.5 8l4.5 4.5")}
        </button>
        <button type="button" className="icon-button small" title="Forward" aria-label="Forward" disabled={!info?.canGoForward} onClick={() => send({ type: "nav", action: "forward" })}>
          {icon("M6 3.5L10.5 8 6 12.5")}
        </button>
        <button type="button" className="icon-button small" title="Reload" aria-label="Reload" onClick={() => send({ type: "nav", action: "reload" })}>
          {icon("M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3")}
        </button>
        <input
          ref={input}
          aria-label="Address"
          placeholder="Search Google or type an address"
          value={draft}
          onChange={(e) => (setEditing(true), setDraft(e.target.value))}
          onFocus={(e) => e.target.select()}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => e.key === "Escape" && (setEditing(false), setDraft(url), input.current?.blur())}
          spellCheck={false}
          autoCapitalize="off"
        />
        {info?.loading && <span className="page-loading" aria-label="Loading" />}
        <button type="button" className="link-button" disabled={!url} onClick={openOutside}>
          Open in Browser
        </button>
        <div className="menu-anchor">
          <button
            type="button"
            className="link-button"
            aria-expanded={!!menu}
            title="Paste this tab's title and address into a session, which can look at it with its browser tools"
            onClick={() => setMenu(menu ? null : props.targets())}
          >
            Send to session
          </button>
          {menu && (
            <>
              <div className="menu-scrim" onClick={() => setMenu(null)} />
              <div className="menu send-menu" role="menu" onKeyDown={(e) => e.key === "Escape" && setMenu(null)}>
                {menu.length === 0 && <div className="menu-note-row">No session running in this folder</div>}
                {menu.map((t) => (
                  <button
                    key={t.name}
                    role="menuitem"
                    onClick={() => {
                      setMenu(null);
                      // The page sets its title: no control characters into a terminal.
                      const plain = (x: string) => x.replace(/[\x00-\x1f\x7f]/g, " ");
                      void props.onSend(t.name, `Browser tab "${plain(info?.title || tab.title || url)}" ${plain(url)} `);
                    }}
                  >
                    <span className="menu-label">{t.title}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </form>
      {dialog && (
        <form
          className="fbar page-dialog"
          role="alertdialog"
          aria-label="The page asks"
          onSubmit={(e) => {
            e.preventDefault();
            send({ type: "dialog", accept: true, ...(dialog.kind === "prompt" && { text: answer }) });
          }}
        >
          <span>{dialog.message || (dialog.kind === "beforeunload" ? "Leave this page?" : "The page asks")}</span>
          {dialog.kind === "prompt" && <input aria-label="Answer" value={answer} autoFocus onChange={(e) => setAnswer(e.target.value)} />}
          <button type="submit" autoFocus={dialog.kind !== "prompt"}>
            OK
          </button>
          {dialog.kind !== "alert" && (
            <button type="button" onClick={() => send({ type: "dialog", accept: false })}>
              Cancel
            </button>
          )}
        </form>
      )}
      <div ref={area} className={"page-frame page-live" + (state === "lost" ? " lost" : "")}>
        <canvas
          ref={canvas}
          aria-label={info?.title || tab.title || "Web page"}
          // While a button is down, moves and the release go to the page wherever the pointer is,
          // so a drag that ends outside doesn't leave the page's button held.
          onMouseDown={(e) => {
            e.preventDefault();
            keys.current?.focus();
            send(mouseMessage(e.nativeEvent, "mousePressed", canvasRect()));
            const move = (ev: MouseEvent) => send(mouseMessage(ev, "mouseMoved", canvasRect()));
            const up = (ev: MouseEvent) => {
              send(mouseMessage(ev, "mouseReleased", canvasRect()));
              askSelection();
              window.removeEventListener("mousemove", move);
              window.removeEventListener("mouseup", up);
            };
            window.addEventListener("mousemove", move);
            window.addEventListener("mouseup", up);
          }}
          onMouseMove={(e) => e.buttons === 0 && send(mouseMessage(e.nativeEvent, "mouseMoved", canvasRect()))}
          onWheel={(e) => send(wheelMessage(e.nativeEvent, canvasRect()))}
          onContextMenu={(e) => e.preventDefault()}
        />
        <textarea
          ref={keys}
          className="page-keys"
          aria-label="Type into the page"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onFocus={(e) => e.currentTarget.setSelectionRange(0, e.currentTarget.value.length)}
          onKeyDown={(e) => {
            const m = keyMessage(e.nativeEvent, "down");
            if (!m) return;
            e.preventDefault();
            send(m);
          }}
          onKeyUp={(e) => {
            const m = keyMessage(e.nativeEvent, "up");
            if (m) (send(m), askSelection());
          }}
          // The Mac's Cut: the selection onto the clipboard here (the field is cleared below, before
          // the Cut itself would copy it), then the page cuts it as Linux does, with Ctrl+X.
          onCut={(e) => {
            const k = e.currentTarget;
            e.preventDefault();
            if (k.selectionStart === k.selectionEnd) return;
            e.clipboardData.setData("text/plain", k.value.slice(k.selectionStart, k.selectionEnd));
            for (const event of ["rawKeyDown", "keyUp"]) send({ type: "key", event, key: "x", code: "KeyX", keyCode: 88, modifiers: 2 });
            askSelection();
          }}
          onCompositionEnd={(e) => {
            if (e.data) (send({ type: "text", text: e.data }), askSelection());
            e.currentTarget.value = "";
          }}
          onInput={(e) => {
            const t = e.currentTarget;
            const n = e.nativeEvent as InputEvent;
            if (n.isComposing || !t.value) return;
            // What was typed, not the selection the field holds around it.
            send({ type: "text", text: n.data ?? t.value });
            t.value = "";
            askSelection();
          }}
          onPaste={(e) => {
            e.preventDefault();
            const text = e.clipboardData.getData("text/plain");
            if (text) (send({ type: "text", text }), askSelection());
          }}
        />
        {state !== "open" && (drawn || state === "lost") && (
          <div className="page-status" role="status">
            {drawn ? "Reconnecting…" : "Can't reach the server's browser. Trying again…"}
          </div>
        )}
        {state !== "open" && !drawn && state !== "lost" && (
          <div className="page-status" role="status">
            Loading…
          </div>
        )}
      </div>
    </div>
  );
}
