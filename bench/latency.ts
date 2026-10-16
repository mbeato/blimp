// Keystroke-to-echo latency: plain `ssh -tt host zmx attach` vs blimp's path
// (ssh -L tunnel -> WebSocket -> blimpd -> zmx attach). Both type into the same zmx session
// running `cat`, one byte at a time, and time how long each byte takes to come back.
//
//   bun bench/latency.ts ssh   <user@host> <session>
//   bun bench/latency.ts blimp <user@host> <session> <remote socket> <token>
//
// Run it from a link with real delay (see bench/README.md) or the numbers mean nothing.

const [mode, target, session, remoteSock, token] = process.argv.slice(2);
const SPACED_MS = 150; // one key at a time: shows the base round trip
const BURST_MS = 25; // fast typing: shows any extra wait for the previous packet's ACK
const N = 60;

type Link = { send(b: string): void; onData(cb: (s: string) => void): void; close(): void };

async function sshLink(): Promise<Link> {
  let cb: (s: string) => void = () => {};
  const p = Bun.spawn(["ssh", "-tt", "-o", "BatchMode=yes", target, `~/.local/bin/zmx attach ${session}`], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  (async () => {
    for await (const chunk of p.stdout) cb(new TextDecoder().decode(chunk));
  })();
  return {
    send: (b) => {
      p.stdin.write(b);
      p.stdin.flush();
    },
    onData: (f) => (cb = f),
    close: () => p.kill(),
  };
}

async function blimpLink(): Promise<Link> {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const tunnel = Bun.spawn(
    // The same shape as the app's tunnel (app/src-tauri/src/tunnel.rs): a remote `cat` on a stdin pipe we hold.
    ["ssh", "-T", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-L", `127.0.0.1:${port}:${remoteSock}`, "--", target, "cat >/dev/null"],
    { stdin: "pipe", stdout: "ignore", stderr: "inherit" },
  );
  let ws: WebSocket | undefined;
  for (let i = 0; i < 50 && !ws; i++) {
    await Bun.sleep(200);
    try {
      const w = new WebSocket(`ws://127.0.0.1:${port}/sessions/${session}/attach?token=${token}&cols=80&rows=24`);
      w.binaryType = "arraybuffer";
      await new Promise((ok, bad) => ((w.onopen = ok), (w.onerror = bad)));
      ws = w;
    } catch {}
  }
  if (!ws) throw new Error("couldn't open the WebSocket through the tunnel");
  let cb: (s: string) => void = () => {};
  ws.onmessage = (e) => cb(typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data));
  return {
    send: (b) => ws!.send(new TextEncoder().encode(b)),
    onData: (f) => (cb = f),
    close: () => {
      ws!.close();
      tunnel.kill();
    },
  };
}

async function measure(link: Link, gapMs: number): Promise<number[]> {
  const pending = new Map<string, number>();
  const times: number[] = [];
  link.onData((s) => {
    for (const ch of s) {
      const t0 = pending.get(ch);
      if (t0 !== undefined) {
        times.push(performance.now() - t0);
        pending.delete(ch);
      }
    }
  });
  // Distinct letters so each echo matches its keystroke even when they overlap.
  const letters = "abcdefghijklmnopqrstuvwxyz";
  for (let i = 0; i < N; i++) {
    const ch = letters[i % 26];
    pending.set(ch, performance.now());
    link.send(ch);
    await Bun.sleep(gapMs);
    if (i % 26 === 25) {
      await Bun.sleep(300);
      pending.clear();
      link.send("\x15"); // clear the line between rounds
      await Bun.sleep(100);
    }
  }
  await Bun.sleep(500);
  return times;
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]?.toFixed(1);
};

const link = mode === "blimp" ? await blimpLink() : await sshLink();
link.onData(() => {});
await Bun.sleep(1500); // let the initial screen redraw finish
for (const [label, gap] of [["spaced", SPACED_MS], ["burst", BURST_MS]] as const) {
  const t = await measure(link, gap);
  console.log(`${mode} ${label.padEnd(6)} n=${t.length} p50=${pct(t, 50)}ms p95=${pct(t, 95)}ms max=${pct(t, 100)}ms`);
}
link.close();
process.exit(0);
