// What a waiting Claude is asking, so the phone can show it as buttons. The hook knows the
// question; for permission prompts only the screen shows the options (they vary by command), so
// blimpd reads them from `zmx history` once per wait. Answers are key presses, decided here only.

import { toolSummary } from "./chat";

export type Question = { question: string; header?: string; multiSelect: boolean; options: { label: string; description?: string }[] };
export type Prompt =
  | { kind: "permission"; tool: string; summary: string; options: string[]; keys: string[]; answerable: true }
  | { kind: "question"; questions: Question[]; answerable: boolean }
  | { kind: "other"; answerable: false };

const str = (v: unknown) => (typeof v === "string" ? v : "");

export function promptFromHook(ev: any): Prompt | undefined {
  const e = ev?.hook_event_name;
  // In default mode Claude also sends PermissionRequest for the question tool: that is the question.
  if (e === "PermissionRequest" && ev.tool_name !== "AskUserQuestion") {
    const tool = str(ev.tool_name);
    // Without the screen: Yes is the first option, and Esc says no.
    return { kind: "permission", tool, summary: toolSummary(tool, ev.tool_input, str(ev.cwd)), options: ["Yes", "No"], keys: ["1", "\x1b"], answerable: true };
  }
  if ((e === "PreToolUse" || e === "PermissionRequest") && ev.tool_name === "AskUserQuestion") {
    const questions: Question[] = (Array.isArray(ev.tool_input?.questions) ? ev.tool_input.questions : []).map((q: any) => ({
      question: str(q?.question),
      ...(typeof q?.header === "string" && { header: q.header }),
      multiSelect: q?.multiSelect === true,
      options: (Array.isArray(q?.options) ? q.options : []).map((o: any) => ({ label: str(o?.label), ...(typeof o?.description === "string" && { description: o.description }) })),
    }));
    // Digits pick and submit one single-choice question; anything more took the wrong boxes in the probe.
    return { kind: "question", questions, answerable: questions.length === 1 && !questions[0].multiSelect && questions[0].options.length <= 9 };
  }
  if (e === "Elicitation") return { kind: "other", answerable: false };
}

// The numbered lines after "Do you want to proceed?": "❯ 1. Yes", "  2. …".
export function parseScreenOptions(screen: string): string[] {
  const lines = screen.split("\n");
  const start = lines.findLastIndex((l) => l.includes("Do you want to proceed?"));
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
  return options.length ? { ...p, options, keys: options.map((_, i) => String(i + 1)) } : p;
}

export function answerKeys(p: Prompt, pick: number): string | undefined {
  if (!Number.isInteger(pick) || pick < 0 || !p.answerable) return;
  if (p.kind === "permission") return p.keys[pick];
  if (p.kind === "question" && pick < p.questions[0].options.length) return String(pick + 1);
}
