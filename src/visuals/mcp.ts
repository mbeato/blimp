// `blimpd visuals-mcp`: blimp's own MCP server, which every session blimp starts gets as "blimp" (browser/mcp.ts's
// mcp.json). One tool, show: Claude hands it a page it wrote, and blimpd keeps a copy and shows it on the phone and
// the Mac (POST /visuals, visuals/store.ts). MCP over stdio is JSON-RPC 2.0, one message per line; this answers the
// few methods a client calls, with no MCP library. It finds its session from ZMX_SESSION, as browser-mcp does, and
// reaches blimpd on its socket with the Mac's token, as `blimpd send` does.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "../../package.json";
import { blimpDir, socketPath } from "../sessions";

export const SHOW_DESCRIPTION = `Show the user a visual on their phone and Mac: a chart, a diagram, a table, a timeline or a small report, as one HTML page you wrote. Use it when a picture explains better than text, or when the user asks to see something.

Write the page under the home folder, not /tmp (blimp can't read there): in the project if it should be kept, else in ~/.cache/blimp-visuals/. Then call show with its path and a short title. After you change the file, call show again: each call shows a new copy.

The page has no internet and can make no requests. Load only blimp's kit, by these relative paths, in <head>:
  <link rel="stylesheet" href="kit/blimp.css">   blimp's colours for light and dark, the system font, and .grid, .card, .stats with .stat (<b>42</b><span>label</span>), .chart, .scroll, tables (td.num), .tag, .good/.warn/.bad
  <script src="kit/chart.js"></script>          Chart.js 4.5, only if there's a chart
  <script src="kit/mermaid.js"></script>        Mermaid 12.1, only if there's a diagram (it's large); write each diagram in <pre class="mermaid">
  <script src="kit/blimp.js"></script>          after those: sets them to blimp's look, draws the diagrams, follows light and dark
Put everything else in the file: your own <style> and <script> after the kit, inline SVG, data: images.

Design for a phone first (about 390 px wide) and make it work in a wide Mac tab too: one column that becomes a grid where there's room (.grid). Start with <meta name="viewport" content="width=device-width, initial-scale=1">. Text at least 14 px. Nothing that works only on hover: a tap on a chart shows its values. Give each chart a box: <div class="chart"><canvas></canvas></div>, with the Chart.js option maintainAspectRatio: false. Use the kit's colours (var(--c1) to var(--c6) for series, --fg, --fg-dim, --line); datasets without colours get them. At most 2 MB.`;

const TOOLS = [
  {
    name: "show",
    description: SHOW_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The page: an absolute path, or one relative to the session's folder. Under the home folder." },
        title: { type: "string", description: "A short title for the card and the tab, like 'Test runs this week'.", maxLength: 80 },
      },
      required: ["path", "title"],
      additionalProperties: false,
    },
  },
];

type Show = (path: string, title: string) => Promise<string>;

// The answer to one message, or undefined for a notification (no id), which gets none.
export async function handle(msg: unknown, show: Show): Promise<object | undefined> {
  const { id, method, params } = (msg ?? {}) as { id?: string | number | null; method?: string; params?: any };
  if (id === undefined || id === null) return;
  const result = (r: object) => ({ jsonrpc: "2.0", id, result: r });
  const failure = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
  switch (method) {
    case "initialize":
      // The client's own version back: this server uses nothing that differs between them.
      return result({
        protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "blimp", version: pkg.version },
      });
    case "ping":
      return result({});
    case "tools/list":
      return result({ tools: TOOLS });
    case "tools/call": {
      if (params?.name !== "show") return failure(-32602, `no tool called ${params?.name}`);
      const { path, title } = params.arguments ?? {};
      try {
        const shown = await show(typeof path === "string" ? path : "", typeof title === "string" ? title : "");
        return result({ content: [{ type: "text", text: `Shown on the phone and the Mac. visual: ${shown}` }] });
      } catch (e) {
        return result({ content: [{ type: "text", text: `Not shown: ${(e as Error).message}` }], isError: true });
      }
    }
    default:
      return failure(-32601, `no method ${method}`);
  }
}

// POST /visuals on blimpd's socket, with the Mac's token: the new copy's id, or blimpd's reason as the error.
async function postShow(session: string, path: string, title: string): Promise<string> {
  let token: string;
  try {
    token = readFileSync(join(blimpDir(), "token"), "utf8").trim();
  } catch {
    throw new Error("blimpd isn't set up here (no token)");
  }
  let r: Response;
  try {
    r = await fetch("http://blimpd/visuals", {
      method: "POST",
      unix: socketPath(),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ session, path, title }),
    } as any);
  } catch {
    throw new Error("blimpd isn't running");
  }
  const body = (await r.json().catch(() => ({}))) as { id?: string; error?: string };
  if (!r.ok || !body.id) throw new Error(body.error ?? `blimpd answered ${r.status}`);
  return body.id;
}

export async function runVisualsMcp(): Promise<number> {
  const session = process.env.ZMX_SESSION;
  const show: Show = (path, title) =>
    session ? postShow(session, path, title) : Promise.reject(new Error("this runs inside a blimp session (ZMX_SESSION isn't set)"));
  // One line at a time, in order: an answer longer than a pipe's buffer must not be cut into by another.
  let out = Promise.resolve(0);
  const write = (m: object) => (out = out.then(() => Bun.write(Bun.stdout, JSON.stringify(m) + "\n")));
  const pending = new Set<Promise<unknown>>();
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of Bun.stdin.stream()) {
    buf += decoder.decode(chunk, { stream: true });
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "not JSON" } });
        continue;
      }
      // A slow show doesn't hold up a ping behind it.
      const p = handle(msg, show).then((r) => r && write(r));
      pending.add(p);
      p.finally(() => pending.delete(p));
    }
  }
  await Promise.all(pending);
  await out;
  return 0;
}
