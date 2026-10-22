// Which session is on what: the checkout and branch each Claude session works in, and that branch's pull
// requests.
// The branch and the folder come from the transcript (activity.ts). The checkout's root comes from git,
// and the pull requests from gh. Both run in the background, never while the session list is built
// (every second): the list shows what was last found, at most 60 s (root) or 5 minutes (PRs) old.

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { Git } from "./activity";
import { loginShell } from "./sessions";

export type PR = { number: number; title: string; state: string; url: string };
// worktree: the checkout is a linked worktree (git worktree add), not the repo's main folder.
export type Work = { branch?: string; root?: string; worktree?: boolean; prs?: PR[] };

const MAIN = ["main", "master"];

// The checkout a folder is in: its top folder, and whether it's a linked worktree (its git dir isn't the
// repo's common one). Not a repo, or gone: none. core.fsmonitor=false: a repo's config can't make this
// run a program (files.ts does the same). No --path-format=absolute: git before 2.31 prints an option it
// doesn't know as a line. --show-toplevel is absolute already; the git dirs may be relative to cwd.
export async function readRoot(cwd: string, git = "git"): Promise<{ root: string; worktree: boolean } | undefined> {
  try {
    const p = Bun.spawn([git, "-c", "core.fsmonitor=false", "rev-parse", "--show-toplevel", "--git-dir", "--git-common-dir"], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = await new Response(p.stdout).text();
    if ((await p.exited) !== 0) return;
    const [root, dir, common] = out.split("\n");
    if (!root?.startsWith("/") || !dir || !common) return;
    return { root, worktree: realpathSync(resolve(cwd, dir)) !== realpathSync(resolve(cwd, common)) };
  } catch {
    return; // no git, or the folder is gone
  }
}

// A folder's checkout, as last found: read again in the background at most every 60 s.
const roots = new Map<string, { read: number; found?: { root: string; worktree: boolean } }>();
export function rootOf(cwd: string, now = Date.now()) {
  const r = roots.get(cwd);
  if (!r || now - r.read >= 60_000) {
    const next = { read: now, found: r?.found };
    if (roots.size > 500) roots.clear();
    roots.set(cwd, next);
    readRoot(cwd).then((found) => roots.get(cwd) === next && (next.found = found), () => {});
  }
  return roots.get(cwd)!.found;
}

// gh's JSON, after the marker the script prints (a login profile may print things first). Only entries
// shaped like a pull request with a web link: the Mac opens that link.
export function parsePrs(out: string): PR[] | undefined {
  const at = out.indexOf("blimp-prs:");
  if (at < 0) return;
  let list: unknown;
  try {
    list = JSON.parse(out.slice(at + "blimp-prs:".length).trim());
  } catch {
    return;
  }
  if (!Array.isArray(list)) return;
  return list
    .filter((p: any) => typeof p?.number === "number" && typeof p.title === "string" && typeof p.state === "string" && typeof p.url === "string" && /^https?:\/\//.test(p.url))
    .map((p: any) => ({ number: p.number, title: p.title.slice(0, 200), state: p.state, url: p.url }));
}

// The branch's pull requests (newest 3, any state), from gh in the checkout through the login shell, so it
// finds gh and its sign-in as a terminal does. Arguments go as "$@", never into the script. 10 s at most:
// then none, without waiting for the output to close (a child of the shell may keep it open after the
// kill, and the next lookups wait on this one).
export async function ghPrs(root: string, branch: string, ms = 10_000): Promise<PR[] | undefined> {
  const script = 'cd "$1" && printf "\\nblimp-prs:" && exec gh pr list --head "$2" --state all --limit 3 --json number,title,state,url';
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const p = Bun.spawn([loginShell(), "-l", "-i", "-c", script, "blimp", root, branch], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const late = new Promise<undefined>((r) => (timer = setTimeout(() => (p.kill(), r(undefined)), ms)));
    try {
      const out = await Promise.race([new Response(p.stdout).text(), late]);
      if (out === undefined || (await p.exited) !== 0) return;
      return parsePrs(out);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return;
  }
}

// A checkout and branch's pull requests, as last found: looked up in the background at most every
// 5 minutes, one gh at a time. gh missing or failing keeps what was found before, if anything.
const prs = new Map<string, { read: number; found?: PR[] }>();
let looking: Promise<unknown> = Promise.resolve();
export function prsOf(root: string, branch: string, now = Date.now(), look = ghPrs): PR[] | undefined {
  const key = `${root}\0${branch}`;
  const r = prs.get(key);
  if (!r || now - r.read >= 5 * 60_000) {
    const next = { read: now, found: r?.found };
    if (prs.size > 500) prs.clear();
    prs.set(key, next);
    looking = looking.then(() => look(root, branch)).then((found) => found && prs.get(key) === next && (next.found = found), () => {});
  }
  return prs.get(key)!.found;
}

// The session list with each Claude session's work added, when there's any (sessions.ts). Rows without
// a git folder (shells, a Claude session before its first line) are left as they are.
// PRs are not looked up for main or master: a PR's head is its own branch, and `--head main` lists forks'.
export function withWork<T extends { git?: Git }>(rows: T[], now = Date.now(), prsFor = prsOf): (T & { work?: Work })[] {
  return rows.map((s) => {
    if (!s.git) return s;
    const o = { branch: s.git.branch, ...rootOf(s.git.cwd, now) };
    const found = o.root && o.branch && !MAIN.includes(o.branch) ? prsFor(o.root, o.branch, now) : undefined;
    const work: Work = {
      ...(o.branch && { branch: o.branch }),
      ...(o.root && { root: o.root }),
      ...(o.worktree && { worktree: true }),
      ...(found?.length && { prs: found }),
    };
    return Object.keys(work).length ? { ...s, work } : s;
  });
}

// The same for `blimpd sessions --json`, which lists once and exits: it waits for each folder's checkout,
// so the list has it, and looks up no pull requests (gh is slow, and the process would wait for it after
// printing). GET /sessions has them.
export async function withWorkNow<T extends { git?: Git }>(rows: T[], now = Date.now()) {
  const cwds = new Set(rows.flatMap((s) => (s.git ? [s.git.cwd] : [])));
  await Promise.all([...cwds].map(async (cwd) => roots.set(cwd, { read: now, found: await readRoot(cwd) })));
  return withWork(rows, now, () => undefined);
}
