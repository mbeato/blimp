import { expect, test } from "bun:test";
import type { DirEntry } from "./api";
import { galleryDir, galleryImages, galleryKey, limiter } from "./gallery";

const f = (name: string, mtime: number, kind: DirEntry["kind"] = "file"): DirEntry => ({ name, kind, size: 1, mtime });

test("a gallery's tab key is its folder behind a prefix no file path has", () => {
  expect(galleryKey("/home/u/renders")).toBe("gallery:/home/u/renders");
  expect(galleryDir("gallery:/home/u/renders")).toBe("/home/u/renders");
  expect(galleryDir("/home/u/renders/a.png")).toBeNull();
  expect(galleryDir("tab:ABC")).toBeNull();
  expect(galleryDir(null)).toBeNull();
});

test("the gallery shows a folder's images, newest first, and nothing else", () => {
  const entries = [f("old.png", 100), f("notes.md", 900), f("new.JPG", 300), f("pics", 999, "dir"), f("mid.svg", 200), f("logo.webp", 200), f("page.html", 800)];
  expect(galleryImages(entries).map((e) => e.name)).toEqual(["new.JPG", "logo.webp", "mid.svg", "old.png"]);
});

test("at most four thumbnails load at once; the rest wait their turn in order", async () => {
  const run = limiter(4);
  let now = 0;
  let most = 0;
  const order: number[] = [];
  const done = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      run(async () => {
        now++;
        most = Math.max(most, now);
        order.push(i);
        await new Promise((r) => setTimeout(r, 5));
        now--;
        return i;
      }),
    ),
  );
  expect(done).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  expect(most).toBe(4);
  expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test("a load that fails frees its place for the next one", async () => {
  const run = limiter(1);
  const a = run(() => Promise.reject(new Error("gone")));
  const b = run(async () => "next");
  await expect(a).rejects.toThrow("gone");
  expect(await b).toBe("next");
});
