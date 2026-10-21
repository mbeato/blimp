import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type OnWhat, type PR, clashes, ghPrs, parsePrs, prsOf, readRoot, withWork, withWorkNow } from "../src/work";

const NOW = 1_800_000_000_000;
const H = 3600_000;
const on = (name: string, extra: Partial<OnWhat> = {}): OnWhat => ({ name, files: [], ...extra });
const edited = (...paths: string[]) => paths.map((path, i) => ({ path, at: NOW - i * 60_000 }));

describe("clashes", () => {
  test("two sessions on the same branch of the same checkout clash, both ways", () => {
    const c = clashes([on("a", { root: "/r", branch: "feat" }), on("b", { root: "/r", branch: "feat" }), on("c", { root: "/r", branch: "other" })], NOW);
    expect(c.get("a")).toEqual([{ session: "b", reason: "branch" }]);
    expect(c.get("b")).toEqual([{ session: "a", reason: "branch" }]);
    expect(c.has("c")).toBe(false);
  });

  test("the same branch name in another repo, or with no branch known, is no clash", () => {
    expect(clashes([on("a", { root: "/r", branch: "feat" }), on("b", { root: "/s", branch: "feat" })], NOW).size).toBe(0);
    expect(clashes([on("a", { root: "/r" }), on("b", { root: "/r" })], NOW).size).toBe(0);
    expect(clashes([on("a", { branch: "feat" }), on("b", { branch: "feat" })], NOW).size).toBe(0);
  });

  test("two sessions on main or master clash only once one of them has edited files lately", () => {
    for (const branch of ["main", "master"]) {
      expect(clashes([on("a", { root: "/r", branch }), on("b", { root: "/r", branch })], NOW).size).toBe(0);
      const old = [{ path: "/r/x.ts", at: NOW - 7 * H }];
      expect(clashes([on("a", { root: "/r", branch, files: old }), on("b", { root: "/r", branch })], NOW).size).toBe(0);
      const c = clashes([on("a", { root: "/r", branch, files: edited("/r/x.ts") }), on("b", { root: "/r", branch })], NOW);
      expect(c.get("b")).toEqual([{ session: "a", reason: "branch" }]);
      // A scratch or notes file outside the checkout isn't editing it.
      const outside = [{ path: "/tmp/scratch/msg.txt", at: NOW }];
      expect(clashes([on("a", { root: "/r", branch, files: outside }), on("b", { root: "/r", branch })], NOW).size).toBe(0);
    }
  });

  test("two sessions that edited the same files in the last 6 hours clash, the files relative to each one's checkout", () => {
    const a = on("a", { root: "/r", branch: "x", files: edited("/r/src/a.ts", "/r/b.ts", "/r/only-a.ts") });
    const b = on("b", { root: "/r/wt", branch: "y", files: [...edited("/r/b.ts", "/r/src/a.ts"), { path: "/r/old.ts", at: NOW - 7 * H }] });
    const c = clashes([a, b], NOW);
    expect(c.get("a")).toEqual([{ session: "b", reason: "files", files: ["src/a.ts", "b.ts"] }]);
    // Outside its own checkout, a path stays as it is. Each lists them as it edited them, newest first.
    expect(c.get("b")).toEqual([{ session: "a", reason: "files", files: ["/r/b.ts", "/r/src/a.ts"] }]);
  });

  test("a file one of them edited more than 6 hours ago is no clash", () => {
    const a = on("a", { files: [{ path: "/r/x.ts", at: NOW - 7 * H }] });
    expect(clashes([a, on("b", { files: edited("/r/x.ts") })], NOW).size).toBe(0);
  });

  test("at most 5 shared files are listed, newest first", () => {
    const paths = ["/r/1", "/r/2", "/r/3", "/r/4", "/r/5", "/r/6", "/r/7"];
    const c = clashes([on("a", { root: "/r", files: edited(...paths) }), on("b", { files: edited(...paths) })], NOW);
    expect(c.get("a")).toEqual([{ session: "b", reason: "files", files: ["1", "2", "3", "4", "5"] }]);
  });

  test("the same branch and the same files with one session: both reasons", () => {
    const c = clashes([on("a", { root: "/r", branch: "f", files: edited("/r/x") }), on("b", { root: "/r", branch: "f", files: edited("/r/x") })], NOW);
    expect(c.get("a")).toEqual([{ session: "b", reason: "branch" }, { session: "b", reason: "files", files: ["x"] }]);
  });
});

