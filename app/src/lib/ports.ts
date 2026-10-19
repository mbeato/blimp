// A server's port in a browser tab. The Mac app forwards a local port to it over SSH
// (forward_port in src-tauri/src/tunnel.rs); a browser (development, the e2e tests) runs on the
// server's own machine, so it uses the port as it is.

import { invoke } from "@tauri-apps/api/core";
import type { Port } from "./api";
import { inTauri, type ServerLink } from "./connection";

// The page's address on this computer, without a path.
export async function openPort(link: ServerLink, p: Pick<Port, "port" | "host">): Promise<string> {
  if (!inTauri()) return `http://127.0.0.1:${p.port}`;
  const local = await invoke<number>("forward_port", { server: link.key, host: p.host, port: p.port });
  return `http://127.0.0.1:${local}`;
}

export function closePort(link: ServerLink, p: Pick<Port, "port" | "host">) {
  if (inTauri()) invoke("unforward_port", { server: link.key, host: p.host, port: p.port }).catch(() => {});
}
