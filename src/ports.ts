// Ports that programs inside blimp's sessions listen on, so the app can offer them in a browser
// tab (docs/superpowers/specs/2026-10-19-next-ideas.md, 4): the listening sockets and the process
// holding each (from `ss`, which runs as its own process, so blimpd's thread, which also carries
// the terminals, isn't held up), and whether that process descends from a session's zmx daemon
// (its parents, from /proc). Programs outside blimp's sessions (sshd, databases, blimpd) aren't
// listed. Without `ss`, /proc is walked from the sessions down instead. Without /proc, none.

import { readdirSync, readFileSync, readlinkSync } from "node:fs";

// host: what to forward to on the server. IPv4 (loopback or any address) is 127.0.0.1; a socket
// on IPv6 only is ::1.
export type Port = { port: number; host: "127.0.0.1" | "::1"; session: string; pid: number; command: string };

const read = (p: string) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
};

// Listening TCP sockets on loopback or any address, by inode. Sockets on one other address
// (a LAN IP, say) aren't reachable through a forward to loopback, so they're left out.
function listening(): Map<string, { port: number; host: Port["host"] }> {
  const out = new Map<string, { port: number; host: Port["host"] }>();
  const v4 = new Set(["00000000", "0100007F"]);
  const v6 = new Set(["00000000000000000000000000000000", "00000000000000000000000001000000"]);
  for (const [file, ok, host] of [
    ["/proc/net/tcp", v4, "127.0.0.1"],
    ["/proc/net/tcp6", v6, "::1"],
  ] as const) {
    for (const line of read(file).split("\n").slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 10 || f[3] !== "0A") continue; // 0A: LISTEN
      const [addr, hexPort] = f[1].split(":");
      if (!ok.has(addr)) continue;
      out.set(f[9], { port: parseInt(hexPort, 16), host });
    }
  }
  return out;
}

// A process's children, from /proc/<pid>/task/<tid>/children (each thread's). Only the sessions'
// own processes are read, not every process on the server: this runs every 2 s on the thread
// that also carries the terminals. Falls back to every process's parent where the kernel doesn't
// have those files.
let childrenFiles: boolean | undefined;
let parentMap: Map<number, number[]> | null = null;

function children(pid: number): number[] {
  if (childrenFiles === undefined) childrenFiles = read(`/proc/self/task/${process.pid}/children`) !== "" || existsChildren();
  if (childrenFiles) {
    let tasks: string[] = [];
    try {
      tasks = readdirSync(`/proc/${pid}/task`);
    } catch {
      return [];
    }
    return tasks.flatMap((t) => read(`/proc/${pid}/task/${t}/children`).split(" ").filter(Boolean).map(Number));
  }
  parentMap ??= allChildren();
  return parentMap.get(pid) ?? [];
}

function existsChildren(): boolean {
  try {
    readFileSync(`/proc/self/task/${process.pid}/children`);
    return true;
  } catch {
    return false;
  }
}

function allChildren(): Map<number, number[]> {
  const out = new Map<number, number[]>();
  let pids: string[] = [];
  try {
    pids = readdirSync("/proc").filter((d) => /^\d+$/.test(d));
  } catch {
    return out;
  }
  for (const pid of pids) {
    const stat = read(`/proc/${pid}/stat`);
    // "pid (comm) state ppid ...": comm may contain spaces and parentheses.
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    if (ppid) out.set(ppid, [...(out.get(ppid) ?? []), Number(pid)]);
  }
  return out;
}

// `ss -Htlnp`: listening TCP sockets, with each owner's pid (for our own processes). null if
// there's no ss.
export async function fromSs(): Promise<{ port: number; host: Port["host"]; owners: { pid: number; command: string }[] }[] | null> {
  let out: string;
  try {
    const p = Bun.spawn(["ss", "-Htlnp"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    out = await new Response(p.stdout).text();
    if ((await p.exited) !== 0) return null;
  } catch {
    return null;
  }
  return parseSs(out);
}

export function parseSs(out: string) {
  const list: { port: number; host: Port["host"]; owners: { pid: number; command: string }[] }[] = [];
  for (const line of out.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f[0] !== "LISTEN" || f.length < 5) continue;
    const local = f[3];
    const i = local.lastIndexOf(":");
    const addr = local.slice(0, i).replace(/%.*$/, "");
    const port = Number(local.slice(i + 1));
    // Loopback or any address; one other address (a LAN IP) isn't reachable through a forward.
    const host = ["127.0.0.1", "0.0.0.0", "*"].includes(addr) ? "127.0.0.1" : ["[::1]", "[::]"].includes(addr) ? "::1" : null;
    if (!host || !port) continue;
    const owners = [...line.matchAll(/\("((?:[^"\\]|\\.)*)",pid=(\d+),fd=\d+\)/g)].map((m) => ({ command: m[1], pid: Number(m[2]) }));
    if (owners.length) list.push({ port, host, owners });
  }
  return list;
}

// The session whose zmx daemon `pid` descends from, by walking up its parents.
function sessionOf(pid: number, daemons: Map<number, string>): string | null {
  for (let p = pid, hops = 0; p > 1 && hops < 64; hops++) {
    const name = daemons.get(p);
    if (name) return name;
    const stat = read(`/proc/${p}/stat`);
    p = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  }
  return null;
}

// sessions: name and the pid of its zmx session daemon.
export async function sessionPorts(sessions: { name: string; pid: number }[]): Promise<Port[]> {
  const live = sessions.filter((s) => s.pid > 0);
  if (!live.length) return [];
  const ss = await fromSs();
  if (ss) {
    const daemons = new Map(live.map((s) => [s.pid, s.name]));
    const byPort = new Map<number, Port>();
    for (const x of ss) {
      if (byPort.get(x.port)?.host === "127.0.0.1") continue; // on IPv4 and IPv6: IPv4
      for (const o of x.owners) {
        const session = sessionOf(o.pid, daemons);
        if (session) {
          byPort.set(x.port, { port: x.port, host: x.host, session, pid: o.pid, command: o.command });
          break;
        }
      }
    }
    return [...byPort.values()].sort((a, b) => a.port - b.port);
  }
  return walkProc(live);
}

function walkProc(live: { name: string; pid: number }[]): Port[] {
  const sockets = listening();
  if (!sockets.size) return [];
  parentMap = null; // the fallback's map is made fresh for each scan
  const byPort = new Map<number, Port>();
  for (const s of live) {
    const stack = [s.pid];
    while (stack.length) {
      const pid = stack.pop()!;
      stack.push(...children(pid));
      let fds: string[] = [];
      try {
        fds = readdirSync(`/proc/${pid}/fd`);
      } catch {
        continue;
      }
      for (const fd of fds) {
        let link = "";
        try {
          link = readlinkSync(`/proc/${pid}/fd/${fd}`);
        } catch {
          continue;
        }
        const m = link.match(/^socket:\[(\d+)\]$/);
        const sock = m && sockets.get(m[1]);
        if (!sock) continue;
        const had = byPort.get(sock.port);
        // The same port on IPv4 and IPv6: forward to IPv4.
        if (had && had.host === "127.0.0.1") continue;
        byPort.set(sock.port, { ...sock, session: s.name, pid, command: read(`/proc/${pid}/comm`).trim() });
      }
    }
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}
