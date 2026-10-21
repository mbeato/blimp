// A folder's pictures as a tab of its own (the files' right-click menu, Show as Gallery), so renders
// can be looked over in one place and keep up as new ones are written.

import { useEffect, useRef, useState } from "react";
import type { DirEntry, DirListing, FileBody } from "../lib/api";
import { errorText } from "../lib/connection";
import { baseName, imageType, joinPath } from "../lib/files";
import { galleryImages, limiter } from "../lib/gallery";
import { relTime } from "../lib/time";

type Load = (path: string) => Promise<FileBody>;

// One picture in the grid. It reads its file only once it scrolls into sight, through run (a few
// at a time), as a blob URL: the token stays out of the page, and SVG scripts never run in <img>.
function Thumb(props: { path: string; entry: DirEntry; load: Load; run: ReturnType<typeof limiter>; onOpen: (path: string) => void }) {
  const box = useRef<HTMLButtonElement>(null);
  const [url, setUrl] = useState("");
  useEffect(() => {
    let live = true;
    let made = "";
    const seen = new IntersectionObserver((items) => {
      if (!items.some((i) => i.isIntersecting)) return;
      seen.disconnect();
      void props
        .run(async () => {
          if (!live) return;
          const b = await props.load(props.path);
          if (!live) return;
          made = URL.createObjectURL(new Blob([b.bytes], { type: imageType(props.path) }));
          setUrl(made);
        })
        .catch(() => {}); // unreadable: the tile keeps its name and no picture
    });
    seen.observe(box.current!);
    return () => {
      live = false;
      seen.disconnect();
      if (made) URL.revokeObjectURL(made);
    };
  }, [props.path]);
  return (
    <button ref={box} className="gallery-tile" title={props.entry.name} onClick={() => props.onOpen(props.path)}>
      <span className="gallery-thumb">{url && <img src={url} alt={props.entry.name} draggable={false} />}</span>
      <span className="gallery-name">{props.entry.name}</span>
      <span className="gallery-time">{relTime(props.entry.mtime)}</span>
    </button>
  );
}

// A folder's images as a grid, newest first, each with its name and how long ago it changed. A
// click opens the image in its own tab. tick: bumped when the folder changes on the server (or
// after a reconnect), which lists it again; a changed image gets a new tile, so it reloads.
export function Gallery(props: { dir: string; tick: number; list: (dir: string) => Promise<DirListing>; load: Load; onOpen: (path: string) => void }) {
  const [images, setImages] = useState<DirEntry[] | null>(null);
  const [error, setError] = useState("");
  const run = useRef(limiter(4)).current;
  useEffect(() => {
    let live = true;
    props.list(props.dir).then(
      (l) => live && (setImages(galleryImages(l.entries)), setError("")),
      (e) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [props.dir, props.tick]);
  const name = baseName(props.dir) || props.dir;
  return (
    <div className="gallery">
      {error && <p className="view-note error">{error}</p>}
      {!error && images?.length === 0 && (
        <div className="empty">
          No images in {name}
          <div className="empty-sub">Pictures saved in this folder show up here as they're added</div>
        </div>
      )}
      {!!images?.length && (
        <div className="gallery-grid">
          {images.map((e) => (
            <Thumb key={`${e.name}\n${e.mtime}`} path={joinPath(props.dir, e.name)} entry={e} load={props.load} run={run} onOpen={props.onOpen} />
          ))}
        </div>
      )}
    </div>
  );
}
