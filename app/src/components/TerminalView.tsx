import { useEffect, useRef, useState } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { backoff, type ServerLink } from "../lib/connection";
import { mapKey } from "../lib/keys";

const ANSI = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const;
const camel = (s: string) => s.replace(/-(\w)/g, (_, c) => c.toUpperCase());

// xterm.js needs real color values, so read them from the CSS variables in theme.css.
function themeFromCss(): ITheme {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(`--term-${name}`).trim();
  const theme: Record<string, string> = {
    background: v("bg"),
    foreground: v("fg"),
    cursor: v("cursor"),
    cursorAccent: v("bg"),
    selectionBackground: v("selection"),
  };
  for (const c of ANSI) {
    theme[c] = v(c);
    theme[camel(`bright-${c}`)] = v(`bright-${c}`);
  }
  return theme;
}

type Phase = "connecting" | "live" | "reconnecting" | "ended";

// One session's terminal: xterm.js on /sessions/<name>/attach. Stays mounted while its tab is
// open (hidden when another tab is active) so the scrollback survives tab switches.
export function TerminalView(props: { link: ServerLink; name: string; active: boolean; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const [phase, setPhase] = useState<Phase>("connecting");
  // The link object is stable, but its connection changes when the tunnel is rebuilt.
  const linkRef = useRef(props.link);
  linkRef.current = props.link;
  const reconnectNow = useRef(() => {});
  const reattach = useRef(() => {});

  useEffect(() => {
    const t = new Terminal({
      fontSize: 13,
      fontFamily: '"SF Mono", Menlo, monospace',
      theme: themeFromCss(),
      scrollback: 10000,
      macOptionClickForcesSelection: true,
    });
    const f = new FitAddon();
    t.loadAddon(f);
    t.loadAddon(new WebLinksAddon());
    t.open(box.current!);
    // WebGL is much faster for Claude's redraws; without it (or when the GPU context is lost)
    // xterm falls back to its DOM renderer.
    try {
      const gl = new WebglAddon();
      gl.onContextLoss(() => gl.dispose());
      t.loadAddon(gl);
    } catch {}
    term.current = t;
    fit.current = f;

    let ws: WebSocket | null = null;
    let disposed = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let everOpened = false;
    const enc = new TextEncoder();

    const send = (data: Uint8Array<ArrayBuffer> | string) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(data);
    };

    t.attachCustomKeyEventHandler((e) => {
      const a = mapKey(e, t.hasSelection());
      if (a.kind === "xterm") return true;
      if (a.kind === "send") {
        e.preventDefault();
        send(enc.encode(a.data));
      } else if (a.kind === "copy") {
        e.preventDefault();
        void navigator.clipboard.writeText(t.getSelection()).catch(() => {});
      }
      return false;
    });
    t.onData((d) => send(enc.encode(d)));
    t.onBinary((d) => send(Uint8Array.from(d, (c) => c.charCodeAt(0) & 0xff)));
    t.onResize(({ cols, rows }) => send(JSON.stringify({ type: "resize", cols, rows })));

    const connect = () => {
      retryTimer = undefined;
      const api = linkRef.current.api;
      if (!api || linkRef.current.status !== "connected") return retry();
      if (box.current?.offsetWidth) f.fit();
      const sock = new WebSocket(api.attachUrl(props.name, t.cols, t.rows));
      sock.binaryType = "arraybuffer";
      ws = sock;
      sock.onopen = () => {
        attempt = 0;
        // zmx redraws the screen for every new client, so start from a clean terminal.
        if (everOpened) t.reset();
        everOpened = true;
        setPhase("live");
      };
      sock.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer) t.write(new Uint8Array(e.data));
      };
      sock.onclose = (e) => {
        if (disposed || ws !== sock) return;
        ws = null;
        const l = linkRef.current;
        const gone = l.status === "connected" && l.sessions && !l.sessions.some((s) => s.name === props.name);
        if (e.code === 4000 || gone) setPhase("ended");
        else retry();
      };
    };
    const retry = () => {
      if (disposed || retryTimer) return;
      setPhase(everOpened ? "reconnecting" : "connecting");
      retryTimer = setTimeout(connect, backoff(attempt++));
    };
    connect();
    // Called when the server link comes back, so the tab doesn't wait out its own backoff.
    reconnectNow.current = () => {
      if (disposed || ws || !retryTimer) return;
      clearTimeout(retryTimer);
      attempt = 0;
      connect();
    };
    reattach.current = () => {
      if (disposed || ws || retryTimer) return;
      attempt = 0;
      connect();
    };

    // Refit whenever the pane changes size (window resize, dragging a divider, ⌘B).
    const ro = new ResizeObserver(() => {
      if (box.current?.offsetWidth) f.fit();
    });
    ro.observe(box.current!);

    const scheme = matchMedia("(prefers-color-scheme: light)");
    const onScheme = () => (t.options.theme = themeFromCss());
    scheme.addEventListener("change", onScheme);

    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      ws?.close();
      ro.disconnect();
      scheme.removeEventListener("change", onScheme);
      t.dispose();
    };
  }, [props.name]);

  useEffect(() => {
    if (props.link.status === "connected") reconnectNow.current();
  }, [props.link.status]);

  useEffect(() => {
    if (!props.active) return;
    if (box.current?.offsetWidth) fit.current?.fit();
    term.current?.focus();
  }, [props.active]);

  // Code 4000 means this zmx client exited: the session ended, or someone detached it (ctrl+\).
  // A session the server still lists was only detached, so it can be attached again. (Right after
  // a real end the list can lag by a second; the banner then switches to "Session ended".)
  const l = props.link;
  const detached = phase === "ended" && l.status === "connected" && !!l.sessions?.some((s) => s.name === props.name);

  return (
    <div className="term" hidden={!props.active}>
      <div className="term-box" ref={box} />
      {phase === "ended" && (
        <div className="term-banner">
          <span>{detached ? "Detached from this session" : "Session ended"}</span>
          {detached && <button onClick={() => reattach.current()}>Reattach</button>}
          <button onClick={props.onClose}>Close tab</button>
        </div>
      )}
      {phase === "reconnecting" && <div className="term-banner quiet">Reconnecting…</div>}
    </div>
  );
}
