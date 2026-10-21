// Commands Claude hands over in its latest reply, for the apps' Run button (blimpd's runs.ts runs one
// when you click it, never before). A command is a fenced code block marked bash, sh, shell, zsh or
// console (the whole block; if it shows "$ " prompts, only the prompted lines, prompts taken off, as the
// rest is their output), or inline code that starts with a command word (`bun test`) or with "! " (what
// you'd type in Claude Code: any command), one line each. A bare `cd <dir>` isn't one: a run's shell
// starts in Claude's folder again. Newest first, at most 5, each at most 4000 characters.

const LANGS = ["bash", "sh", "shell", "zsh", "console"];
const WORDS = /^(?:bash|sh|zsh|python3?|node|bun|npx|npm|cd) /;
const BARE_CD = /^cd\s+[^;&|]*$/;
const MAX = 5;
const LONGEST = 4000;

// One text's commands, in the order they appear.
function commandsIn(text: string): string[] {
  const out: string[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/^(\s*)(`{3,}|~{3,})\s*([\w+-]*)/);
    if (!open) {
      // Inline code: `like this`, not ``this``.
      for (const m of lines[i].matchAll(/(?<!`)`([^`]+)`(?!`)/g)) {
        const code = m[1].trim();
        const bang = code.match(/^! +(\S.*)$/)?.[1];
        const cmd = bang ?? (WORDS.test(code) ? code : undefined);
        if (cmd && !BARE_CD.test(cmd)) out.push(cmd);
      }
      continue;
    }
    const [, indent, fence, lang] = open;
    const close = new RegExp(`^\\s*${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`);
    const end = lines.findIndex((l, j) => j > i && close.test(l));
    if (end < 0) break; // unclosed: what follows is all code, and none of it is a whole command
    if (LANGS.includes(lang.toLowerCase())) {
      let block = lines.slice(i + 1, end).map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l));
      if (block.some((l) => l.startsWith("$ "))) {
        // Prompts and output: the prompted lines, and the lines one continues onto with a trailing \.
        let more = false;
        block = block.flatMap((l) => {
          const take = l.startsWith("$ ") ? l.slice(2) : more ? l : undefined;
          more = take?.endsWith("\\") ?? false;
          return take === undefined ? [] : [take];
        });
      }
      const body = block.join("\n").replace(/^\n+|\s+$/g, "");
      if (body) out.push(body);
    }
    i = end;
  }
  return out;
}

// texts: the reply's text blocks, oldest first.
export function runnableCommands(texts: string[]): string[] {
  const all = texts.flatMap(commandsIn).reverse();
  return [...new Set(all.filter((c) => c.length <= LONGEST))].slice(0, MAX);
}
