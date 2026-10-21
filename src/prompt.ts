// What a waiting Claude is asking, so the phone can show it as buttons. The hook knows the
// question; for permission prompts only the screen shows the options (they vary by command), so
// blimpd reads them from `zmx history` once per wait. Answers are key presses, decided here only.

import { redact } from "./activity";
import { toolSummary } from "./chat";

// preview: a single-choice question whose options have a `preview`. Claude Code draws those in a box beside
// the rows, with no "Type something" row, and a digit there only moves the cursor.
export type Question = { question: string; header?: string; multiSelect: boolean; preview?: true; options: { label: string; description?: string }[] };
// A permission also says what it would do, so it can be judged away from the terminal: input (the command,
// file, address or search, readableInput), plan (ExitPlanMode's plan), risky (riskyCommand). Older blimpd: absent.
export type Prompt =
  | { kind: "permission"; tool: string; summary: string; options: string[]; keys: string[]; answerable: true; input?: string; plan?: string; risky?: boolean }
  | { kind: "question"; questions: Question[]; answerable: boolean }
  | { kind: "trust"; folder: string; options: string[]; answerable: true }
  | { kind: "other"; answerable: false };

const str = (v: unknown) => (typeof v === "string" ? v : "");
// Secrets out first, then cut, so half a secret never shows. By code point: never half an emoji.
const shown = (s: string, max: number) => Array.from(redact(s)).slice(0, max).join("");

// What a permission would run or touch, as the phone shows it under the question. Only these tools: another
// tool's input (an MCP tool's JSON) can hold a secret in a shape the redaction doesn't know.
export function readableInput(tool: string, input: any): string {
  const v = tool === "Bash" ? input?.command
    : ["Edit", "MultiEdit", "Write", "Read"].includes(tool) ? input?.file_path
    : tool === "NotebookEdit" ? input?.notebook_path
    : tool === "WebFetch" ? input?.url
    : tool === "WebSearch" ? input?.query
    : "";
  return shown(str(v), 2000);
}

// A command that pushes, deploys, deletes, forces or hard-resets: the phone shows it in red, so a Yes
// there is a careful one. Words, not a parse: a false alarm costs a second look.
const RISKY = [/\bpush\b(?!\s*\()/i, /\bdeploy\b/i, /--force\b/i, /\breset\s+--hard\b/i, /\bdrop(?:db)?\b/i, /\bdelete\b/i, /\bbranch\s+-D\b/];
// rm with both a recursive and a force flag, in any order or spelling (-rf, -fr, -r -f, -Rf).
const rmRf = (c: string) =>
  [...c.matchAll(/\brm\b([^;&|\n]*)/g)].some(([, args]) => {
    const flags = [...args.matchAll(/(?:^|\s)-([A-Za-z]+)\b/g)].map((m) => m[1]).join("");
    return /[rR]/.test(flags) && flags.includes("f");
  });
export const riskyCommand = (command: string) => RISKY.some((re) => re.test(command)) || rmRf(command);

export function promptFromHook(ev: any): Prompt | undefined {
  const e = ev?.hook_event_name;
  // In default mode Claude also sends PermissionRequest for the question tool: that is the question.
  if (e === "PermissionRequest" && ev.tool_name !== "AskUserQuestion") {
    const tool = str(ev.tool_name);
    const input = readableInput(tool, ev.tool_input);
    const plan = tool === "ExitPlanMode" ? shown(str(ev.tool_input?.plan), 8000) : "";
    // Without the screen: Yes is the first option, and Esc says no.
    return {
      kind: "permission", tool, summary: toolSummary(tool, ev.tool_input, str(ev.cwd)), options: ["Yes", "No"], keys: ["1", "\x1b"], answerable: true,
      ...(input && { input }), ...(plan && { plan }), ...(tool === "Bash" && riskyCommand(str(ev.tool_input?.command)) && { risky: true }),
    };
  }
  if ((e === "PreToolUse" || e === "PermissionRequest") && ev.tool_name === "AskUserQuestion") {
    const questions: Question[] = (Array.isArray(ev.tool_input?.questions) ? ev.tool_input.questions : []).map((q: any) => ({
      question: str(q?.question),
      ...(typeof q?.header === "string" && { header: q.header }),
      multiSelect: q?.multiSelect === true,
      ...(q?.multiSelect !== true && Array.isArray(q?.options) && q.options.some((o: any) => str(o?.preview).trim()) && { preview: true as const }),
      options: (Array.isArray(q?.options) ? q.options : []).map((o: any) => ({ label: str(o?.label), ...(typeof o?.description === "string" && { description: o.description }) })),
    }));
    return { kind: "question", questions, answerable: drivable(questions) };
  }
  if (e === "Elicitation") return { kind: "other", answerable: false };
}

// The numbered lines after "Do you want to proceed?" (a permission) or "Would you like to proceed?" (plan
// approval): "❯ 1. Yes", "  2. …".
export function parseScreenOptions(screen: string): string[] {
  const lines = screen.split("\n");
  const start = lines.findLastIndex((l) => l.includes("Do you want to proceed?") || l.includes("Would you like to proceed?"));
  if (start < 0) return [];
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    const m = l.match(/^\s*(?:❯\s*)?(\d)\.\s+(.*\S)\s*$/);
    if (m && Number(m[1]) === out.length + 1) out.push(m[2]);
    else if (out.length && l.trim()) break;
  }
  return out;
}

