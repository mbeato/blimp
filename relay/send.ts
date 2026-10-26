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

// The first Apple event to Messages (pokeMessages, at start) raises macOS's Automation prompt and osascript waits
// for a click; a minute leaves time for that.
const SEND_TIMEOUT_MS = 60_000;

const osascript: Run = (cmd, stdin) => {
  const r = Bun.spawnSync(cmd, { stdin: new TextEncoder().encode(stdin), stdout: "ignore", stderr: "pipe", timeout: SEND_TIMEOUT_MS });
  return { code: r.exitCode ?? 1, err: r.stderr.toString().trim() };
};

// Undefined once sent, or why not.
export function sendText(text: string, to: string, run: Run = osascript): string | undefined {
  const r = run(["osascript", "-", text, to], SEND_SCRIPT);
  return r.code === 0 ? undefined : r.err || `osascript exited ${r.code}`;
}

// An Apple event that changes nothing, at start: macOS asks whether the relay may control Messages while someone is
// still signed in to this Mac user to click OK, not at the first text out. Undefined once Messages answered, or why not.
export function pokeMessages(run: Run = osascript): string | undefined {
  const r = run(["osascript", "-"], 'tell application "Messages" to get name');
  return r.code === 0 ? undefined : r.err || `osascript exited ${r.code}`;
}
