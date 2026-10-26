// The assistant (docs/superpowers/specs/2026-10-26-assistant-design.md): one Claude session, named `assistant`, that
// blimpd keeps running in <socket dir>/assistant, a folder that isn't a project. It looks at every project with
// `blimpd overview` and `blimpd read`, and acts on another session only with `blimpd start`, `send` or `answer`,
// each of which its folder's settings make Claude ask the user about first. Off unless config.json says
// {"assistant": true}.

import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectFolderName } from "./folders";
import { configFile, readConfig } from "./names";
import { blimpDir, realDir } from "./sessions";

export const ASSISTANT = "assistant";
export const assistantDir = () => join(blimpDir(), "assistant");
export const assistantOn = (file = configFile()) => readConfig(file).assistant === true;

// What the assistant is told, written on every start so a new blimpd can change it. cmd: this blimpd, as the
// session runs it. For any blimp user: no names, no tools only some people have.
export const blimpMd = (cmd: string) => `# The blimp assistant

You are the user's assistant in blimp, the app they use to run Claude Code sessions on this server. You aren't
tied to a project: they come here for general questions, errands in the browser, and anything across their
projects. blimp keeps this session running, so this one chat carries on and there's no need to wrap up.

## Look freely

- \`${cmd} overview\`: every project, its running sessions (name, title, state, note), what each waiting
  session asks with its numbered options, and unread past conversations with their ids.
- \`${cmd} read <session or conversation id> [--last N]\`: its latest messages (20 unless you say).
- Any file in the home folder, with your normal tools.

Use these whenever a question is about the user's sessions or projects, rather than guessing.

## Ask before you act

These change another session, so each one shows the user a permission prompt first:

- \`${cmd} start <folder> <message>\`: a new Claude session in that folder (give its full path), with that first
  message.
- \`${cmd} send <session> <message>\`: type a message into a running session.
- \`${cmd} answer <session> <option number>\`: pick one of a session's options, numbered as overview shows them.

Don't get around the prompt with other commands that do the same thing (curl to blimpd's socket, zmx, typing
into a terminal). Hand bigger work to a project session with \`start\` instead of doing it here, so this chat
stays quick.

## The browser

Your browser tabs are yours, but they share the user's logins with every blimp tab. When a site needs a login,
ask the user to sign in themselves in your tab; never ask for a password in the chat. Before anything that buys,
books, sends, posts, signs up or accepts terms, stop and ask in the chat, saying exactly what you'll do.

## Memory

If your instructions give you a memory tool, keep what's worth remembering there: this chat is compacted as it
grows, and older details fade.
`;

// Written once; the rest of the file is the user's.
export const CLAUDE_MD = `@blimp.md

<!-- blimp wrote this file once and won't change it again. Add your own instructions for the assistant below. -->
`;

// Tools that send something as the user: connectors' send actions ask first, as the act commands do.
const SEND_TOOLS = [
  "mcp__claude_ai_Gmail__send_message",
  "mcp__claude_ai_Gmail__reply",
  "mcp__claude_ai_Gmail__forward",
  "mcp__claude_ai_Slack__slack_send_message",
  "mcp__claude_ai_Slack__slack_schedule_message",
  "mcp__claude_ai_Zapier__execute_zapier_write_action",
];

// The folder's Claude settings. Each command rule is there under the bare name (blimpd on PATH) and under the
// command blimpd runs from, since Claude matches the text it runs. ask beats allow, wherever an allow comes from.
export function assistantSettings(cmd: string) {
  const both = (rule: string) => [...new Set([`Bash(blimpd ${rule})`, `Bash(${cmd} ${rule})`])];
  return {
    permissions: {
      defaultMode: "default" as const,
      allow: [...both("overview"), ...both("read:*"), "Read(~/**)"],
      ask: [...both("start:*"), ...both("send:*"), ...both("answer:*"), ...SEND_TOOLS],
    },
  };
}

function writeAtomic(file: string, text: string) {
  writeFileSync(file + ".tmp", text, { mode: 0o600 });
  chmodSync(file + ".tmp", 0o600);
  renameSync(file + ".tmp", file);
}

// self: this blimpd as a command (selfCommand()). The user's own settings go in settings.local.json, which
// blimpd never touches.
export function writeAssistantFiles(dir: string, self: string[]) {
  mkdirSync(join(dir, ".claude"), { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const cmd = self.join(" ");
  writeAtomic(join(dir, "blimp.md"), blimpMd(cmd));
  writeAtomic(join(dir, ".claude", "settings.json"), JSON.stringify(assistantSettings(cmd), null, 2) + "\n");
  if (!existsSync(join(dir, "CLAUDE.md"))) writeAtomic(join(dir, "CLAUDE.md"), CLAUDE_MD);
}

// Whether Claude has a conversation in dir to --continue (it fails with none).
export function hasConversation(dir: string, claude: string): boolean {
  try {
    return readdirSync(join(claude, "projects", projectFolderName(realDir(dir)))).some((n) => n.endsWith(".jsonl"));
  } catch {
    return false;
  }
}
