// The MCP servers sessions get, in two config files: <socket dir>/mcp.json has blimp's own, `blimpd visuals-mcp`
// (the show tool, visuals/mcp.ts); <socket dir>/browser/mcp.json has that and the browser's, `blimpd browser-mcp`:
// Google's Chrome DevTools MCP connected to the gate. Every session gets the first, and the second instead when the
// browser is ready (a Chrome, npx and the gate up), so a server without them never names an MCP that can't start.
// browser-mcp works out the rest where it runs: the session from ZMX_SESSION (zmx sets it in every session), the
// gate's port from the port file, and the gate's key.
//
// The key: a web page in the server's Chrome runs as you, so the gate's uid check lets it in; it
// can't read the key file. The key goes in the MCP's argument list (the MCP takes no other way),
// which other users could see in ps, but they can't pass the uid check.

import { randomBytes } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { blimpDir } from "../sessions";

export const MCP_PACKAGE = "chrome-devtools-mcp@1.11.0";

export const browserDir = () => join(blimpDir(), "browser");
export const mcpConfigPath = () => join(blimpDir(), "mcp.json");
export const browserMcpConfigPath = () => join(browserDir(), "mcp.json");
export const portFile = () => join(browserDir(), "port");
const keyFile = () => join(browserDir(), "key");

// The gate's key: made once (32 random bytes as hex), readable only by you.
export function gateKey(): string {
  let key = "";
  try {
    key = readFileSync(keyFile(), "utf8").trim();
  } catch {}
  if (!/^[0-9a-f]{64}$/.test(key)) writeFileSync(keyFile(), (key = randomBytes(32).toString("hex")) + "\n", { mode: 0o600 });
  chmodSync(keyFile(), 0o600);
  return key;
}

// This blimpd, as a command: the built binary, or bun and the script while developing.
export const selfCommand = (): string[] => (Bun.main.startsWith("/$bunfs/") ? [process.execPath] : [process.execPath, Bun.main]);

export function mcpConfig(self: string[], browser: boolean): string {
  const server = (sub: string) => ({ command: self[0], args: [...self.slice(1), sub] });
  return JSON.stringify({ mcpServers: { blimp: server("visuals-mcp"), ...(browser && { "blimp-browser": server("browser-mcp") }) } }, null, 2) + "\n";
}

// Written when blimpd starts (blimp's only) and again once the gate is up (blimp's and the browser's).
export const writeMcpConfig = (browser: boolean) =>
  writeFileSync(browser ? browserMcpConfigPath() : mcpConfigPath(), mcpConfig(selfCommand(), browser), { mode: 0o600 });

// What npx runs: the MCP, at the gate, as this session. No usage statistics, and no trace URLs
// sent to Google's CrUX API.
export const mcpArgs = (port: number, session: string, key: string) => [
  "-y",
  MCP_PACKAGE,
  "--wsEndpoint",
  `ws://127.0.0.1:${port}/s/${encodeURIComponent(session)}?key=${key}`,
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
  const p = Bun.spawn(["npx", ...mcpArgs(port, session, gateKey())], { stdio: ["inherit", "inherit", "inherit"] });
  // Claude ends its MCP servers with a signal: pass it on, so npx and the MCP don't stay behind.
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => p.kill(sig));
  return await p.exited;
}
