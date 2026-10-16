// Claude Code hooks that record each session's state in blimp's own files, as a backup for
// Claude's internal status files. `blimpd install-hooks` adds them; Claude runs `blimpd hook`.

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

// Ours: any blimpd's hook (an older install, another path), or this exact command whatever the binary is called.
const isOurs = (h: any, command: string) =>
  typeof h?.command === "string" &&
  (h.command === command || h.command.includes("blimpd' hook") || h.command.includes("blimpd hook"));

// Merges blimp's hooks into settings.json, keeping everything else. Returns the events it added.
export function installHooks(blimpdPath: string, settingsPath = join(claudeDir(), "settings.json")): string[] {
  const exists = existsSync(settingsPath);
  // Unreadable JSON throws here: better to stop than overwrite someone's settings.
  const settings = exists ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};
  settings.hooks ??= {};
  const command = `${shellQuote(blimpdPath)} hook`;
  const added = [];
  for (const event of EVENTS) {
    const groups = (settings.hooks[event] ??= []);
    if (groups.some((g: any) => Array.isArray(g?.hooks) && g.hooks.some((h: any) => isOurs(h, command)))) continue;
    const matcher = MATCHERS[event];
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
export function uninstallHooks(blimpdPath: string, settingsPath = join(claudeDir(), "settings.json")): string[] {
  if (!existsSync(settingsPath)) return [];
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  const hooks = settings.hooks;
  const command = `${shellQuote(blimpdPath)} hook`;
  const removed = [];
  for (const event of EVENTS) {
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

// Runs inside Claude (which zmx started, so ZMX_SESSION names the session). Never fails Claude's turn:
// any problem is swallowed, and nothing is printed.
export function writeHookStatus(input: string, session: string | undefined, statusDir = join(blimpDir(), "status")) {
  // The name becomes a file name: "../x" or "a/b" must not write anywhere else.
  if (!session || !isSafeName(session)) return;
  let ev: any;
  try {
    ev = JSON.parse(input);
  } catch {
    return;
  }
  const state = STATES[ev?.hook_event_name];
  if (!state) return;
  if (ev.hook_event_name === "Notification" && !WAITING_NOTIFICATIONS.includes(ev.notification_type)) return;
  if (ev.hook_event_name === "PreToolUse" && ev.tool_name !== MATCHERS.PreToolUse) return;
  mkdirSync(statusDir, { recursive: true, mode: 0o700 });
  const file = join(statusDir, `${session}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ state, at: Date.now(), sessionId: ev.session_id, event: ev.hook_event_name }));
  renameSync(tmp, file); // the server never reads half a file
}

export async function runHook() {
  try {
    writeHookStatus(await Bun.stdin.text(), process.env.ZMX_SESSION);
  } catch {}
  process.exit(0);
}
