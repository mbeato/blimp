// Claude Code hooks that record each session's state in blimp's own files, as a backup for
// Claude's internal status files. `blimpd install-hooks` adds them; Claude runs `blimpd hook`.
// Codex takes hooks in the same format in ~/.codex/hooks.json and sends the same JSON, so the same
// install adds blimp's there too (`blimpd hook codex`): for Codex they are the only source of state.

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promptFromHook } from "./prompt";
import { blimpDir, claudeDir, isSafeName } from "./sessions";

const EVENTS = ["Notification", "Stop", "UserPromptSubmit", "PostToolUse", "PermissionRequest", "PreToolUse", "Elicitation"];

// PreToolUse only for the question tool: it fires the moment Claude asks, and a hook on every tool call would
// add a process start to each one.
const MATCHERS: Record<string, string> = { PreToolUse: "AskUserQuestion" };

// PermissionRequest, PreToolUse(AskUserQuestion) and Elicitation fire as the prompt appears. Notification can
// come seconds later, so it's only a second signal for the same thing.
const STATES: Record<string, string> = {
  Notification: "waiting",
  PermissionRequest: "waiting",
  PreToolUse: "waiting",
  Elicitation: "waiting",
  UserPromptSubmit: "working",
  PostToolUse: "working",
  Stop: "done",
};

// Claude also sends Notification for things that aren't a question, like idle_prompt (about 60 s after a
// finished turn) and auth_success. Only these mean Claude is stuck until the user answers.
const WAITING_NOTIFICATIONS = ["permission_prompt", "elicitation_dialog", "elicitation_url_dialog"];

// Codex: every tool call is work (there's no question tool), PermissionRequest is Codex asking
// before it runs something. Its own `notify` program is left alone.
const CODEX_STATES: Record<string, string> = {
  UserPromptSubmit: "working",
  PreToolUse: "working",
  PostToolUse: "working",
  PermissionRequest: "waiting",
  Stop: "done",
};

// Which file, which events, and what the hook runs: `blimpd hook` for Claude, `blimpd hook codex`.
export type HookSet = { events: string[]; matchers: Record<string, string>; arg: string };
export const CLAUDE_HOOKS: HookSet = { events: EVENTS, matchers: MATCHERS, arg: "hook" };
export const CODEX_HOOKS: HookSet = { events: Object.keys(CODEX_STATES), matchers: {}, arg: "hook codex" };
export const codexHooksFile = () => join(process.env.CODEX_HOME || join(homedir(), ".codex"), "hooks.json");

const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

// Ours: any blimpd's hook (an older install, another path), or this exact command whatever the binary is called.
const isOurs = (h: any, command: string) =>
  typeof h?.command === "string" &&
  (h.command === command || h.command.includes("blimpd' hook") || h.command.includes("blimpd hook"));

// Merges blimp's hooks into settings.json, keeping everything else. Returns the events it added.
// New entries go at the end of each event's list: Codex remembers which hooks you trusted by their
// place in the list, so the ones already there keep theirs.
export function installHooks(blimpdPath: string, settingsPath = join(claudeDir(), "settings.json"), set = CLAUDE_HOOKS): string[] {
  const exists = existsSync(settingsPath);
  // Unreadable JSON throws here: better to stop than overwrite someone's settings.
  const settings = exists ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};
  settings.hooks ??= {};
  const command = `${shellQuote(blimpdPath)} ${set.arg}`;
  const added = [];
  for (const event of set.events) {
    const groups = (settings.hooks[event] ??= []);
    if (groups.some((g: any) => Array.isArray(g?.hooks) && g.hooks.some((h: any) => isOurs(h, command)))) continue;
    const matcher = set.matchers[event];
    groups.push({ ...(matcher && { matcher }), hooks: [{ type: "command", command, timeout: 5 }] });
    added.push(event);
  }
  if (!added.length) return added;

  const backup = settingsPath + ".blimp-backup";
  if (exists && !existsSync(backup)) copyFileSync(settingsPath, backup);
  writeSettings(settingsPath, settings);
  return added;
}

