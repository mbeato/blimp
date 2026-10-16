// A session's terminal over a WebSocket: each socket runs its own `zmx attach <name>` in a PTY,
// so several devices can watch one session and zmx keeps them in sync.

import type { ServerWebSocket, Subprocess } from "bun";
import { sessionExists, zmxEnv, zmxPath } from "./sessions";

export type AttachData = { kind: "attach"; name: string; cols: number; rows: number; proc?: Subprocess; closed?: boolean };

// Terminal size from the app, kept to sane whole numbers.
export function termSize(cols: unknown, rows: unknown): { cols: number; rows: number } {
  const clamp = (v: unknown, dflt: number) => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n >= 1 ? Math.min(n, 1000) : dflt;
  };
  return { cols: clamp(cols, 80), rows: clamp(rows, 24) };
}

// A client that stops reading (a sleeping laptop, a dead network) would make blimpd hold everything the
// session prints. Past this, drop it: the app reconnects and zmx redraws the screen.
export const MAX_BUFFERED = 8 << 20;

// Output goes out as soon as the PTY gives it to us: no batching or timers, they'd add typing lag.
export function openAttach(ws: ServerWebSocket<AttachData>) {
  const d = ws.data;
  let proc: Subprocess;
  try {
    proc = Bun.spawn([zmxPath(), "attach", d.name], {
      env: { ...zmxEnv(), TERM: "xterm-256color", COLORTERM: "truecolor" },
      terminal: {
        cols: d.cols,
        rows: d.rows,
        data(_term, bytes) {
          if (d.closed) return;
          ws.sendBinary(bytes);
          if (ws.getBufferedAmount() > MAX_BUFFERED) {
            d.closed = true;
            ws.close(1013, "client too slow");
            d.proc?.kill("SIGTERM");
          }
        },
      },
    });
  } catch (e) {
    d.closed = true;
    ws.close(1011, `couldn't start zmx: ${(e as Error).message}`.slice(0, 120));
    return;
  }
  d.proc = proc;
  // The zmx client exits when the session ends or the user detaches (ctrl+\). The app needs to know
  // which: an ended session is gone, a detached one can be attached again.
  proc.exited.then(async () => {
    proc.terminal?.close();
    if (d.closed) return;
    const alive = await sessionExists(d.name).catch(() => false);
    if (d.closed) return;
    d.closed = true;
    ws.close(alive ? 4001 : 4000, alive ? "detached" : "ended");
  });
}

// Binary frames are keystrokes; text frames are JSON control messages.
export function attachMessage(ws: ServerWebSocket<AttachData>, msg: string | Buffer) {
  const term = ws.data.proc?.terminal;
  if (!term || ws.data.closed) return;
  if (typeof msg !== "string") {
    term.write(msg);
    return;
  }
  let m: any;
  try {
    m = JSON.parse(msg);
  } catch {
    return;
  }
  if (m?.type === "resize") {
    const { cols, rows } = termSize(m.cols, m.rows);
    term.resize(cols, rows);
  }
}

// Only this socket's zmx client goes away; the session keeps running.
export function closeAttach(ws: ServerWebSocket<AttachData>) {
  ws.data.closed = true;
  ws.data.proc?.kill("SIGTERM");
}
