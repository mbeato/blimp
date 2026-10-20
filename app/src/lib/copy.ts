// What a copy of a terminal selection gives: one line for what was one line, however it was wrapped.
// Three kinds of row break aren't newlines:
// - xterm wrapped the row (it knows: `wrapped`);
// - the row is full and the next starts at the left edge: also xterm's wrap, but a redraw (zmx sends the
//   screen row by row when a terminal attaches) lost the mark, so a copy broke words in two;
// - the next row is indented and its first word wouldn't have fit on this one: a program wrapped its text
//   to the width (Claude Code does, with an indent), so the break goes back to a space.
// Anything else stays a newline.

// full: the whole row, trailing spaces off. width: the columns it fills. wrapped: xterm's mark that it
// goes on from the row before. text: the part of it that's selected.
export type Row = { full: string; width: number; wrapped: boolean; text: string };

export function joinRows(rows: Row[], cols: number): string {
  let out = rows[0]?.text ?? "";
  for (let i = 1; i < rows.length; i++) {
    const [prev, cur] = [rows[i - 1], rows[i]];
    const indent = cur.full.length - cur.full.trimStart().length;
    if (cur.wrapped || (prev.width >= cols && indent === 0 && cur.full !== "")) {
      out += cur.text;
      continue;
    }
    const word = cur.full.trimStart().split(" ")[0];
    if (indent > 0 && word && prev.full.trim() && prev.width + 1 + [...word].length > cols) {
      out = out.trimEnd() + " " + cur.text.trimStart();
      continue;
    }
    out += "\n" + cur.text;
  }
  return out;
}
