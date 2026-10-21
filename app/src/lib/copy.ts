// What a copy of a terminal selection gives: one line for what was one line, however it was wrapped.
// Web links broken over rows are found the same way (webLinks), so ⌘-click opens all of one.

// full: the whole row, trailing spaces off. width: the columns it fills. wrapped: xterm's mark that it
// goes on from the row before. text: the part of it that's selected.
export type Row = { full: string; width: number; wrapped: boolean; text: string };

// How row `cur` goes on from row `prev`:
// - "wrap": straight on. xterm wrapped the row (it knows: `wrapped`), or the row is full and the next
//   starts at the left edge: also xterm's wrap, but a redraw (zmx sends the screen row by row when a
//   terminal attaches) lost the mark, so a copy broke words in two;
// - "split": straight on after the indent. A program wrapping its text with an indent (Claude Code
//   does) broke a word at the edge, since no row could hold its two halves: a link or a long path.
//   Claude Code's prompt stops a column short of the edge;
// - "space": the next row is indented and its first word wouldn't have fit on this one: the program
//   wrapped at a space;
// - "newline": anything else.
export function rowBreak(prev: Row, cur: Row, cols: number): "wrap" | "split" | "space" | "newline" {
  const indent = cur.full.length - cur.full.trimStart().length;
  if (cur.wrapped || (prev.width >= cols && indent === 0 && cur.full !== "")) return "wrap";
  const word = cur.full.trimStart().split(" ")[0];
  if (indent === 0 || !word || !prev.full.trim()) return "newline";
  const last = prev.full.split(" ").pop()!;
  if (prev.width >= cols - 1 && [...last].length + [...word].length > cols - indent) return "split";
  if (prev.width + 1 + [...word].length > cols) return "space";
  return "newline";
}

export function joinRows(rows: Row[], cols: number): string {
  let out = rows[0]?.text ?? "";
  for (let i = 1; i < rows.length; i++) {
    const [b, text] = [rowBreak(rows[i - 1], rows[i], cols), rows[i].text];
    if (b === "wrap") out += text;
    else if (b === "newline") out += "\n" + text;
    else out = out.trimEnd() + (b === "space" ? " " : "") + text.trimStart();
  }
  return out;
}

// WebLinksAddon's pattern.
const WEB_LINK = /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\\^<>`]*[^\s"':,.!?{}|\\\^~\[\]`()<>]/g;

// The web links in rows read as joinRows reads them, each with the [row, index in its full] it starts
// and ends at (the end inclusive).
export function webLinks(rows: Row[], cols: number): { url: string; start: [number, number]; end: [number, number] }[] {
  let text = "";
  const at: [number, number][] = [];
  rows.forEach((r, i) => {
    const b = i ? rowBreak(rows[i - 1], r, cols) : "wrap";
    let from = 0;
    if (b === "newline" || b === "space") (text += b === "space" ? " " : "\n"), at.push([i, 0]);
    if (b === "split" || b === "space") from = r.full.length - r.full.trimStart().length;
    for (let c = from; c < r.full.length; c++) (text += r.full[c]), at.push([i, c]);
  });
  return [...text.matchAll(WEB_LINK)].map((m) => ({ url: m[0], start: at[m.index], end: at[m.index + m[0].length - 1] }));
}
