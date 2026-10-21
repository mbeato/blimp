// For "New session in…": the folders Claude was used in, and the conversations /resume would offer there.
// Both read Claude's transcript folders, <claude dir>/projects/<folder name>/<sessionId>.jsonl.

import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { shownNames } from "./names";
import { shownNote, shownNotes } from "./notes";
import { isUnread, readSeen } from "./seen";
import { claudeDir, pickTitle, realDir, transcriptTitles } from "./sessions";

function transcripts(folder: string): { file: string; mtime: number }[] {
  let names: string[];
  try {
    names = readdirSync(folder).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    try {
      out.push({ file: join(folder, n), mtime: Math.floor(statSync(join(folder, n)).mtimeMs) });
    } catch {}
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

// Calls pick on each of a transcript's lines from the start until it returns something. Lines can be huge
// (pasted images), so it reads in chunks, 8 MB at most.
function scanLines<T>(file: string, pick: (line: string) => T | undefined | "stop"): T | undefined {
  const fd = openSync(file, "r");
  try {
    let pending = "";
    let pos = 0;
    const buf = Buffer.alloc(64 * 1024);
    const utf8 = new StringDecoder("utf8"); // a chunk can end inside a character
    for (;;) {
      const n = pos < 8 << 20 ? readSync(fd, buf, 0, buf.length, pos) : 0;
      pos += n;
      pending += utf8.write(buf.subarray(0, n));
      const parts = pending.split("\n");
      pending = n ? parts.pop()! : "";
      for (const line of parts) {
        const v = pick(line);
        if (v === "stop") return;
        if (v !== undefined) return v;
      }
      if (!n) return;
    }
  } finally {
    closeSync(fd);
  }
}

// The first "cwd" in a transcript's first lines.
export function firstCwd(file: string, maxLines = 50): string | undefined {
  let lines = 0;
  return scanLines(file, (line) => {
    if (++lines > maxLines) return "stop";
    if (!line.includes('"cwd"')) return;
    try {
      const cwd = JSON.parse(line).cwd;
      if (typeof cwd === "string" && cwd) return cwd;
    } catch {}
  });
}

export function recentFolders(dir = claudeDir()): { dir: string; lastUsed: number }[] {
  const projects = join(dir, "projects");
  let folders: string[];
  try {
    folders = readdirSync(projects);
  } catch {
    return [];
  }
  const seen = new Map<string, number>();
  for (const f of folders) {
    const [newest] = transcripts(join(projects, f));
    if (!newest) continue;
    let cwd: string | undefined;
    try {
      cwd = firstCwd(newest.file);
    } catch {}
    if (!cwd || !existsSync(cwd)) continue;
    seen.set(cwd, Math.max(seen.get(cwd) ?? 0, newest.mtime));
  }
  return [...seen]
    .map(([dir, lastUsed]) => ({ dir, lastUsed }))
    .sort((a, b) => b.lastUsed - a.lastUsed)
    .slice(0, 30);
}

// Claude names a folder's transcript folder after its path, every non-alphanumeric char turned into "-".
export const projectFolderName = (dir: string) => dir.replace(/[^A-Za-z0-9]/g, "-");

// Claude names the folder after the real path, so /home/u/x (with /home/u a symlink) has to be resolved first.
// blimp's name for one (names.ts) comes after your /rename, as in the session list.
export function conversations(cwd: string, dir = claudeDir(), names = shownNames(), seen = readSeen(), notes = shownNotes()) {
  return transcripts(join(dir, "projects", projectFolderName(realDir(cwd))))
    .slice(0, 50)
    .map(({ file, mtime }) => {
      const sessionId = basename(file, ".jsonl");
      const scan = transcriptTitles(file);
      return { sessionId, title: pickTitle(scan, names[sessionId]?.name), updatedAt: mtime, unread: isUnread(seen, sessionId, scan?.replied), note: shownNote(notes[sessionId]) };
    });
}

// The model a conversation started on: its first main-thread request or reply (side tasks run on other
// models). The first, not the last: a GLM conversation resumed in Claude Code by mistake goes on in Claude's
// models after that. undefined when there's no transcript or no model in its first 8 MB.
export function firstModel(file: string): string | undefined {
  try {
    return scanLines(file, (line) => {
      if (!line.includes('"model"')) return;
      try {
        const o = JSON.parse(line);
        const model =
          o.type === "assistant" && !o.isSidechain ? o.message?.model : o.type === "api-request" && o.querySource === "repl_main_thread" ? o.params?.model : undefined;
        if (typeof model === "string" && model && model !== "<synthetic>") return model;
      } catch {}
    });
  } catch {}
}

// Which kind resumes a conversation: Claude Code on GLM if it started on a GLM model (or the model blimp's
// GLM kind is set to), else Claude Code. Without this, Resume on a GLM conversation went on in Claude's models.
export function resumedKind(cwd: string, sessionId: string, dir = claudeDir(), glm: { model?: string; fast?: string } = {}): string {
  const model = firstModel(join(dir, "projects", projectFolderName(realDir(cwd)), `${sessionId}.jsonl`));
  if (!model) return "claude";
  return /^glm/i.test(model) || model === glm.model || model === glm.fast ? "claude-glm" : "claude";
}
