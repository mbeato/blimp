// Sending a text through Messages (docs/superpowers/specs/2026-10-26-messages-design.md, section 1): osascript, with
// the text and the handle as arguments, never pasted into the script, to the handle's conversation on the
// account's iMessage service.

export const SEND_SCRIPT = `on run argv
  tell application "Messages"
    set s to 1st account whose service type = iMessage
    send (item 1 of argv) to participant (item 2 of argv) of s
  end tell
end run`;

export type Run = (cmd: string[], stdin: string) => { code: number; err: string };

const osascript: Run = (cmd, stdin) => {
  const r = Bun.spawnSync(cmd, { stdin: new TextEncoder().encode(stdin), stdout: "ignore", stderr: "pipe" });
  return { code: r.exitCode ?? 1, err: r.stderr.toString().trim() };
};

// Undefined once sent, or why not.
export function sendText(text: string, to: string, run: Run = osascript): string | undefined {
  const r = run(["osascript", "-", text, to], SEND_SCRIPT);
  return r.code === 0 ? undefined : r.err || `osascript exited ${r.code}`;
}
