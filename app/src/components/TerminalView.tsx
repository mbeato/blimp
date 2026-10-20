import { useEffect, useRef, useState } from "react";
import { Terminal, type ILink, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { backoff, type ServerLink } from "../lib/connection";
import { joinRows, type Row } from "../lib/copy";
import { mapKey } from "../lib/keys";
import { followsLink, openWebLink } from "../lib/links";
import { ExistsCache, findPaths, resolveAgainst } from "../lib/pathlinks";
import { isClaude } from "../lib/sessions";
import { getSettings, onSettings, type Settings } from "../lib/settings";

// The settings a terminal follows (Settings > Terminal), as xterm options.
const termOptions = (s: Settings) => ({
  fontSize: s.terminalFontSize,
  cursorStyle: s.cursorStyle,
  cursorBlink: s.cursorBlink,
  scrollback: s.scrollback,
  macOptionIsMeta: s.optionIsMeta,
});

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

type Phase = "connecting" | "live" | "reconnecting" | "ended" | "detached";

// One session's terminal: xterm.js on /sessions/<name>/attach. Stays mounted once shown (hidden
// while it isn't in a split) so the scrollback survives switching.
// dir: the session's folder, which relative paths in its output are read against.
// visible: in a split. focused: the split with the keyboard, in the tab in front.
// onOpenPath: ⌘-click on a file path. onClose: dismiss an ended or detached session.
export function TerminalView(props: {
  link: ServerLink;
  name: string;
  dir: string;
  visible: boolean;
  focused: boolean;
  onOpenPath: (path: string, line?: number, col?: number) => void;
  onClose: () => void;
  // Where this terminal puts its paste function (text typed in as a paste), by session.
  pastes: Map<string, (text: string) => void>;
}) {
  const box = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const [phase, setPhase] = useState<Phase>("connecting");
  // The link object is stable, but its connection changes when the tunnel is rebuilt.
  const linkRef = useRef(props.link);
  linkRef.current = props.link;
  const reconnectNow = useRef(() => {});
  const reattach = useRef(() => {});
  const dirRef = useRef(props.dir);
  dirRef.current = props.dir;
  const openPath = useRef(props.onOpenPath);
  openPath.current = props.onOpenPath;
  // Claude Code or not, from the server's list (a session's kind can show up after it starts).
  const claudeRef = useRef(false);
  const session = props.link.sessions?.find((s) => s.name === props.name);
  claudeRef.current = !!session && isClaude(session);

  useEffect(() => {
    const t = new Terminal({
      ...termOptions(getSettings()),
      fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
      theme: themeFromCss(),
      macOptionClickForcesSelection: true,
      // For the Unicode 11 width tables below (a proposed API in xterm).
      allowProposedApi: true,
      // OSC 8 links (any text can carry a hidden URL) follow the same rule as WebLinksAddon's:
      // ⌘-click only, http and https only, through the opener. xterm's default asks with
      // confirm() on a plain click and then opens the URL in a new webview window.
      linkHandler: {
        activate: (e, uri) => {
          if (followsLink(e)) openWebLink(uri);
        },
      },
    });
    const f = new FitAddon();
    t.loadAddon(f);
    // Claude sizes symbols like ⏺ ✻ and emoji by Unicode 11 widths, as VS Code's terminal does. With
    // xterm's default (Unicode 6) the two disagree on column counts and Claude's redraws land offset.
    t.loadAddon(new Unicode11Addon());
    t.unicode.activeVersion = "11";
    t.loadAddon(
      new WebLinksAddon((e, uri) => {
        if (followsLink(e)) openWebLink(uri);
      }),
    );
    // File paths: ⌘-click opens them in a file tab. A link shows only for a file that exists.
    const exists = new ExistsCache(() => linkRef.current.api);
    t.registerLinkProvider({
      provideLinks(y, done) {
        const line = t.buffer.active.getLine(y - 1);
        if (!line) return done(undefined);
        // The line's text, with each character's cell: wide characters take two cells.
        let text = "";
        const cellAt: number[] = [];
        for (let x = 0; x < line.length; x++) {
          const cell = line.getCell(x);
          if (!cell || cell.getWidth() === 0) continue;
          const ch = cell.getChars() || " ";
          for (let i = 0; i < ch.length; i++) cellAt.push(x);
          text += ch;
        }
        const matches = findPaths(text);
        if (!matches.length) return done(undefined);
        const home = linkRef.current.home;
        void Promise.all(
          matches.map(async (m): Promise<ILink | null> => {
            const path = resolveAgainst(m.text, dirRef.current, home);
            if (!(await exists.isFile(path))) return null;
            return {
              range: { start: { x: cellAt[m.start] + 1, y }, end: { x: cellAt[m.end - 1] + 1, y } },
              text: m.text,
              activate: (e) => followsLink(e) && openPath.current(path, m.line, m.col),
            };
          }),
        ).then((links) => {
          const found = links.filter((l): l is ILink => !!l);
          done(found.length ? found : undefined);
        });
      },
    });
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
    props.pastes.set(props.name, (text) => {
      t.paste(text);
      t.focus();
    });

    let ws: WebSocket | null = null;
    let disposed = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let everOpened = false;
    const enc = new TextEncoder();

    // Typed before the first connection opens (just after the session is shown): kept and sent
    // once it does, so the first keys aren't lost. Not after a drop: keys typed while it's
    // reconnecting could land much later, so those go nowhere, as before.
    let early: Uint8Array<ArrayBuffer>[] = [];
    const send = (data: Uint8Array<ArrayBuffer> | string) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(data);
      else if (!everOpened && typeof data !== "string" && early.length < 1000) early.push(data);
    };

    t.attachCustomKeyEventHandler((e) => {
      const a = mapKey(e, t.hasSelection(), claudeRef.current);
      if (a.kind === "xterm") return true;
      if (a.kind === "send") {
        e.preventDefault();
        send(enc.encode(a.data));
      } else if (a.kind === "copy") {
        e.preventDefault();
        void navigator.clipboard.writeText(copied(t)).catch(() => {});
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
      // zmx sends the current screen first, so start from a clean terminal: before connecting,
      // never after data has arrived (that would wipe the screen zmx just drew).
      t.reset();
      const sock = new WebSocket(api.attachUrl(props.name, t.cols, t.rows));
      sock.binaryType = "arraybuffer";
      ws = sock;
      sock.onopen = () => {
        attempt = 0;
        everOpened = true;
        for (const d of early) sock.send(d);
        early = [];
        setPhase("live");
      };
      sock.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer) t.write(new Uint8Array(e.data));
      };
      sock.onclose = (e) => {
        if (disposed || ws !== sock) return;
        ws = null;
        // 4000: the session ended. 4001: someone detached this client (ctrl+\). Anything else is
        // a dropped connection, unless the server no longer lists the session.
        const l = linkRef.current;
        const gone = l.status === "connected" && l.sessions && !l.sessions.some((s) => s.name === props.name);
        if (e.code === 4001) setPhase("detached");
        else if (e.code === 4000 || gone) setPhase("ended");
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

    // A settings change (or the system going light/dark): new options and colors, then refit,
    // since a new font size changes how many rows and columns fit.
    const offSettings = onSettings(() => {
      Object.assign(t.options, termOptions(getSettings()), { theme: themeFromCss() });
      if (box.current?.offsetWidth) f.fit();
    });

    return () => {
      props.pastes.delete(props.name);
      disposed = true;
      clearTimeout(retryTimer);
      ws?.close();
      ro.disconnect();
      offSettings();
      t.dispose();
    };
  }, [props.name]);

  useEffect(() => {
    if (props.link.status === "connected") reconnectNow.current();
  }, [props.link.status]);

  useEffect(() => {
    if (props.visible && box.current?.offsetWidth) fit.current?.fit();
  }, [props.visible]);

  useEffect(() => {
    if (props.focused) term.current?.focus();
  }, [props.focused]);

  return (
    <div className="term" hidden={!props.visible}>
      <div className="term-box" ref={box} />
      {(phase === "ended" || phase === "detached") && (
        <div className="term-banner">
          <span>{phase === "detached" ? "Detached" : "Session ended"}</span>
          {phase === "detached" && <button onClick={() => reattach.current()}>Reattach</button>}
          <button onClick={props.onClose}>Close</button>
        </div>
      )}
      {phase === "reconnecting" && <div className="term-banner quiet">Reconnecting…</div>}
    </div>
  );
}

// The selection as text, wrapped lines joined back (lib/copy.ts). getSelectionPosition's x is 0-based and
// its end column exclusive, whatever its doc comment says; y is the buffer row.
function copied(t: Terminal): string {
  const p = t.getSelectionPosition();
  if (!p || p.start.y === p.end.y) return t.getSelection();
  const buf = t.buffer.active;
  const rows: Row[] = [];
  for (let y = p.start.y; y <= p.end.y; y++) {
    const line = buf.getLine(y);
    if (!line) return t.getSelection();
    let width = 0;
    for (let x = t.cols - 1; x >= 0; x--) {
      const cell = line.getCell(x);
      if (cell && cell.getChars() && cell.getChars() !== " ") {
        width = x + Math.max(1, cell.getWidth());
        break;
      }
    }
    const [from, to] = [y === p.start.y ? p.start.x : 0, y === p.end.y ? p.end.x : t.cols];
    rows.push({ full: line.translateToString(true), width, wrapped: y > p.start.y && line.isWrapped, text: line.translateToString(true, from, to) });
  }
  return joinRows(rows, t.cols);
}
