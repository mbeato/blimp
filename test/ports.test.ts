import { expect, test } from "bun:test";
import { parseSs } from "../src/ports";

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