// Takes out the hooks installHooks added (any blimpd's, or this exact command) and keeps everything else.
// A group or event left empty goes too, so install then uninstall gives back the same settings.
// Returns the events it removed them from.
export function uninstallHooks(blimpdPath: string, settingsPath = join(claudeDir(), "settings.json"), set = CLAUDE_HOOKS): string[] {
  if (!existsSync(settingsPath)) return [];
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  const hooks = settings.hooks;
  const command = `${shellQuote(blimpdPath)} ${set.arg}`;
  const removed = [];
  for (const event of set.events) {
    const groups = hooks?.[event];
    if (!Array.isArray(groups)) continue;
    const ours = (g: any) => Array.isArray(g?.hooks) && g.hooks.some((h: any) => isOurs(h, command));
    if (!groups.some(ours)) continue;
    const kept = groups
      .map((g: any) => (ours(g) ? { ...g, hooks: g.hooks.filter((h: any) => !isOurs(h, command)) } : g))
      .filter((g: any) => !Array.isArray(g?.hooks) || g.hooks.length);
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
    removed.push(event);
  }
  if (!removed.length) return removed;
  if (!Object.keys(hooks).length) delete settings.hooks;
  writeSettings(settingsPath, settings);
  return removed;
}

// Atomic (temp file, then rename), keeping the file's mode.
function writeSettings(settingsPath: string, settings: unknown) {
  const exists = existsSync(settingsPath);
  mkdirSync(dirname(settingsPath), { recursive: true });
  // settings.json is often a symlink into a dotfiles repo: write its target, or the rename replaces the link.
  const target = exists ? realpathSync(settingsPath) : settingsPath;
  const mode = exists ? statSync(target).mode & 0o777 : 0o600;
  const tmp = `${target}.blimp-${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, target);
}

// Runs inside Claude or Codex (which zmx started, so ZMX_SESSION names the session). Never fails their
// turn: any problem is swallowed, and nothing is printed.
export function writeHookStatus(input: string, session: string | undefined, statusDir = join(blimpDir(), "status"), codex = false) {
  // The name becomes a file name: "../x" or "a/b" must not write anywhere else.
  if (!session || !isSafeName(session)) return;
  let ev: any;
  try {
    ev = JSON.parse(input);
  } catch {
    return;
  }
  const state = (codex ? CODEX_STATES : STATES)[ev?.hook_event_name];
  if (!state) return;
  // Codex has no Notification event or question tool to tell apart.
  if (!codex && ev.hook_event_name === "Notification" && !WAITING_NOTIFICATIONS.includes(ev.notification_type)) return;
  if (!codex && ev.hook_event_name === "PreToolUse" && ev.tool_name !== MATCHERS.PreToolUse) return;
  mkdirSync(statusDir, { recursive: true, mode: 0o700 });
  const file = join(statusDir, `${session}.json`);
  // What Claude asks, for the phone. The Notification that follows a permission prompt seconds
  // later carries no details, so it keeps the prompt, and the time the wait started, already
  // recorded for this wait (the phone's answer names the wait by that time). In default mode a
  // question comes as PreToolUse then PermissionRequest: one wait, so it keeps the first time.
  let prompt = codex ? undefined : promptFromHook(ev);
  let at = Date.now();
  let prev: any;
  try {
    prev = JSON.parse(readFileSync(file, "utf8"));
  } catch {}
  // A subagent's tool calls come in the same session, with its agent_id. One ends only the subagent's own
  // wait: while a background agent works, Claude still shows the main thread's question (2.1.300).
  const agent = typeof ev.agent_id === "string" ? ev.agent_id : undefined;
  if (state === "working" && agent && prev?.state === "waiting" && prev.sessionId === ev.session_id && prev.agent !== agent) return;
  let waitAgent = state === "waiting" ? agent : undefined;
  if (state === "waiting" && (!prompt || prompt.kind === "question")) {
    if (prev?.state === "waiting" && prev.sessionId === ev.session_id && prev.prompt) {
      if (!prompt) ({ prompt, at, agent: waitAgent } = prev);
      else if (prev.prompt.kind === "question") at = prev.at;
    }
  }
  // at is when this file was last written (what deriveState compares with Claude's file), or for a wait
  // the wait's own time. since is when the state began: each tool call while working keeps it. A file
  // from before since existed has only at.
  let since = at;
  if (state !== "waiting" && prev?.state === state && prev.sessionId === ev.session_id) {
    const t = prev.since ?? prev.at;
    if (typeof t === "number") since = t;
  }
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ state, at, since, sessionId: ev.session_id, event: ev.hook_event_name, ...(prompt && { prompt }), ...(waitAgent && { agent: waitAgent }) }));
  renameSync(tmp, file); // the server never reads half a file
}

export async function runHook(codex = false) {
  try {
    writeHookStatus(await Bun.stdin.text(), process.env.ZMX_SESSION, undefined, codex);
  } catch {}
  process.exit(0);
}
