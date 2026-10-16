import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guard, HttpError, listDir, listFiles, writeFile } from "../src/files";

// A fake home with a sibling folder outside it.
const root = realpathSync(mkdtempSync(join(tmpdir(), "blimp-files-")));
const home = join(root, "home");
const outside = join(root, "outside");
mkdirSync(join(home, "proj", "sub"), { recursive: true });
mkdirSync(outside);
writeFileSync(join(home, "proj", "a.txt"), "a");
writeFileSync(join(outside, "secret"), "s");
symlinkSync(outside, join(home, "escape")); // folder link out of home
symlinkSync(join(outside, "secret"), join(home, "secret-link")); // file link out of home
symlinkSync(join(home, "proj"), join(home, "proj-link")); // link that stays inside
symlinkSync(join(outside, "nope"), join(home, "dangling")); // broken link pointing outside
afterAll(() => rmSync(root, { recursive: true, force: true }));

const status = (f: () => unknown) => {
  try {
    f();
    return 0;
  } catch (e) {
    return e instanceof HttpError ? e.status : -1;
  }
};

describe("guard", () => {
  test("home and paths inside it pass, as real paths", () => {
    expect(guard(home, home)).toBe(home);
    expect(guard(join(home, "proj", "a.txt"), home)).toBe(join(home, "proj", "a.txt"));
    expect(guard(join(home, "proj-link", "a.txt"), home)).toBe(join(home, "proj", "a.txt"));
  });

  test("a new file is fine when its folder is inside", () => {
    expect(guard(join(home, "proj", "new.txt"), home)).toBe(join(home, "proj", "new.txt"));
  });

  test("outside home, .. and relative paths are refused", () => {
    expect(status(() => guard(outside, home))).toBe(403);
    expect(status(() => guard(join(home, "..", "outside", "secret"), home))).toBe(403);
    expect(status(() => guard(root, home))).toBe(403);
    expect(status(() => guard(home + "x", home))).toBe(403); // a sibling that shares the prefix
    expect(status(() => guard("proj/a.txt", home))).toBe(400);
    expect(status(() => guard(null, home))).toBe(400);
  });

  test("symlinks can't lead out of home", () => {
    expect(status(() => guard(join(home, "escape"), home))).toBe(403);
    expect(status(() => guard(join(home, "escape", "secret"), home))).toBe(403);
    expect(status(() => guard(join(home, "escape", "new-file"), home))).toBe(403); // parent resolves outside
    expect(status(() => guard(join(home, "secret-link"), home))).toBe(403);
    expect(status(() => guard(join(home, "dangling"), home))).toBe(403); // writing would go through the link
  });

  test("a missing parent folder is refused", () => {
    expect(status(() => guard(join(home, "no", "such", "file"), home))).toBe(403);
  });
});

test("listDir: folders first, then by name; links as their target; broken links skipped", () => {
  const { entries } = listDir(home);
  expect(entries.map((e) => [e.name, e.kind])).toEqual([
    ["escape", "dir"],
    ["proj", "dir"],
    ["proj-link", "dir"],
    ["secret-link", "file"],
  ]);
  expect(entries[3].size).toBe(1);
  expect(Number.isInteger(entries[3].mtime)).toBe(true);
});

describe("writeFile", () => {
  const f = join(home, "proj", "w.txt");

  test("conflict when the file changed since baseMtime, overwrite without it", () => {
    writeFileSync(f, "one");
    chmodSync(f, 0o640);
    const base = Math.floor(statSync(f).mtimeMs);
    const { mtime } = writeFile(f, new TextEncoder().encode("two"), base);
    expect(readFileSync(f, "utf8")).toBe("two");
    expect(statSync(f).mode & 0o777).toBe(0o640); // mode kept through the temp file + rename

    // Someone else (Claude) writes it after the app read it.
    writeFileSync(f, "claude");
    utimesSync(f, new Date(), new Date(mtime + 5000));
    let err: any;
    try {
      writeFile(f, new TextEncoder().encode("mine"), mtime);
    } catch (e) {
      err = e;
    }
    expect(err.status).toBe(409);
    expect(err.message).toBe("changed on the server");
    expect(err.extra.mtime).toBe(mtime + 5000);
    expect(readFileSync(f, "utf8")).toBe("claude");

    writeFile(f, new TextEncoder().encode("mine")); // "keep mine"
    expect(readFileSync(f, "utf8")).toBe("mine");
  });

  test("creates a new file", () => {
    writeFile(join(home, "proj", "brand-new.txt"), new TextEncoder().encode("x"));
    expect(readFileSync(join(home, "proj", "brand-new.txt"), "utf8")).toBe("x");
  });

  test("a new file gets the umask's mode, like any editor would make it", () => {
    const old = process.umask(0o077);
    try {
      writeFile(join(home, "proj", "private.env"), new TextEncoder().encode("x"));
    } finally {
      process.umask(old);
    }
    expect(statSync(join(home, "proj", "private.env")).mode & 0o777).toBe(0o600);
  });
});

describe("listFiles", () => {
  test("walks outside git, skipping .git, node_modules and dot-folders", async () => {
    const r = join(home, "walk");
    for (const d of ["src", "node_modules/x", ".cache", ".git"]) mkdirSync(join(r, d), { recursive: true });
    for (const f of ["src/a.ts", "node_modules/x/i.js", ".cache/c", ".git/HEAD", ".env", "README.md"]) writeFileSync(join(r, f), "");
    expect(await listFiles(r)).toEqual({ files: [".env", "README.md", "src/a.ts"], truncated: false });
  });

  test("inside a git repo, uses git's list (tracked + untracked, not ignored)", async () => {
    const r = join(home, "repo");
    mkdirSync(join(r, "dist"), { recursive: true });
    writeFileSync(join(r, ".gitignore"), "dist/\n");
    writeFileSync(join(r, "dist", "out.js"), "");
    writeFileSync(join(r, "main.ts"), "");
    Bun.spawnSync(["git", "init", "-q"], { cwd: r });
    expect((await listFiles(r)).files.sort()).toEqual([".gitignore", "main.ts"]);
  });
});