export function withScreenOptions(p: Prompt, screen: string): Prompt {
  if (p.kind !== "permission") return p;
  const options = parseScreenOptions(screen);
  if (!options.length) return p;
  // Plan approval's last row opens a text field the phone can't type into while Claude waits. Esc
  // there keeps Claude planning, and what to change can be sent after as a message.
  const field = (o: string) => /^Tell Claude what to change/.test(o);
  return { ...p, options: options.map((o) => (field(o) ? "No, keep planning" : o)), keys: options.map((o, i) => (field(o) ? "\x1b" : String(i + 1))) };
}

// The keys come from the status file, which anything running as you can write: only a digit or Esc
// is ever typed.
// `pick` alone answers a permission or one single-choice question (the phone's voice answers use it).
export function answerKeys(p: Prompt, pick: number): string | undefined {
  if (!Number.isInteger(pick) || pick < 0 || !p.answerable) return;
  const single = p.kind === "question" && p.questions.length === 1 && !p.questions[0].multiSelect && !p.questions[0].preview;
  const keys = p.kind === "permission" ? p.keys[pick] : single && pick < p.questions[0].options.length ? String(pick + 1) : undefined;
  return typeof keys === "string" && /^[1-9]$|^\x1b$/.test(keys) ? keys : undefined;
}

// The text of the choice at pick, as the phone shows it. An answer names it: the hook's fallback Yes/No
// and the screen's options share the wait's `at`, and the same digit means another choice in each.
export function choiceLabel(p: Prompt, pick: number): string | undefined {
  if (!Number.isInteger(pick) || pick < 0) return;
  return p.kind === "permission" || p.kind === "trust" ? p.options[pick] : p.kind === "question" ? p.questions[0]?.options[pick]?.label : undefined;
}

// Answering every question of an AskUserQuestion dialog at once (docs/DESIGN.md, Chat). Claude Code 2.1.300
// draws one question at a time under a tab bar; the keys below are what the probe found it needs
// (.superpowers/ask-probe.md, summed up in DESIGN.md). Each step says what the screen must show before its
// keys are typed, so a dialog that isn't where blimpd expects it stops the answer instead of taking keys
// meant for another place.

export type QuestionAnswer = { picks: number[]; text?: string } | { picks?: undefined; text: string };

// What has to be on the screen before a step: question `q` (0-based) as the current one, with the cursor
// on that row (1-based, or the multi-choice "Next"/"Submit" row), exactly these rows ticked, the typed
// answer in its row. Or the review screen.
// No cursor: anywhere in the question (a digit there goes to its row wherever the cursor is).
export type Expect = { q: number; cursor?: number | "next"; ticked?: number[]; typed?: boolean } | { review: true };
export type Step = { expect: Expect; keys: string };

const DOWN = "\x1b[B";
const MAX_TEXT = 2000;

// The digit for every option and for "Type something" must be one key; the screen tells the steps apart
// by the question's text, so no two may be the same.
function drivable(qs: Question[]): boolean {
  const texts = qs.map((q) => squash(q.question));
  return qs.length >= 1 && qs.length <= 9 && qs.every((q) => q.options.length >= 1 && q.options.length <= 8) &&
    texts.every((t) => t) && new Set(texts).size === texts.length;
}

// A typed answer, as `input` cleans text, then on one line: the dialog's text row takes Enter as "done".
export function cleanText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}
const oneLine = (text: string) => cleanText(text).replace(/\s+/g, " ").trim();

