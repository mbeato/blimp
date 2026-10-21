// Secrets for Claude (docs/DESIGN.md, "Secrets"): an API key or a password you give a session without
// pasting it into the chat, where it would stay in the transcript. Each one is a file in
// <socket dir>/secrets (~/.blimp/secrets/<NAME>), 600 in a 700 folder, written once and never sent
// back by any route: GET /secrets lists names and times only, and the fs routes refuse the folder
// (files.ts secretPaths). Telling a session about one types a note saying where the file is and how to
// read it into a variable. The value itself is never typed, logged, put in argv or in the session list.

import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HttpError } from "./files";
import { blimpDir } from "./sessions";
import { Asking, findSession, typeInto } from "./typing";

export const secretsDir = () => join(blimpDir(), "secrets");

// A name that works as a shell variable's, so the note's `export NAME=…` is right as it stands.
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
export const MAX_VALUE = 16384;

// The file for a name. A name that isn't one is refused here, so no path can leave the folder.
export function secretFile(name: unknown, dir = secretsDir()): string {
  if (typeof name !== "string" || !NAME.test(name))
    throw new HttpError(400, "a secret's name is a letter, then up to 63 letters, digits or underscores");
  return join(dir, name);
}

// Through a temp file (600, never there before) and a rename, so it's never half written; the temp
// file is taken away if either fails.
export function saveSecret(name: unknown, value: unknown, dir = secretsDir()) {
  const file = secretFile(name, dir);
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_VALUE || value.includes("\0"))
    throw new HttpError(400, `a secret is 1 to ${MAX_VALUE} characters`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const tmp = join(dir, `.tmp-${randomBytes(6).toString("hex")}`);
  try {
    writeFileSync(tmp, value, { mode: 0o600, flag: "wx" });
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true }); // a failed save leaves no copy of the value behind
    throw e;
  }
}

export const removeSecret = (name: unknown, dir = secretsDir()) => rmSync(secretFile(name, dir), { force: true });

// Names and when each was last saved (ms), by name. Never what's in them.
export function listSecrets(dir = secretsDir()): { name: string; mtime: number }[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const list: { name: string; mtime: number }[] = [];
  for (const name of names.filter((n) => NAME.test(n)).sort()) {
    try {
      const st = statSync(join(dir, name));
      if (st.isFile()) list.push({ name, mtime: Math.floor(st.mtimeMs) });
    } catch {} // removed in between
  }
  return list;
}

// The path as Claude should type it in a shell: from ~ under home (shorter, and the same on every
// box), in single quotes when it has anything a shell would read.
export function shellPath(file: string, home = homedir()): string {
  const p = file.startsWith(home + "/") ? "~" + file.slice(home.length) : file;
  if (/^[A-Za-z0-9_./~-]+$/.test(p)) return p;
  return `'${file.replace(/'/g, `'\\''`)}'`;
}

export const tellText = (name: string, path: string) =>
  `The secret ${name} is saved in ${path} (only you can read it). Read it from that file when you need it, ` +
  `for example \`export ${name}="$(cat ${path})" && your-command\`, in the same command: a variable set in one command is gone in the next. ` +
  `Never print it, echo it, or put it in a file, a commit or a message.`;

// Types the note into a session's Claude, with Enter. 404: no such secret or session; 400: Claude
// isn't running there (the note would go to a shell); 409: Claude is asking something.
export async function tellSecret(name: unknown, session: unknown) {
  const file = secretFile(name);
  try {
    if (!statSync(file).isFile()) throw new Error();
  } catch {
    throw new HttpError(404, `no secret named ${name}`);
  }
  if (typeof session !== "string") throw new HttpError(400, "session is required");
  const s = await findSession(session);
  if (!s) throw new HttpError(404, `no session named ${session}`);
  if (!s.sessionId) throw new HttpError(400, `Claude isn't running in ${session}`);
  try {
    await typeInto(session, tellText(name as string, shellPath(file)), { enter: true });
  } catch (e) {
    if (e instanceof Asking) throw new HttpError(409, e.message);
    if ((e as Error).message === "the session ended") throw new HttpError(404, `no session named ${session}`);
    throw e;
  }
}
