// Terminal keys, matching the VS Code terminal on macOS. xterm.js asks before it handles a key;
// mapKey says what to do instead.

export type KeyLike = {
  type: string; // keydown | keypress | keyup
  key: string;
  metaKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
};

export type KeyAction =
  | { kind: "send"; data: string } // send these bytes, skip xterm
  | { kind: "copy" } // copy the selection, skip xterm
  | { kind: "skip" } // xterm ignores it; the browser and the app's shortcuts still see it
  | { kind: "xterm" }; // let xterm handle it as usual

const plain = (e: KeyLike) => !e.ctrlKey && !e.shiftKey;

// claude: the session runs Claude Code, where Shift+Enter starts a new line. It reads ESC CR
// (Option+Enter) as one, which is what VS Code's `/terminal-setup` makes Shift+Enter send. A
// shell gets the usual Enter.
export function mapKey(e: KeyLike, hasSelection: boolean, claude = false): KeyAction {
  const cmd = e.metaKey && !e.altKey && plain(e);
  const opt = e.altKey && !e.metaKey && plain(e);
  let data: string | undefined;
  if (cmd && e.key === "Backspace") data = "\x15"; // delete to line start
  else if (opt && e.key === "Backspace") data = "\x17"; // delete word
  else if (cmd && e.key === "ArrowLeft") data = "\x01"; // line start
  else if (cmd && e.key === "ArrowRight") data = "\x05"; // line end
  else if (opt && e.key === "ArrowLeft") data = "\x1bb"; // word left
  else if (opt && e.key === "ArrowRight") data = "\x1bf"; // word right
  else if (claude && e.key === "Enter" && e.shiftKey && !e.metaKey && !e.altKey && !e.ctrlKey) data = "\x1b\r"; // new line
  if (data !== undefined) return e.type === "keydown" ? { kind: "send", data } : { kind: "skip" };

  // ⌘C copies when there is a selection. ⌘V is left to the browser's paste event, which xterm
  // already turns into input (with bracketed paste). ⌘K and every other ⌘ combo belong to the app.
  if (e.metaKey && !e.altKey && !e.ctrlKey && e.key.toLowerCase() === "c" && hasSelection && e.type === "keydown")
    return { kind: "copy" };
  if (e.metaKey) return { kind: "skip" };
  return { kind: "xterm" };
}
