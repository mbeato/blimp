// A stand-in for Claude Code's AskUserQuestion dialog, for tests (test/server.test.ts, the iPhone e2e). It draws
// the dialog as Claude Code 2.1.300 does (the probe in .superpowers/ask-probe.md, summed up in docs/DESIGN.md)
// and takes keys the way it does, so blimpd's screen checks and key steps meet what real Claude needs.
//   bun fake-ask.ts <config.json>
//   config: { questions, keys: file every key read is appended to, answers?: file the answers go to as JSON,
//             status?: blimp's status file for the session, set to done once answered, sessionId? }
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

type Q = { question: string; header?: string; multiSelect?: boolean; options: { label: string; description?: string }[] };
const cfg = JSON.parse(readFileSync(process.argv[2], "utf8"));
const qs: Q[] = cfg.questions;
const review = qs.length > 1 || !!qs[0].multiSelect;

let tab = 0; // which question; qs.length is the review screen
let cursor = 1; // row, 1-based; for multi-choice, options + 2 is Next/Submit
const picked: (number | undefined)[] = qs.map(() => undefined);
const ticks: Set<number>[] = qs.map(() => new Set());
const texts: string[] = qs.map(() => "");
const done: boolean[] = qs.map(() => false);
let over = "";

const textRow = (q: number) => qs[q].options.length + 1;

function draw() {
  const out: string[] = [];
  const bar = qs.map((q, i) => `${done[i] ? "☒" : "☐"} ${q.header ?? `Q${i + 1}`}`).join("  ");
  out.push(review ? `←  ${bar}  ✔ Submit  →` : ` ${bar}`, "");
  if (over) out.push(over);
  else if (tab === qs.length) {
    out.push("Review your answers", "");
    for (const [i, q] of qs.entries()) out.push(` ● ${q.question}`, `   → ${answer(i)}`);
    out.push("", "Ready to submit your answers?", "", `${cursor === 1 ? "❯" : " "} 1. Submit answers`, `${cursor === 2 ? "❯" : " "} 2. Cancel`);
  } else {
    const q = qs[tab];
    const n = q.options.length;
    const mark = (r: number) => (cursor === r ? "❯" : " ");
    out.push(q.question, "");
    for (const [i, o] of q.options.entries()) {
      const r = i + 1;
      if (q.multiSelect) out.push(`${mark(r)} ${r}. [${ticks[tab].has(r) ? "✔" : " "}] ${o.label}`, `         ${o.description ?? ""}`);
      else out.push(`${mark(r)} ${r}. ${o.label}`, `     ${o.description ?? ""}`);
    }
    const t = texts[tab] || (q.multiSelect ? "Type something" : "Type something.");
    out.push(q.multiSelect ? `${mark(n + 1)} ${n + 1}. [${ticks[tab].has(n + 1) ? "✔" : " "}] ${t}` : `${mark(n + 1)} ${n + 1}. ${t}`);
    if (q.multiSelect) out.push(`${mark(n + 2)}    ${tab === qs.length - 1 ? "Submit" : "Next"}`);
    out.push("─".repeat(60), `  ${n + 2}. Chat about this`, "", "Enter to select · Tab/Arrow keys to navigate · Esc to cancel");
  }
  process.stdout.write("\x1b[2J\x1b[H" + out.join("\n") + "\n");
}

function answer(i: number): string {
  const q = qs[i];
  if (!q.multiSelect) return picked[i] !== undefined ? q.options[picked[i]!].label : texts[i];
  return [...ticks[i]].sort((a, b) => a - b).map((r) => (r === textRow(i) ? texts[i] : q.options[r - 1].label)).join(", ");
}

function next() {
  done[tab] = true;
  tab++;
  cursor = 1;
  if (tab === qs.length && !review) submit();
}

function submit() {
  const answers = Object.fromEntries(qs.map((q, i) => [q.question, answer(i)]));
  if (cfg.answers) writeFileSync(cfg.answers, JSON.stringify(answers));
  finish("User answered Claude's questions:\n" + qs.map((q, i) => `  · ${q.question} → ${answer(i)}`).join("\n"));
}

function finish(text: string) {
  over = text;
  if (cfg.status) writeFileSync(cfg.status, JSON.stringify({ state: "done", at: Date.now(), sessionId: cfg.sessionId, event: "Stop" }));
}

function key(k: string) {
  if (over) return;
  if (k === "\x1b") return finish("User declined to answer questions");
  if (tab === qs.length) {
    if (k === "1" || ((k === "\r" || k === "\n") && cursor === 1)) submit();
    else if (k === "2" || k === "\r" || k === "\n") finish("User declined to answer questions");
    else if (k === "\x1b[B") cursor = 2;
    else if (k === "\x1b[A") cursor = 1;
    return;
  }
  const q = qs[tab];
  const n = q.options.length;
  const onText = cursor === n + 1;
  if (k.startsWith("\x1b[200~")) {
    if (onText) {
      texts[tab] += k.slice(6, -6);
      if (q.multiSelect) ticks[tab].add(n + 1);
    }
    return;
  }
  if (onText && /^[^\x00-\x1f\x7f]$/.test(k)) {
    texts[tab] += k; // typed into the text field, digits too
    return;
  }
  if (/^[1-9]$/.test(k)) {
    const r = Number(k);
    if (!q.multiSelect && r <= n) {
      picked[tab] = r - 1;
      next();
    } else if (!q.multiSelect && r === n + 1) cursor = r;
    else if (q.multiSelect && r <= n + 1) ticks[tab].has(r) ? ticks[tab].delete(r) : ticks[tab].add(r);
    return;
  }
  const last = q.multiSelect ? n + 2 : n + 1;
  if (k === "\x1b[B" || (k === "\t" && onText)) cursor = Math.min(cursor + 1, last);
  else if (k === "\x1b[A") cursor = Math.max(cursor - 1, 1);
  else if (k === "\t" || k === "\x1b[C") next();
  else if (k === "\r" || k === "\n") {
    if (q.multiSelect && cursor === n + 2) next();
    else if (q.multiSelect) ticks[tab].has(cursor) ? ticks[tab].delete(cursor) : ticks[tab].add(cursor);
    else if (onText && texts[tab]) next();
    else if (!onText) {
      picked[tab] = cursor - 1;
      next();
    }
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
let pending = "";
for await (const chunk of Bun.stdin.stream()) {
  const s = new TextDecoder().decode(chunk);
  appendFileSync(cfg.keys, s);
  pending += s;
  // A paste can arrive in pieces: wait for its end.
  if (pending.lastIndexOf("\x1b[200~") > pending.lastIndexOf("\x1b[201~")) continue;
  for (const k of keys(pending)) key(k);
  pending = "";
  draw();
}
