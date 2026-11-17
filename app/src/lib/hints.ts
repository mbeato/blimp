// What to do about a server that won't connect: one line under the error, for the errors the
// Rust shell returns (open and wait_healthy in src-tauri/src/tunnel.rs, with ssh's last stderr
// line after the colon). Pure, so it's tested against those exact words.

import type { Server } from "./connection";

// ssh reached the server but blimpd's token isn't there (not_set_up in tunnel.rs, pinned by a
// Rust test). The one error Install blimpd is offered for.
export const isNotSetUp = (error: string) => error.startsWith("blimpd isn't set up on ");

// The command that connects from Terminal; ssh doesn't take "host:port".
const sshCommand = (s: Server) => ["ssh", ...(s.port ? ["-p", String(s.port)] : []), s.user ? `${s.user}@${s.host}` : s.host].join(" ");

// "" when there's nothing useful to add.
export function connectHint(error: string, s: Server): string {
  if (isNotSetUp(error)) return "blimpd isn't installed on this server yet. Install blimpd puts it there.";
  // BatchMode can't ask whether to trust a new host key, so ssh refuses it.
  if (/Host key verification failed/i.test(error)) return `Connect once from Terminal first: ${sshCommand(s)}`;
  if (/Permission denied/i.test(error)) return "The server doesn't accept this Mac's SSH key. Add the key to ~/.ssh/authorized_keys on the server.";
  if (/Could not resolve hostname|timed out|Connection refused/i.test(error)) return "Check the host name, and that the server is on and reachable from this Mac.";
  return "";
}
