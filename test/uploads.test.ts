// Files the apps hand to a session (src/uploads.ts): their names, which paths count as one, and the 30-day clean-up.
// What saves one and types its path is in server.test.ts (POST /uploads, the chat socket's files).

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realHome } from "../src/files";
import { cleanUploads, isUpload, KEEP_MS, plainName, uploadsDir } from "../src/uploads";

const tmp = mkdtempSync(join(tmpdir(), "blimp-uploads-"));
const mine = `blimptest-uploads-${process.pid}`;
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(join(uploadsDir(), `${mine}.png`), { force: true });
});

test("the uploads folder is ~/.blimp/uploads, where the Mac's drop puts its files", () => {
  expect(uploadsDir()).toBe(join(realHome(), ".blimp", "uploads"));
  expect(uploadsDir("/home/x")).toBe("/home/x/.blimp/uploads");
});

test("a name becomes one plain word, with no folder", () => {
  expect(plainName("IMG_0042.jpg")).toBe("IMG_0042.jpg");
  expect(plainName("Photo 2026-11-15 at 10.41.07\u202fPM (1).jpeg")).toBe("Photo-2026-11-15-at-10.41.07-PM-1-.jpeg");
  expect(plainName("../../.ssh/authorized_keys")).toBe("ssh-authorized_keys");
  expect(plainName("a/b\\c.png")).toBe("a-b-c.png");
  expect(plainName("'; rm -rf ~ #.png")).toBe("rm--rf-.png");
  expect(plainName("...")).toBe("file");
  expect(plainName("")).toBe("file");
  // A long name keeps its ending.
  expect(plainName("x".repeat(300) + ".mp4")).toBe("x".repeat(116) + ".mp4");
});

test("only a file in the uploads folder itself is one", () => {
  mkdirSync(uploadsDir(), { recursive: true });
  const real = join(uploadsDir(), `${mine}.png`);
  writeFileSync(real, "x");
  expect(isUpload(real)).toBe(true);
  expect(isUpload(join(uploadsDir(), `${mine}-missing.png`))).toBe(false);
  expect(isUpload(uploadsDir())).toBe(false);
  expect(isUpload(join(uploadsDir(), "..", "token"))).toBe(false);
  expect(isUpload(`${uploadsDir()}/../uploads/${mine}.png`)).toBe(false);
  expect(isUpload(`${mine}.png`)).toBe(false);
  expect(isUpload("/etc/hostname")).toBe(false);
  for (const bad of [undefined, null, 3, {}, [real]]) expect(isUpload(bad)).toBe(false);
});

test("files there over 30 days go; newer ones, folders and links stay", () => {
  const dir = join(tmp, "uploads");
  mkdirSync(join(dir, "folder"), { recursive: true });
  const now = Date.now();
  const past = (now - KEEP_MS - 60_000) / 1000;
  for (const n of ["old.mp4", "old.jpg", "new.jpg"]) writeFileSync(join(dir, n), "x");
  for (const n of ["old.mp4", "old.jpg", "folder"]) utimesSync(join(dir, n), past, past);
  symlinkSync(join(dir, "new.jpg"), join(dir, "link.jpg"));
  cleanUploads(now, dir);
  expect(readdirSync(dir).sort()).toEqual(["folder", "link.jpg", "new.jpg"]);
  // No folder yet: nothing to do.
  cleanUploads(now, join(tmp, "none"));
});
