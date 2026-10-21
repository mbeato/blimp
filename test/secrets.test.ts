// Secrets (secrets.ts): the files they're kept in, what's checked before one is saved, and the note
// Claude gets about one. Everything happens in temp folders; nothing else is touched.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpError } from "../src/files";
import { listSecrets, removeSecret, saveSecret, secretFile, shellPath, tellText } from "../src/secrets";

const root = realpathSync(mkdtempSync(join(tmpdir(), "blimp-secret-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const status = (f: () => unknown) => {
  try {
    f();
    return 0;
  } catch (e) {
    return e instanceof HttpError ? e.status : -1;
  }
};

describe("saveSecret", () => {
  const dir = join(root, "a", "secrets");

  test("writes the value as it is, 600 in a 700 folder, with no temp file left; a second save replaces it", () => {
    saveSecret("API_KEY", "sk-one two\nthree", dir);
    expect(readFileSync(join(dir, "API_KEY"), "utf8")).toBe("sk-one two\nthree");
    expect(statSync(join(dir, "API_KEY")).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    saveSecret("API_KEY", "sk-new", dir);
    expect(readFileSync(join(dir, "API_KEY"), "utf8")).toBe("sk-new");
    expect(readdirSync(dir)).toEqual(["API_KEY"]);
  });

  test("a name is a letter, then up to 63 letters, digits or underscores; anything else is 400", () => {
    for (const bad of ["", "1KEY", "_KEY", "MY-KEY", "MY KEY", "../token", "a/b", ".hidden", "K".repeat(65), 42, undefined])
      expect(status(() => saveSecret(bad, "v", dir))).toBe(400);
    expect(status(() => saveSecret("K" + "_".repeat(63), "v", dir))).toBe(0);
  });

  test("a value is 1 to 16384 characters with no NUL; anything else is 400", () => {
    for (const bad of ["", "a\0b", "x".repeat(16385), 42, null, undefined]) expect(status(() => saveSecret("V", bad, dir))).toBe(400);
    expect(status(() => saveSecret("V", "x".repeat(16384), dir))).toBe(0);
  });

  test("a save that fails leaves no temp file with the value behind", () => {
    const d = join(root, "blocked");
    mkdirSync(join(d, "FOO"), { recursive: true }); // a folder where the file would go: the rename fails
    expect(() => saveSecret("FOO", "sk-live-SECRET", d)).toThrow();
    expect(readdirSync(d)).toEqual(["FOO"]);
  });

  test("the folder is made 700 again if it was opened up", () => {
    const d = join(root, "loose");
    mkdirSync(d, { mode: 0o755 });
    saveSecret("K", "v", d);
    expect(statSync(d).mode & 0o777).toBe(0o700);
  });
});

describe("listSecrets", () => {
  test("names and modified times only, by name; temp files and odd names are left out", () => {
    const dir = join(root, "b");
    saveSecret("ZED", "z", dir);
    saveSecret("ALPHA", "a", dir);
    utimesSync(join(dir, "ALPHA"), 1_700_000_000, 1_700_000_000);
    writeFileSync(join(dir, ".tmp-abc"), "half");
    writeFileSync(join(dir, "not-a-name"), "x");
    mkdirSync(join(dir, "FOLDER"));
    const list = listSecrets(dir);
    expect(list.map((s) => s.name)).toEqual(["ALPHA", "ZED"]);
    expect(list[0]).toEqual({ name: "ALPHA", mtime: 1_700_000_000_000 });
    expect(JSON.stringify(list)).not.toContain('"z"');
  });

  test("no folder yet: an empty list", () => {
    expect(listSecrets(join(root, "none"))).toEqual([]);
  });
});

describe("removeSecret", () => {
  test("takes the file out; a missing one is no error; a bad name is 400", () => {
    const dir = join(root, "c");
    saveSecret("GONE", "g", dir);
    removeSecret("GONE", dir);
    expect(readdirSync(dir)).toEqual([]);
    removeSecret("GONE", dir);
    expect(status(() => removeSecret("../token", dir))).toBe(400);
  });

  test("secretFile refuses a bad name, so no route can reach outside the folder", () => {
    expect(status(() => secretFile("..", join(root, "d")))).toBe(400);
    expect(secretFile("OK", join(root, "d"))).toBe(join(root, "d", "OK"));
  });
});

describe("the note Claude gets", () => {
  test("says where the secret is and how to use it without showing it, never the value", () => {
    const text = tellText("GITHUB_TOKEN", "~/.blimp/secrets/GITHUB_TOKEN");
    expect(text).toBe(
      "The secret GITHUB_TOKEN is saved in ~/.blimp/secrets/GITHUB_TOKEN (only you can read it). Read it from that file when you need it, " +
        'for example `export GITHUB_TOKEN="$(cat ~/.blimp/secrets/GITHUB_TOKEN)" && your-command`, in the same command: a variable set in one command is gone in the next. Never print it, echo it, or put it in a file, a commit or a message.',
    );
  });

  test("the path is written from ~ when it's under home, and quoted when it has characters a shell would read", () => {
    expect(shellPath("/home/max/.blimp/secrets/K", "/home/max")).toBe("~/.blimp/secrets/K");
    expect(shellPath("/srv/blimp/secrets/K", "/home/max")).toBe("/srv/blimp/secrets/K");
    expect(shellPath("/home/max/my blimp/secrets/K", "/home/max")).toBe("'/home/max/my blimp/secrets/K'");
    expect(shellPath("/tmp/it's/K", "/home/max")).toBe("'/tmp/it'\\''s/K'");
    expect(shellPath("/home/maxwell/K", "/home/max")).toBe("/home/maxwell/K");
  });
});
