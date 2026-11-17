import { expect, test } from "bun:test";
import { parseLsofListen, parsePs, parseSs, sessionPorts } from "../src/ports";

test("ss output: listening sockets on loopback or any address, with their owners", () => {
  const out = [
    "LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:((\"node\",pid=101,fd=20),(\"node\",pid=102,fd=20))",
    "LISTEN 0 128 0.0.0.0:22 0.0.0.0:*",
    "LISTEN 0 511 [::1]:5173 [::]:* users:((\"vite worker\",pid=103,fd=9))",
    "LISTEN 0 511 *:8080 *:* users:((\"bun\",pid=104,fd=3))",
    "LISTEN 0 4096 127.0.0.53%lo:53 0.0.0.0:* users:((\"resolved\",pid=105,fd=1))",
    "LISTEN 0 511 192.168.1.5:9000 0.0.0.0:* users:((\"lan\",pid=106,fd=4))",
  ].join("\n");
  expect(parseSs(out)).toEqual([
    { port: 3000, host: "127.0.0.1", owners: [{ command: "node", pid: 101 }, { command: "node", pid: 102 }] },
    { port: 5173, host: "::1", owners: [{ command: "vite worker", pid: 103 }] },
    { port: 8080, host: "127.0.0.1", owners: [{ command: "bun", pid: 104 }] },
  ]);
});

// `lsof -nP -iTCP -sTCP:LISTEN -F pctn` as macOS prints it. One field a line: p starts a process,
// f one of its sockets.
test("lsof output: listening sockets on loopback or any address, with their owners", () => {
  const out = [
    ...["p18065", "cbun", "f4", "tIPv4", "n127.0.0.1:47311"],
    ...["p18066", "cbun", "f4", "tIPv6", "n[::1]:47312"],
    // Any address: the type line says which family.
    ...["p18067", "cbun", "f4", "tIPv6", "n*:47313"],
    ...["p18068", "cvite worker (x) abcdefghijklmno", "f4", "tIPv4", "n*:47314"],
    // One process, a socket on each family.
    ...["p1525", "cControlCenter", "f9", "tIPv4", "n*:7000", "f10", "tIPv6", "n*:7000"],
    // A socket shared by forked processes is under each of them.
    ...["p24034", "cPython", "f3", "tIPv4", "n127.0.0.1:47318"],
    ...["p24036", "cPython", "f3", "tIPv4", "n127.0.0.1:47318"],
    // One other address (a LAN IP): left out.
    ...["p300", "clan", "f4", "tIPv4", "n192.168.1.5:9000"],
    ...["p301", "clan", "f5", "tIPv6", "n[fe80::1]:9001"],
    "",
  ].join("\n");
  expect(parseLsofListen(out)).toEqual([
    { port: 47311, host: "127.0.0.1", owners: [{ pid: 18065, command: "bun" }] },
    { port: 47312, host: "::1", owners: [{ pid: 18066, command: "bun" }] },
    { port: 47313, host: "::1", owners: [{ pid: 18067, command: "bun" }] },
    { port: 47314, host: "127.0.0.1", owners: [{ pid: 18068, command: "vite worker (x) abcdefghijklmno" }] },
    { port: 7000, host: "127.0.0.1", owners: [{ pid: 1525, command: "ControlCenter" }] },
    { port: 7000, host: "::1", owners: [{ pid: 1525, command: "ControlCenter" }] },
    { port: 47318, host: "127.0.0.1", owners: [{ pid: 24034, command: "Python" }, { pid: 24036, command: "Python" }] },
  ]);
  // Nothing listening: lsof prints nothing (and exits 1).
  expect(parseLsofListen("")).toEqual([]);
});

// `ps -axo pid=,ppid=` as macOS prints it.
test("ps output: each process's parent", () => {
  expect(parsePs("    1     0\n  320     1\n18064 18062\n18065 18064\n")).toEqual(new Map([[1, 0], [320, 1], [18064, 18062], [18065, 18064]]));
});

// On Linux and on macOS, with what each has (ss and /proc, or lsof and ps).
test("a port a session's child listens on is found", async () => {
  const script = 'const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") }); console.log(s.port);';
  const child = Bun.spawn([process.execPath, "-e", script], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  try {
    const { value } = await child.stdout.getReader().read();
    const port = Number(new TextDecoder().decode(value));
    expect(port).toBeGreaterThan(0);
    // This test's own process stands in for the session's.
    expect(await sessionPorts([{ name: "mine", pid: process.pid }])).toContainEqual({ port, host: "127.0.0.1", session: "mine", pid: child.pid, command: "bun" });
  } finally {
    child.kill();
  }
});
