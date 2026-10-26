// What blimp texts, and how it reads a texted reply (docs/superpowers/specs/2026-10-26-messages-design.md,
// section 2): the assistant's answers as plain text, its questions as a text, and a reply as an answer to one, in the
// shape answer.ts takes.

import type { Prompt } from "../prompt";

export const OFF = "The assistant is off. Turn it on in blimp's Settings.";
export const PICTURE_ONLY = "I can only read text for now.";
export const PICTURE_NOTE = " (a picture came with this text; you can't see pictures yet)";
export const ALREADY = "That was already answered.";
export const OPEN_BLIMP = "It's asking something only blimp can show. Open blimp to answer.";
export const OFFLINE = "The Messages relay is offline: blimp hasn't heard from it in 5 minutes. Check the Mac it runs on.";

// Markdown as a text: as push/payload.ts's plainText, but with line breaks (at most one blank line in a row), list
// marks and link addresses kept.
export function plainLines(md: string): string {
  return md
    .replace(/^[ \t]*```.*$/gm, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (_, words: string, url: string) => (words && words !== url ? `${words} (${url})` : url))
    .replace(/^[ \t]{0,3}(?:#{1,6}|>)[ \t]+/gm, "")
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/\*(\S[^*\n]*?)\*/g, "$1")
    .replace(/`([^`\n]*)`/g, "$1")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const clip = (s: string, n = 600) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
// mcp__claude_ai_Gmail__send_message: Gmail send message.
const toolName = (tool: string) => tool.replace(/^mcp__/, "").replace(/^claude_ai_/, "").replace(/_+/g, " ").trim();
// The one question of a dialog a text can answer: one question, one choice.
const single = (p: Prompt) => (p.kind === "question" && p.answerable && p.questions.length === 1 && !p.questions[0].multiSelect ? p.questions[0] : undefined);

export function waitText(p: Prompt): string {
  if (p.kind === "permission") return [p.tool === "Bash" ? "OK to run this?" : `OK to use ${toolName(p.tool)}?`, ...(p.summary ? [clip(p.summary)] : [])].join("\n") + "\n\nReply yes or no.";
  const q = single(p);
  if (q) return `${q.question}\n${q.options.map((o, i) => `${i + 1}. ${o.label}`).join("\n")}\n\nReply with a number or your own words.`;
  return OPEN_BLIMP;
}

const YES = /^(yes|y|ok|okay)[.!]?$/i;
const NO = /^(no|n)[.!]?$/i;
const NUMBER = /^(\d+)[.!]?$/;

// A reply that only makes sense as an answer: one that comes after its question was answered elsewhere isn't typed.
export const isShortAnswer = (text: string) => [YES, NO, NUMBER].some((re) => re.test(text.trim()));

// The answer.ts message for a texted reply to the wait p, or undefined when a text can't answer it.
export function replyFor(p: Prompt & { at: number }, text: string): Record<string, unknown> | undefined {
  const t = text.trim();
  if (p.kind === "permission") {
    const yes = p.options.findIndex((o) => /^yes\b/i.test(o));
    const no = p.options.findIndex((o) => /^no\b/i.test(o));
    if (YES.test(t)) return yes < 0 ? undefined : { type: "answer", at: p.at, pick: yes, label: p.options[yes] };
    if (NO.test(t)) return no < 0 ? undefined : { type: "answer", at: p.at, pick: no, label: p.options[no] };
    return { type: "deny", at: p.at, text: t };
  }
  const q = single(p);
  if (!q) return undefined;
  const n = NUMBER.exec(t);
  const i = n ? Number(n[1]) - 1 : -1;
  if (i >= 0 && i < q.options.length) return { type: "answer", at: p.at, answers: [{ picks: [i] }], labels: [[q.options[i].label]] };
  return { type: "answer", at: p.at, answers: [{ text: t }], labels: [[]] };
}