// The keys for `answers` (one per question), or why not. `labels` is, per question, the labels of the
// options picked as the phone showed them: a question whose options changed is refused.
export function answerSteps(p: Prompt, answers: unknown, labels: unknown): { steps: Step[] } | { error: string } {
  if (p.kind !== "question" || !p.answerable) return { error: "the question changed" };
  const qs = p.questions;
  if (!Array.isArray(answers) || answers.length !== qs.length || !Array.isArray(labels) || labels.length !== qs.length)
    return { error: "the question changed" };
  const steps: Step[] = [];
  for (const [q, question] of qs.entries()) {
    const a = answers[q] as any;
    const n = question.options.length;
    const picks: unknown = a?.picks ?? [];
    const text = typeof a?.text === "string" ? oneLine(a.text) : undefined;
    if (!Array.isArray(picks) || !picks.every((i) => Number.isInteger(i) && i >= 0 && i < n) || new Set(picks).size !== picks.length)
      return { error: "that answer doesn't fit the question" };
    if (a?.text !== undefined && (typeof a.text !== "string" || !text || a.text.length > MAX_TEXT))
      return { error: "a typed answer must be some text, at most 2000 characters" };
    const shown = labels[q];
    if (!Array.isArray(shown) || shown.length !== picks.length || picks.some((i, k) => question.options[i].label !== shown[k]))
      return { error: "the question changed" };
    const paste = text && `\x1b[200~${text}\x1b[201~`;
    if (question.preview) {
      if (picks.length + (text ? 1 : 0) !== 1) return { error: "pick one option or type an answer" };
      if (text) return { error: "this question takes one of its options; type an answer on the Mac" };
      steps.push({ expect: { q }, keys: String(picks[0] + 1) }, { expect: { q, cursor: picks[0] + 1 }, keys: "\r" });
    } else if (!question.multiSelect) {
      if (picks.length + (text ? 1 : 0) !== 1) return { error: "pick one option or type an answer" };
      // A digit picks and moves on. "Type something" (options + 1) becomes a text field; Enter takes it.
      if (!paste) steps.push({ expect: { q, cursor: 1 }, keys: String(picks[0] + 1) });
      else steps.push({ expect: { q, cursor: 1 }, keys: String(n + 1) }, { expect: { q, cursor: n + 1 }, keys: paste }, { expect: { q, cursor: n + 1, typed: true }, keys: "\r" });
    } else {
      if (!picks.length && !text) return { error: "pick at least one option or type an answer" };
      // Digits tick boxes and leave the cursor on row 1; ↓ walks it to the text row, then to Next/Submit.
      const ticked: number[] = [];
      for (const i of picks) {
        steps.push({ expect: { q, cursor: 1, ticked: [...ticked] }, keys: String(i + 1) });
        ticked.push(i + 1);
      }
      if (paste) {
        steps.push({ expect: { q, cursor: 1, ticked: [...ticked] }, keys: DOWN.repeat(n) }, { expect: { q, cursor: n + 1, ticked: [...ticked] }, keys: paste });
        ticked.push(n + 1); // pasting ticks its box
        steps.push({ expect: { q, cursor: n + 1, ticked: [...ticked], typed: true }, keys: DOWN });
      } else steps.push({ expect: { q, cursor: 1, ticked: [...ticked] }, keys: DOWN.repeat(n + 1) });
      steps.push({ expect: { q, cursor: "next", ticked: [...ticked] }, keys: "\r" });
    }
  }
  // One single-choice question submits with its answer; otherwise a review screen comes, where 1 submits.
  if (qs.length > 1 || qs[0].multiSelect) steps.push({ expect: { review: true }, keys: "1" });
  // Only these keys, whatever the status file said: digits, ↓, Enter, and a paste of cleaned text.
  const safe = (k: string) => /^[1-9]$|^(\x1b\[B)+$|^\r$/.test(k) || /^\x1b\[200~[^\x00-\x1f\x7f-\x9f]+\x1b\[201~$/.test(k);
  return steps.every((s) => safe(s.keys)) ? { steps } : { error: "that answer doesn't fit the question" };
}

// The dialog as the screen shows it: the last tab bar (` ☐ Color  ☒ Size  ✔ Submit` or ` ☐ Drink`), the
// question under it, its numbered rows up to the line before "Chat about this", where the cursor ❯ is.
export type Row = { n: number; label: string; ticked?: boolean };
export type Dialog = { question: string; review: boolean; rows: Row[]; cursor?: number | "next" };

const squash = (s: string) => s.replace(/\s+/g, "");

export function parseDialog(screen: string): Dialog | undefined {
  const lines = screen.split("\n");
  const bar = lines.findLastIndex((l) => /^\s*(←\s+)?[☐☒] \S/.test(l));
  if (bar < 0) return;
  const head: string[] = [];
  const rows: Row[] = [];
  let cursor: Dialog["cursor"];
  let next = false;
  for (const l of lines.slice(bar + 1)) {
    if (/^\s*─{3,}\s*$/.test(l) || /^\s*Enter to select/.test(l)) break;
    const row = l.match(/^\s*(❯)?\s*(\d)\.\s+(?:\[(✔| )\]\s+)?(.*?)\s*$/);
    if (row && Number(row[2]) === rows.length + 1) {
      // A question with previews has the preview's box on the same line, after the label.
      const label = row[4].replace(/\s{2,}[│┌├└].*$/, "");
      rows.push({ n: rows.length + 1, label, ...(row[3] && { ticked: row[3] === "✔" }) });
      if (row[1]) cursor = rows.length;
      next = false;
      continue;
    }
    if (!rows.length) {
      // A long question is drawn with a "│" down its left side.
      const text = l.trim().replace(/^│\s?/, "").trim();
      if (text) head.push(text);
      continue;
    }
    const nx = l.match(/^\s*(❯)?\s+(Next|Submit)\s*$/);
    if (nx) {
      next = true;
      if (nx[1]) cursor = "next";
    } else if (next && l.trim()) next = false;
  }
  const review = head[0] === "Review your answers";
  return { question: review ? "" : head.join(" "), review, rows, ...(cursor !== undefined && { cursor }) };
}

export function screenMeets(p: Prompt, d: Dialog | undefined, e: Expect): boolean {
  if (!d || p.kind !== "question") return false;
  if ("review" in e) return d.review && d.cursor === 1 && d.rows[0]?.label === "Submit answers";
  const q = p.questions[e.q];
  if (!q || d.review || squash(d.question) !== squash(q.question) || (e.cursor !== undefined && d.cursor !== e.cursor)) return false;
  const n = q.options.length;
  // Row n + 1 is "Type something." (or "[ ] Type something") until text is typed into it.
  // A long label wraps: its row shows the start of it.
  const same = (shown: string, label: string) => !!squash(shown) && squash(label).startsWith(squash(shown));
  if (d.rows.length < (q.preview ? n : n + 1) || d.rows.slice(0, n).some((r, i) => !same(r.label, q.options[i].label))) return false;
  if (e.typed !== undefined && /^Type something\.?$/.test(d.rows[n].label) === e.typed) return false;
  if (e.ticked) {
    const on = d.rows.slice(0, n + 1).filter((r) => r.ticked).map((r) => r.n);
    if (d.rows.slice(0, n + 1).some((r) => r.ticked === undefined) || on.join() !== [...e.ticked].sort((a, b) => a - b).join()) return false;
  }
  return true;
}

// Folder trust: in a folder not trusted yet, Claude Code 2.1.300 first asks "Accessing workspace: <folder> …
// Is this a project you created or one you trust?" with two unnumbered rows, `❯ No, exit` and
// `  Yes, I trust this folder`, the cursor on No; ↓ / ↑ move it and Enter takes it. No hook fires and
// Claude writes no status file until it's answered, so only the screen says it's there.
export const TRUST_OPTIONS = ["Yes, I trust this folder", "No, exit"];
export type Trust = { folder: string; cursor?: "yes" | "no" };

// The question as the screen's end shows it: the folder under "Accessing workspace:", the question (wrapped
// on a narrow screen), No then Yes, and after them only the footer. Anything else is not that question.
export function parseTrust(screen: string): Trust | undefined {
  const lines = screen.split("\n");
  const head = lines.findLastIndex((l) => /^\s*Accessing workspace:\s*$/.test(l));
  if (head < 0) return;
  const rest = lines.slice(head + 1);
  const row = (label: string) => rest.findIndex((l) => l.replace(/^\s*❯?/, "").trim() === label);
  const no = row("No, exit");
  const yes = row("Yes, I trust this folder");
  if (no < 0 || yes !== no + 1) return;
  if (!squash(rest.slice(0, no).join("")).includes(squash("Is this a project you created or one you trust?"))) return;
  if (rest.slice(yes + 1).some((l) => l.trim() && !/^\s*Enter to confirm/.test(l))) return;
  // A long path wraps onto more lines.
  const ask = rest.findIndex((l) => /^\s*Quick safety/.test(l));
  const folder = rest.slice(0, ask < 0 ? no : ask).map((l) => l.trim()).join("");
  const on = (i: number) => /^\s*❯/.test(rest[i]);
  return { folder, ...(on(no) ? { cursor: "no" as const } : on(yes) ? { cursor: "yes" as const } : {}) };
}

export function trustPrompt(screen: string): Prompt | undefined {
  const t = parseTrust(screen);
  return t && { kind: "trust", folder: t.folder, options: [...TRUST_OPTIONS], answerable: true };
}

// Where the cursor must be before each key: Yes is ↓ from No, then Enter; No is Enter.
export function trustSteps(pick: number): { cursor: "yes" | "no"; keys: string }[] | undefined {
  if (pick === 0) return [{ cursor: "no", keys: DOWN }, { cursor: "yes", keys: "\r" }];
  if (pick === 1) return [{ cursor: "no", keys: "\r" }];
}
