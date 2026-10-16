#!/usr/bin/env bun
// blimpd: the server half of blimp.
//   blimpd sessions [--json]   list live sessions (same columns as `claude1 ls`)
//   blimpd serve               serve the API on a unix socket only you can open
//   blimpd install-hooks       add blimp's status hooks to Claude Code's settings.json
//   blimpd uninstall-hooks     take them out again
//   blimpd hook                what those hooks run (reads Claude's hook JSON on stdin)
//   blimpd --version

import pkg from "../package.json";
import { installHooks, runHook, uninstallHooks } from "./hooks";
import { serve } from "./server";
import { formatList, listSessions } from "./sessions";

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
} else if (cmd === "uninstall-hooks") {
  const removed = uninstallHooks(process.execPath);
  console.log(removed.length ? `hooks: removed ${removed.join(", ")}` : "hooks: none installed");
} else if (cmd === "hook") {
  await runHook();
} else if (cmd === "--version" || cmd === "version") {
  console.log(pkg.version);
} else {
  console.log("usage: blimpd sessions [--json] | serve | install-hooks | uninstall-hooks | hook | --version");
  process.exit(cmd ? 1 : 0);
}
