#!/usr/bin/env bun
// blimpd: the server half of blimp.
//   blimpd sessions [--json]   list live sessions (same columns as `claude1 ls`)
//   blimpd serve               serve the API on a unix socket only you can open
//   blimpd install-hooks       add blimp's status hooks to Claude Code's settings.json (and Codex's hooks.json)
//   blimpd uninstall-hooks     take them out again
//   blimpd hook [codex]        what those hooks run (reads Claude's or Codex's hook JSON on stdin)
//   blimpd pair [--url <url>]  make the phone's token and show the link for the iPhone app as a QR code
//   blimpd pair --revoke       delete the phone's token (the Mac keeps working)
//   blimpd browser             which Chrome the server browser runs, if any
//   blimpd browser-mcp         the browser MCP a session runs (browser/mcp.ts)
//   blimpd --version

import pkg from "../package.json";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { findChrome } from "./browser/chrome";
import { runBrowserMcp } from "./browser/mcp";
import { CODEX_HOOKS, codexHooksFile, installHooks, runHook, uninstallHooks } from "./hooks";
import { runPair } from "./pair";
import { serve } from "./server";
import { formatList, listSessions } from "./sessions";

// Codex's part of install-hooks and uninstall-hooks. A hooks.json that isn't strict JSON (comments,
// say) is left as it is, and Claude Code's hooks still count as done.
function codexHooks(f: () => void) {
  try {
    f();
  } catch (e) {
    console.log(`codex hooks: skipped (${(e as Error).message})`);
  }
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === "sessions") {
  const rows = listSessions();
  if (args.includes("--json")) console.log(JSON.stringify(rows, null, 2));
  else console.log(rows.length ? formatList(rows) : "no running sessions");
} else if (cmd === "serve") {
  try {
    serve();
  } catch (e) {
    console.error(`blimpd: ${(e as Error).message}`);
    process.exit(1);
  }
} else if (cmd === "install-hooks") {
  // The hooks run this exact binary, so it has to be the installed one, not `bun src/main.ts`.
  if (!Bun.main.startsWith("/$bunfs/")) {
    console.error("blimpd: install-hooks has to run from the built blimpd binary");
    process.exit(1);
  }
  const added = installHooks(process.execPath);
  console.log(added.length ? `hooks: added ${added.join(", ")}` : "hooks: already installed");
  // Codex only where it has been used (it makes ~/.codex). It runs new hooks only once you trust them.
  if (existsSync(dirname(codexHooksFile())))
    codexHooks(() => {
      const codex = installHooks(process.execPath, codexHooksFile(), CODEX_HOOKS);
      console.log(codex.length ? `codex hooks: added ${codex.join(", ")} (trust them once in Codex: /hooks)` : "codex hooks: already installed");
    });
} else if (cmd === "uninstall-hooks") {
  const removed = uninstallHooks(process.execPath);
  console.log(removed.length ? `hooks: removed ${removed.join(", ")}` : "hooks: none installed");
  codexHooks(() => {
    const codex = uninstallHooks(process.execPath, codexHooksFile(), CODEX_HOOKS);
    if (codex.length) console.log(`codex hooks: removed ${codex.join(", ")}`);
  });
} else if (cmd === "hook") {
  await runHook(args[0] === "codex");
} else if (cmd === "pair") {
  process.exit(runPair(args));
} else if (cmd === "browser") {
  console.log(findChrome() ?? "no Chrome or Chromium found; install one: npx playwright install chromium");
} else if (cmd === "browser-mcp") {
  process.exit(await runBrowserMcp());
} else if (cmd === "--version" || cmd === "version") {
  console.log(pkg.version);
} else {
  console.log("usage: blimpd sessions [--json] | serve | install-hooks | uninstall-hooks | hook [codex] | pair [--url <url> | --revoke] | browser | browser-mcp | --version");
  process.exit(cmd ? 1 : 0);
}