describe("pull requests", () => {
  const pr = { number: 12, title: "Fix the list", state: "OPEN", url: "https://github.com/o/r/pull/12" };

  test("gh's list is read after the marker, whatever a profile printed before it", () => {
    expect(parsePrs(`Welcome!\nblimp-prs:${JSON.stringify([pr])}\n`)).toEqual([pr]);
    expect(parsePrs(`blimp-prs:${JSON.stringify([pr], null, 2)}\n`)).toEqual([pr]);
    expect(parsePrs("blimp-prs:[]\n")).toEqual([]);
  });

  test("no marker, bad JSON, or entries that aren't pull requests give none", () => {
    expect(parsePrs(JSON.stringify([pr]))).toBeUndefined();
    expect(parsePrs("blimp-prs:not json")).toBeUndefined();
    // A link the Mac opens must be a web link.
    expect(parsePrs(`blimp-prs:${JSON.stringify([{ ...pr, url: "file:///etc/passwd" }, { number: "1" }, pr])}`)).toEqual([pr]);
  });

  test("looked up in the background, at most every 5 minutes per checkout and branch, one gh at a time", async () => {
    const asked: string[] = [];
    let running = 0;
    let most = 0;
    const look = async (root: string, branch: string): Promise<PR[] | undefined> => {
      asked.push(`${root} ${branch}`);
      most = Math.max(most, ++running);
      await Bun.sleep(5);
      running--;
      return branch === "fails" ? undefined : [{ ...pr, title: `${root} ${branch} ${asked.length}` }];
    };
    const t = NOW + 10 * H; // a time no other test used
    expect(prsOf("/r", "a", t, look)).toBeUndefined(); // not known yet: never waited for
    expect(prsOf("/r", "b", t, look)).toBeUndefined();
    await Bun.sleep(30);
    expect(most).toBe(1);
    expect(prsOf("/r", "a", t + 1000, look)).toEqual([{ ...pr, title: "/r a 1" }]);
    expect(asked).toEqual(["/r a", "/r b"]);
    prsOf("/r", "a", t + 5 * 60_000, look);
    await Bun.sleep(20);
    expect(prsOf("/r", "a", t + 5 * 60_000 + 1, look)).toEqual([{ ...pr, title: "/r a 3" }]);
    // gh failing (or missing) with nothing known before: none.
    prsOf("/r", "fails", t, look);
    await Bun.sleep(20);
    expect(prsOf("/r", "fails", t + 1, look)).toBeUndefined();
  });

  test("a gh whose output never closes gives none after the time limit, not a lookup that never ends", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "blimp-gh-"));
    const sh = join(tmp, "sh");
    // A child of the shell keeps its output open after the shell is killed.
    writeFileSync(sh, "#!/bin/sh\nsleep 5 &\nexec sleep 5\n");
    chmodSync(sh, 0o755);
    const shell = process.env.SHELL;
    process.env.SHELL = sh;
    try {
      const at = Date.now();
      expect(await ghPrs(tmp, "x", 200)).toBeUndefined();
      expect(Date.now() - at).toBeLessThan(2000);
    } finally {
      process.env.SHELL = shell;
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 8000);
});

describe("a session's checkout", () => {
  const git = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  };

  test("the root of the repo or worktree a folder is in, and whether it's a linked worktree", async () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), "blimp-work-")));
    const repo = join(tmp, "repo");
    mkdirSync(join(repo, "src"), { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "a");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "a");
    git(repo, "worktree", "add", "-q", join(tmp, "wt"), "-b", "feat");
    expect(await readRoot(join(repo, "src"))).toEqual({ root: repo, worktree: false });
    expect(await readRoot(join(tmp, "wt"))).toEqual({ root: join(tmp, "wt"), worktree: true });
    expect(await readRoot(tmp)).toBeUndefined(); // not a repo
    expect(await readRoot(join(tmp, "gone"))).toBeUndefined();
    rmSync(tmp, { recursive: true, force: true });
  });

  test("git before 2.31, which prints an option it doesn't know (--path-format) as a line, still gives the real root", async () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), "blimp-work-")));
    const repo = join(tmp, "repo");
    mkdirSync(join(repo, "src"), { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    const bin = join(tmp, "bin");
    mkdirSync(bin);
    const real = Bun.which("git")!;
    writeFileSync(
      join(bin, "git"),
      `#!/bin/bash\na=(); for x in "$@"; do if [[ $x == --path-format=* ]]; then echo "$x"; else a+=("$x"); fi; done; exec ${real} "\${a[@]}"\n`,
    );
    chmodSync(join(bin, "git"), 0o755);
    expect(await readRoot(join(repo, "src"), join(bin, "git"))).toEqual({ root: repo, worktree: false });
    expect(await readRoot(repo, join(bin, "git"))).toEqual({ root: repo, worktree: false });
    rmSync(tmp, { recursive: true, force: true });
  });
});

describe("withWork", () => {
  test("only sessions with a git folder get work, and only what's known; the files stay on the server", () => {
    const rows = [
      { name: "a", transcript: "/t/a", git: { cwd: "/nowhere-a", branch: "feat" } },
      { name: "b", transcript: "/t/b", git: { cwd: "/nowhere-b", branch: "feat" } },
      { name: "c", transcript: "/t/c" },
      { name: "d" },
    ];
    const files: Record<string, { path: string; at: number }[]> = { "/t/a": edited("/x/y.ts"), "/t/b": edited("/x/y.ts") };
    const out = withWork(rows, NOW, (t) => files[t] ?? []);
    expect(out[0]).toEqual({ ...rows[0], work: { branch: "feat", clash: [{ session: "b", reason: "files", files: ["/x/y.ts"] }] } });
    expect(out[1].work).toEqual({ branch: "feat", clash: [{ session: "a", reason: "files", files: ["/x/y.ts"] }] });
    expect(out[2]).toEqual(rows[2]);
    expect(out[3]).toEqual(rows[3]);
    expect(JSON.stringify(out)).not.toContain('"files":[{');
  });

  test("withWorkNow (blimpd sessions --json, run once) waits for the checkouts, so the first list has them, and looks up no PRs", async () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), "blimp-work-")));
    const repo = join(tmp, "now-repo");
    mkdirSync(repo);
    Bun.spawnSync(["git", "init", "-q", "-b", "feat"], { cwd: repo });
    const rows = [
      { name: "a", transcript: "/t/a", git: { cwd: repo, branch: "feat" } },
      { name: "b", transcript: "/t/b", git: { cwd: repo, branch: "feat" } },
    ];
    const out = await withWorkNow(rows, NOW, () => []);
    expect(out[0].work).toEqual({ branch: "feat", root: repo, clash: [{ session: "b", reason: "branch" }] });
    expect(out[1].work).toEqual({ branch: "feat", root: repo, clash: [{ session: "a", reason: "branch" }] });
    rmSync(tmp, { recursive: true, force: true });
  });
});
