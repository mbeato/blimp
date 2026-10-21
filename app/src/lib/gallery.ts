// Pure logic behind a folder shown as a gallery: its tab key, which files it shows, and how many
// thumbnails load at once.

import type { DirEntry } from "./api";
import { isImage } from "./files";

// A gallery tab shares `active` with file paths and "tab:" browser tabs. File paths are absolute,
// so they never start with the prefix.
const PREFIX = "gallery:";
export const galleryKey = (dir: string) => PREFIX + dir;
export const galleryDir = (key: string | null) => (key?.startsWith(PREFIX) ? key.slice(PREFIX.length) : null);

// The folder's images, newest first (the render just made is the first one), then by name.
export const galleryImages = (entries: DirEntry[]) =>
  entries.filter((e) => e.kind === "file" && isImage(e.name)).sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));

// Runs at most max tasks at once, the rest in the order they came. A folder of large renders
// would otherwise read them all from the server at the same time.
export function limiter(max: number) {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (running >= max) await new Promise<void>((go) => waiting.push(go));
    else running++;
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running--;
    }
  };
}
