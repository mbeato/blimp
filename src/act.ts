// The assistant's act commands besides blimpd send (docs/superpowers/specs/2026-10-26-assistant-design.md,
// section 2). The assistant's folder settings make Claude ask the user before running either. They go through
// the running blimpd, so its rules hold: a folder inside home, a cleaned first message, and an answer only to the
// question still on screen, by its choice's text.

import { resolve } from "node:path";
import { ASSISTANT } from "./assistant";
import { callBlimpd, getJson } from "./client";
import { choiceLabel, type Prompt } from "./prompt";

const errorOf = async (r: Response) => ((await r.json().catch(() => ({}))) as any)?.error ?? `blimpd answered ${r.status}`;

// `--job <reason>` from anywhere in args: its words, and the other args.
export function takeJob(args: string[]): { args: string[]; job?: string } {
  const i = args.indexOf("--job");
  if (i < 0) return { args };
  return { args: [...args.slice(0, i), ...args.slice(i + 2)], job: args[i + 1] };
}

// Run by the assistant, an act on another session makes it one of the assistant's jobs (jobs.ts), named by --job or
// else by what was said. The act is done either way, so a job that couldn't be recorded is only said.
export async function recordJob(command: string, session: string, reason: string): Promise<void> {
  if (process.env.ZMX_SESSION !== ASSISTANT || session === ASSISTANT) return;
  const words = Array.from(reason.replace(/\s+/g, " ").trim()).slice(0, 80).join("") || session;
  try {
    const r = await callBlimpd("/assistant/jobs", { method: "POST", body: JSON.stringify({ session, reason: words }) });
    if (!r.ok) console.error(`blimpd ${command}: done, but the job wasn't recorded: ${await errorOf(r)}`);
  } catch (e) {
    console.error(`blimpd ${command}: done, but the job wasn't recorded: ${(e as Error).message}`);
  }
}

// blimpd start <folder> <first message…> [--job <reason>]: a new Claude session there.
export async function runStart(argv: string[]): Promise<number> {
  const fail = (m: string) => (console.error(`blimpd start: ${m}`), 1);
  const { args, job } = takeJob(argv);
  const [folder, ...words] = args;
  const text = words.join(" ");
  if (!folder || !text.trim()) return fail("usage: blimpd start <folder> <first message> [--job <reason>]");
  const dir = resolve(folder);
  try {
    const r = await callBlimpd("/sessions", { method: "POST", body: JSON.stringify({ dir, prompt: text }) });
    if (!r.ok) return fail(await errorOf(r));
    const { name } = (await r.json()) as { name: string };
    console.log(`started ${name} in ${dir}`);
    await recordJob("start", name, job || text);
    return 0;
  } catch (e) {
    return fail((e as Error).message);
  }
}

// blimpd answer <session> <option number> [--job <reason>]: option N (from 1, as overview numbers them) of what it asks now.
export async function runAnswer(argv: string[]): Promise<number> {
  const fail = (m: string) => (console.error(`blimpd answer: ${m}`), 1);
  const { args, job } = takeJob(argv);
  const [name, option, ...rest] = args;
  const n = Number(option);
  if (!name || rest.length || !Number.isInteger(n) || n < 1) return fail("usage: blimpd answer <session> <option number> [--job <reason>]");
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
    await recordJob("answer", name, job || `answer: ${label}`);
    return 0;
  } catch (e) {
    return fail((e as Error).message);
  }
}
