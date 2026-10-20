// A stand-in for Claude Code's folder trust question, for tests (test/server.test.ts, the iPhone e2e). It draws
// the question as Claude Code 2.1.300 does in a folder not trusted yet (the probe in docs/DESIGN.md, Chat) and
// takes keys the way it does: ↓ / ↑ move the cursor (it starts on No), Enter takes it, Esc cancels.
// Like Claude, it writes no status file until Yes; then it writes one, as Claude does when it starts.
// No (or Esc) ends it, and with it the session.
//   bun fake-trust.ts <config.json>
//   config: { folder, keys: file every key read is appended to, claudeDir: where Claude's sessions/<pid>.json
//             goes, sessionId }
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const cfg = JSON.parse(readFileSync(process.argv[2], "utf8"));
let cursor: "no" | "yes" = "no";
let trusted = false;

function draw() {
  const out = trusted
    ? ["Claude Code", "", "> "]
    : [
        "─".repeat(120),
        " Accessing workspace:",
        "",
        ` ${cfg.folder}`,
        "",
        " Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source",
        " project, or work from your team). If not, take a moment to review what's in this folder first.",
        "",
        " Claude Code'll be able to read, edit, and execute files here.",
        "",
        " Security guide",
        "",
        ` ${cursor === "no" ? "❯" : " "} No, exit`,
        ` ${cursor === "yes" ? "❯" : " "} Yes, I trust this folder`,
        "",
        " Enter to confirm · Esc to cancel",
      ];
  process.stdout.write("\x1b[2J\x1b[H" + out.join("\n") + "\n");
}

function key(k: string) {
  if (trusted) return;
  if (k === "\x1b[B") cursor = "yes";
  else if (k === "\x1b[A") cursor = "no";
  else if (k === "\x1b") process.exit(0);
  else if (k === "\r" || k === "\n") {
    if (cursor === "no") process.exit(0);
    trusted = true;
    mkdirSync(join(cfg.claudeDir, "sessions"), { recursive: true });
    writeFileSync(join(cfg.claudeDir, "sessions", `${process.pid}.json`), JSON.stringify({ sessionId: cfg.sessionId, cwd: cfg.folder, status: "idle" }));
  }
}

// One read can hold several keys: a paste, escape sequences, single bytes.
function keys(s: string): string[] {
  const out: string[] = [];
  while (s) {
    const m = s.match(/^\x1b\[200~[\s\S]*?\x1b\[201~|^\x1b\[[0-9;]*[A-Za-z~]|^[\s\S]/u)!;
    out.push(m[0]);
    s = s.slice(m[0].length);
  }
  return out;
}

Bun.spawnSync(["stty", "-icanon", "-echo", "-icrnl"], { stdin: "inherit" });
draw();
for await (const chunk of Bun.stdin.stream()) {
  const s = new TextDecoder().decode(chunk);
  appendFileSync(cfg.keys, s);
  for (const k of keys(s)) key(k);
  draw();
}
