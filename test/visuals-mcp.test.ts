// blimp's MCP server (src/visuals/mcp.ts, `blimpd visuals-mcp`): the show tool every session blimp starts gets.

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handle, SHOW_DESCRIPTION } from "../src/visuals/mcp";

const tmp = mkdtempSync(join(tmpdir(), "blimp-mcp-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const shown = async () => "0123456789ab";

test("initialize: the client's protocol version back, the tools capability, blimp's name", async () => {
  const r: any = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code" } } }, shown);
  expect(r).toEqual({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "blimp", version: expect.any(String) } } });
});

test("a notification gets no answer; ping gets an empty one", async () => {
  expect(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }, shown)).toBeUndefined();
  expect(await handle({ jsonrpc: "2.0", id: "p", method: "ping" }, shown)).toEqual({ jsonrpc: "2.0", id: "p", result: {} });
});

test("tools/list: show, with what it does and how to make a page", async () => {
  const r: any = await handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }, shown);
  expect(r.result.tools.map((t: any) => t.name)).toEqual(["show"]);
  const [tool] = r.result.tools;
  expect(tool.description).toBe(SHOW_DESCRIPTION);
  expect(tool.inputSchema).toEqual({
    type: "object",
    properties: {
      path: { type: "string", description: expect.any(String) },
      title: { type: "string", description: expect.any(String), maxLength: 80 },
    },
    required: ["path", "title"],
    additionalProperties: false,
  });
  for (const s of ["kit/blimp.css", "kit/chart.js", "kit/mermaid.js", "kit/blimp.js", "not /tmp", "390 px", "14 px", "2 MB", "maintainAspectRatio: false", '<pre class="mermaid">'])
    expect(SHOW_DESCRIPTION).toContain(s);
});

test("tools/call show: the line the chat reads the id from, or Not shown with the reason", async () => {
  const calls: string[][] = [];
  const r: any = await handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "show", arguments: { path: "chart.html", title: "Runs" } } }, async (p, t) => {
    calls.push([p, t]);
    return "0123456789ab";
  });
  expect(calls).toEqual([["chart.html", "Runs"]]);
  expect(r).toEqual({ jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "Shown on the phone and the Mac. visual: 0123456789ab" }] } });
  const no: any = await handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "show", arguments: { path: "x.html", title: "X" } } }, async () => {
    throw new Error("no such file: x.html");
  });
  expect(no).toEqual({ jsonrpc: "2.0", id: 4, result: { content: [{ type: "text", text: "Not shown: no such file: x.html" }], isError: true } });
});

test("another tool or method is an error", async () => {
  const tool: any = await handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "draw", arguments: {} } }, shown);
  expect(tool.error.code).toBe(-32602);
  const method: any = await handle({ jsonrpc: "2.0", id: 6, method: "resources/list" }, shown);
  expect(method.error).toEqual({ code: -32601, message: "no method resources/list" });
});

// `blimpd visuals-mcp` itself: lines in, lines out, and the call goes to blimpd's socket with the Mac's token.
async function run(dir: string, lines: object[], want: number) {
  const p = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "main.ts"), "visuals-mcp"], {
    env: { ...process.env, BLIMPD_SOCKET: join(dir, "blimpd.sock"), ZMX_SESSION: "blimp-7" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  for (const l of lines) p.stdin.write(JSON.stringify(l) + "\n");
  await p.stdin.flush();
  const out: any[] = [];
  let text = "";
  const reader = p.stdout.getReader();
  while (out.length < want) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
    const parts = text.split("\n");
    text = parts.pop()!;
    for (const part of parts) if (part.trim()) out.push(JSON.parse(part));
  }
  reader.releaseLock();
  p.stdin.end();
  return { out, code: await p.exited };
}

const call = (id: number) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "show", arguments: { path: "chart.html", title: "T" } } });
const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } };

test("blimpd visuals-mcp: a show call reaches blimpd as POST /visuals for its session, with the Mac's token", async () => {
  const dir = mkdtempSync(join(tmp, "up-"));
  writeFileSync(join(dir, "token"), "t0ken\n");
  const got: any[] = [];
  const fake = Bun.serve({
    unix: join(dir, "blimpd.sock"),
    async fetch(req) {
      got.push({ method: req.method, path: new URL(req.url).pathname, auth: req.headers.get("authorization"), body: await req.json() });
      return Response.json({ id: "0123456789ab" }, { status: 201 });
    },
  });
  try {
    const { out, code } = await run(dir, [init, { jsonrpc: "2.0", method: "notifications/initialized" }, call(2)], 2);
    expect(out[0].id).toBe(1);
    expect(out[1]).toEqual({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "Shown on the phone and the Mac. visual: 0123456789ab" }] } });
    expect(got).toEqual([{ method: "POST", path: "/visuals", auth: "Bearer t0ken", body: { session: "blimp-7", path: "chart.html", title: "T" } }]);
    expect(code).toBe(0);
  } finally {
    fake.stop(true);
  }
});

test("blimpd visuals-mcp: blimpd's refusal, or no blimpd at all, is the tool's error", async () => {
  const dir = mkdtempSync(join(tmp, "no-"));
  writeFileSync(join(dir, "token"), "t0ken\n");
  const fake = Bun.serve({ unix: join(dir, "blimpd.sock"), fetch: () => Response.json({ error: "no such file: chart.html" }, { status: 404 }) });
  try {
    const { out } = await run(dir, [call(1)], 1);
    expect(out[0].result).toEqual({ content: [{ type: "text", text: "Not shown: no such file: chart.html" }], isError: true });
  } finally {
    fake.stop(true);
  }
  const { out } = await run(dir, [call(1)], 1);
  expect(out[0].result).toEqual({ content: [{ type: "text", text: "Not shown: blimpd isn't running" }], isError: true });
});

test("blimpd visuals-mcp: a blimpd that never answers is given up on after 15 s", async () => {
  const dir = mkdtempSync(join(tmp, "slow-"));
  writeFileSync(join(dir, "token"), "t0ken\n");
  const fake = Bun.serve({ unix: join(dir, "blimpd.sock"), fetch: () => new Promise<Response>(() => {}) });
  try {
    const { out } = await run(dir, [call(1)], 1);
    expect(out[0].result).toEqual({ content: [{ type: "text", text: "Not shown: blimpd didn't answer in 15 s" }], isError: true });
  } finally {
    fake.stop(true);
  }
}, 30_000);
