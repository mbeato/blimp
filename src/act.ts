// The assistant's act commands besides blimpd send (docs/superpowers/specs/2026-10-26-assistant-design.md,
// section 2). The assistant's folder settings make Claude ask the user before running either. They go through
// the running blimpd, so its rules hold: a folder inside home, a cleaned first message, and an answer only to the
// question still on screen, by its choice's text.

import { resolve } from "node:path";
import { callBlimpd, getJson } from "./client";
import { choiceLabel, type Prompt } from "./prompt";

const errorOf = async (r: Response) => ((await r.json().catch(() => ({}))) as any)?.error ?? `blimpd answered ${r.status}`;

// blimpd start <folder> <first message…>: a new Claude session there.
export async function runStart(args: string[]): Promise<number> {
  const fail = (m: string) => (console.error(`blimpd start: ${m}`), 1);
  const [folder, ...words] = args;
  const text = words.join(" ");
  if (!folder || !text.trim()) return fail("usage: blimpd start <folder> <first message>");
  const dir = resolve(folder);
  try {
    const r = await callBlimpd("/sessions", { method: "POST", body: JSON.stringify({ dir, prompt: text }) });
    if (!r.ok) return fail(await errorOf(r));
    console.log(`started ${((await r.json()) as { name: string }).name} in ${dir}`);
    return 0;
  } catch (e) {
    return fail((e as Error).message);
  }
}

// blimpd answer <session> <option number>: option N (from 1, as overview numbers them) of what it asks now.
export async function runAnswer(args: string[]): Promise<number> {
  const fail = (m: string) => (console.error(`blimpd answer: ${m}`), 1);
  const [name, option, ...rest] = args;
  const n = Number(option);
  if (!name || rest.length || !Number.isInteger(n) || n < 1) return fail("usage: blimpd answer <session> <option number>");
  try {
    const sessions = await getJson<{ name: string; state: string; prompt?: Prompt & { at: number } }[]>("/sessions");
    const s = sessions.find((x) => x.name === name);
    if (!s) return fail(`no session named ${name}`);
    const p = s.state === "waiting" ? s.prompt : undefined;
    if (!p) return fail(`${name} isn't asking anything`);
    if (!p.answerable || (p.kind === "question" && (p.questions.length > 1 || p.questions[0]?.multiSelect)))
      return fail(`${name}'s question needs the app: it has several parts or choices`);
    const label = choiceLabel(p, n - 1);
    if (label === undefined) return fail(`${name}'s question has no option ${n}`);
    const r = await callBlimpd(`/sessions/${encodeURIComponent(name)}/answer`, { method: "POST", body: JSON.stringify({ at: p.at, pick: n - 1, label }) });
    if (!r.ok) return fail(await errorOf(r));
    console.log(`answered ${name}: ${label}`);
    return 0;
  } catch (e) {
    return fail((e as Error).message);
  }
}
