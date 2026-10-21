// Commands Claude hands over in its latest reply, for the apps' Run button (blimpd's runs.ts runs one
// when you click it, never before). A command is a fenced code block marked bash, sh, shell, zsh or
// console (the whole block, "$ " prompts taken off), or inline code that starts with a command word
// (`bun test`, `cd app`), one line each. Newest first, at most 5, each at most 4000 characters.

const LANGS = ["bash", "sh", "shell", "zsh", "console"];
const WORDS = /^(?:bash|sh|zsh|python3?|node|bun|npx|npm|cd) /;
const MAX = 5;
const LONGEST = 4000;

// One text's commands, in the order they appear.
function commandsIn(text: string): string[] {
  const out: string[] = [];
  const lines = text.split("\n");
  const prose: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/^(\s*)(`{3,}|~{3,})\s*([\w+-]*)/);
    if (!open) {
      prose.push(lines[i]);
      continue;
    }
    const [, indent, fence, lang] = open;
    const close = new RegExp(`^\\s*${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`);
    const end = lines.findIndex((l, j) => j > i && close.test(l));
    if (end < 0) break; // unclosed: what follows is all code, and none of it is a whole command
    if (LANGS.includes(lang.toLowerCase())) {
      const body = lines
        .slice(i + 1, end)
        .map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l).replace(/^\$ /, ""))
        .join("\n")
        .replace(/^\n+|\s+$/g, "");
      if (body) out.push(body);
    }
    i = end;
  }
  // Inline code in the prose between blocks: `like this`, not ``this``.
  for (const m of prose.join("\n").matchAll(/(?<!`)`([^`\n]+)`(?!`)/g)) {
    const code = m[1].trim();
    if (WORDS.test(code)) out.push(code);
  }
  return out;
}

// texts: the reply's text blocks, oldest first.
export function runnableCommands(texts: string[]): string[] {
  const all = texts.flatMap(commandsIn).reverse();
  return [...new Set(all.filter((c) => c.length <= LONGEST))].slice(0, MAX);
}
