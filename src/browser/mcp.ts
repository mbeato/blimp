// How sessions get the browser: Google's Chrome DevTools MCP, connected to the gate. Every Claude
// session blimp starts gets one config file (mcp.json, the same for all); it runs
// `blimpd browser-mcp`, which works out the rest where it runs: the session from ZMX_SESSION (zmx
// sets it in every session) and the gate's port from the port file.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { blimpDir } from "../sessions";

export const MCP_PACKAGE = "chrome-devtools-mcp@1.11.0";

export const browserDir = () => join(blimpDir(), "browser");
export const mcpConfigPath = () => join(browserDir(), "mcp.json");
export const portFile = () => join(browserDir(), "port");

// This blimpd, as a command: the built binary, or bun and the script while developing.
export const selfCommand = (): string[] => (Bun.main.startsWith("/$bunfs/") ? [process.execPath] : [process.execPath, Bun.main]);

export function mcpConfig(self: string[]): string {
  return JSON.stringify({ mcpServers: { "blimp-browser": { command: self[0], args: [...self.slice(1), "browser-mcp"] } } }, null, 2) + "\n";
}

// What npx runs: the MCP, at the gate, as this session. No usage statistics, and no trace URLs
// sent to Google's CrUX API.
export const mcpArgs = (port: number, session: string) => [
  "-y",
  MCP_PACKAGE,
  "--wsEndpoint",
  `ws://127.0.0.1:${port}/s/${encodeURIComponent(session)}`,
  "--no-usage-statistics",
  "--no-performance-crux",
];

// `blimpd browser-mcp`: speaks MCP on stdin and stdout, as the session's MCP server.
export async function runBrowserMcp(): Promise<number> {
  const session = process.env.ZMX_SESSION;
  if (!session) {
    console.error("blimpd browser-mcp: this runs inside a blimp session (ZMX_SESSION isn't set)");
    return 1;
  }
  let port = 0;
  try {
    port = Number(readFileSync(portFile(), "utf8").trim());
  } catch {}
  if (!port) {
    console.error("blimpd browser-mcp: blimpd isn't serving the browser (no port file)");
    return 1;
  }
  const p = Bun.spawn(["npx", ...mcpArgs(port, session)], { stdio: ["inherit", "inherit", "inherit"] });
  return await p.exited;
}
