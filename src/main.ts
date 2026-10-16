#!/usr/bin/env bun
// blimpd: the server half of blimp.
//   blimpd sessions [--json]   list live sessions (same columns as `claude1 ls`)
//   blimpd serve               serve the API on a unix socket only you can open
//   blimpd --version

import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import pkg from "../package.json";
import { formatList, listSessions, startSession } from "./sessions";

export const socketPath = () => process.env.BLIMPD_SOCKET || join(homedir(), ".blimp", "blimpd.sock");

// The app reaches this through SSH (`ssh -L <port>:<socket>`), so it never listens on the network.
function serve() {
  const sock = socketPath();
  mkdirSync(dirname(sock), { recursive: true });
  chmodSync(dirname(sock), 0o700);
  rmSync(sock, { force: true });
  Bun.serve({
    unix: sock,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      try {
        if (pathname === "/sessions" && req.method === "GET") return Response.json(listSessions());
        if (pathname === "/sessions" && req.method === "POST") {
          const { dir, name } = (await req.json()) as { dir?: string; name?: string };
          if (!dir) return Response.json({ error: "dir is required" }, { status: 400 });
          return Response.json({ name: startSession(dir, name) }, { status: 201 });
        }
        return Response.json({ error: "not found" }, { status: 404 });
      } catch (e) {
        return Response.json({ error: (e as Error).message }, { status: 400 });
      }
    },
  });
  chmodSync(sock, 0o600);
  console.log(`blimpd ${pkg.version} listening on ${sock}`);
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === "sessions") {
  const rows = listSessions();
  if (args.includes("--json")) console.log(JSON.stringify(rows, null, 2));
  else console.log(rows.length ? formatList(rows) : "no running sessions");
} else if (cmd === "serve") {
  serve();
} else if (cmd === "--version" || cmd === "version") {
  console.log(pkg.version);
} else {
  console.log("usage: blimpd sessions [--json] | serve | --version");
  process.exit(cmd ? 1 : 0);
}
