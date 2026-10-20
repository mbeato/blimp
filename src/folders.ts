// For "New session in…": the folders Claude was used in, and the conversations /resume would offer there.
// Both read Claude's transcript folders, <claude dir>/projects/<folder name>/<sessionId>.jsonl.

import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { claudeDir, realDir, transcriptTitle } from "./sessions";

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

// The first "cwd" in a transcript's first lines. Lines can be huge (pasted images), so read in chunks, 8 MB at most.
export function firstCwd(file: string, maxLines = 50): string | undefined {
  const fd = openSync(file, "r");
  try {
    let pending = "";
    let lines = 0;
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
        if (++lines > maxLines) return;
        if (!line.includes('"cwd"')) continue;
        try {
          const cwd = JSON.parse(line).cwd;
          if (typeof cwd === "string" && cwd) return cwd;
        } catch {}
      }
      if (!n) return;
    }
  } finally {
    closeSync(fd);
  }
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
export function conversations(cwd: string, dir = claudeDir()) {
  return transcripts(join(dir, "projects", projectFolderName(realDir(cwd))))
    .slice(0, 50)
    .map(({ file, mtime }) => ({ sessionId: basename(file, ".jsonl"), title: transcriptTitle(file), updatedAt: mtime }));
}

// The model of a conversation's last main reply (side tasks run on other models), from the last 4 MB of
// its transcript. undefined when there's no transcript or no reply in that part.
export function lastModel(file: string): string | undefined {
  let text: string;
  try {
    const fd = openSync(file, "r");
    try {
      const size = fstatSync(fd).size;
      const start = Math.max(0, size - (4 << 20));
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      text = buf.toString("utf8");
      if (start) text = text.slice(text.indexOf("\n") + 1); // the first line may be cut
    } finally {
      closeSync(fd);
    }
  } catch {
    return;
  }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"assistant"')) continue;
    try {
      const o = JSON.parse(lines[i]);
      if (o.type === "assistant" && !o.isSidechain && typeof o.message?.model === "string") return o.message.model;
    } catch {}
  }
}

// Which kind resumes a conversation: Claude Code on GLM if it last ran on a GLM model (or the model blimp's
// GLM kind is set to), else Claude Code. Without this, Resume on a GLM conversation went on in Claude's models.
export function resumedKind(cwd: string, sessionId: string, dir = claudeDir(), glm: { model?: string; fast?: string } = {}): string {
  const model = lastModel(join(dir, "projects", projectFolderName(realDir(cwd)), `${sessionId}.jsonl`));
  if (!model) return "claude";
  return /^glm/i.test(model) || model === glm.model || model === glm.fast ? "claude-glm" : "claude";
}
