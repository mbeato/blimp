import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import DOMPurify from "dompurify";
import type { FileBody } from "../lib/api";
import { errorText } from "../lib/connection";
import { imageType, parentDir, resolvePath } from "../lib/files";
import { parseMarkdown } from "../lib/markdown";

// Whatever a viewer throws while rendering a file stays in the viewer. Without a boundary React
// unmounts the whole window: the sidebar, every terminal tab and unsaved edits.
export class ViewerBoundary extends Component<{ children: ReactNode }, { error: string }> {
  state = { error: "" };
  static getDerivedStateFromError(e: unknown) {
    return { error: errorText(e) };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="empty">
        Can't show this file
        <div className="empty-sub">{this.state.error}</div>
      </div>
    );
  }
}

// A picture from the file's bytes. SVG goes through <img> too, so its scripts never run.
export function ImageView(props: { name: string; bytes: Uint8Array<ArrayBuffer> }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const u = URL.createObjectURL(new Blob([props.bytes], { type: imageType(props.name) }));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [props.bytes, props.name]);
  return <div className="image-view">{url && <img src={url} alt={props.name} draggable={false} />}</div>;
}

export function PdfView(props: { bytes: Uint8Array }) {
  const box = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const el = box.current!;
    el.replaceChildren();
    setError("");
    let stop: (() => void) | undefined;
    let cancelled = false;
    // A hidden pane has no width yet; the pages scale with CSS either way.
    const width = (el.clientWidth || 832) - 32;
    import("../lib/pdf").then(
      ({ renderPdf }) => {
        if (!cancelled) stop = renderPdf(props.bytes, el, width, (e) => setError(errorText(e)));
      },
      (e) => setError(errorText(e)),
    );
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [props.bytes]);
  return (
    <div className="pdf-view">
      {error && <p className="view-note">Can't show this PDF: {error}</p>}
      <div ref={box} />
    </div>
  );
}

// marked passes raw HTML through, and DOMPurify's defaults keep forms, image maps, <style> and
// inline styles. The preview isn't isolated from the app, so those could restyle or cover the
// window, or navigate it (a form submit, an <area> click), and they go too.
const PURIFY = { FORBID_TAGS: ["style", "form", "map", "area"], FORBID_ATTR: ["style", "form", "formaction"] };

// A relative link or image in a Markdown file, as a server path. null for anything else
// (another scheme, an anchor, an absolute path).
function relativeTarget(mdPath: string, href: string): string | null {
  if (!href || /^([a-z][a-z0-9+.-]*:|#|\/)/i.test(href)) return null;
  let rel = href.split(/[?#]/)[0];
  try {
    rel = decodeURIComponent(rel);
  } catch {}
  return resolvePath(parentDir(mdPath), rel);
}

// A relative image would load from the app's own origin, not the server. Move its src aside so
// the browser never requests it; MarkdownView fetches it from blimpd instead.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName !== "IMG") return;
  const src = node.getAttribute("src") ?? "";
  node.removeAttribute("srcset");
  if (src && !/^([a-z][a-z0-9+.-]*:|\/)/i.test(src)) {
    node.setAttribute("data-blimp-src", src);
    node.removeAttribute("src");
  }
});

// Rendered Markdown. A relative link opens that file here; nothing navigates the app's window.
// Relative images come through load (/fs/file with the token in a header) as blob URLs, so the
// token never lands in the page. marked runs in a worker (see parseMarkdown); while a new version
// of the file renders, the last one stays on screen.
export function MarkdownView(props: {
  path: string;
  text: string;
  onOpen: (path: string) => void;
  load: (path: string) => Promise<FileBody>;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [html, setHtml] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const ac = new AbortController();
    parseMarkdown(props.text, ac.signal)
      .then((raw) => DOMPurify.sanitize(raw, PURIFY))
      .then(
        (h) => {
          setHtml(h);
          setError("");
        },
        (e) => {
          if (ac.signal.aborted) return;
          setHtml("");
          setError(errorText(e));
        },
      );
    return () => ac.abort();
  }, [props.text]);
  useEffect(() => {
    let live = true;
    const urls: string[] = [];
    for (const img of box.current!.querySelectorAll<HTMLImageElement>("img[data-blimp-src]")) {
      const path = relativeTarget(props.path, img.dataset.blimpSrc!);
      if (!path) continue;
      // A missing image stays empty and shows its alt text.
      props.load(path).then(
        (b) => {
          if (!live) return;
          const u = URL.createObjectURL(new Blob([b.bytes], { type: imageType(path) }));
          urls.push(u);
          img.src = u;
        },
        () => {},
      );
    }
    return () => {
      live = false;
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [html, props.path]);
  return (
    <>
      {error && <p className="view-note">Can't show this Markdown: {error}. Edit shows its text.</p>}
      <div
        className="md-view"
        ref={box}
        dangerouslySetInnerHTML={{ __html: html }}
        onClick={(e) => {
          const a = (e.target as HTMLElement).closest("a");
          if (!a) return;
          e.preventDefault();
          const path = relativeTarget(props.path, a.getAttribute("href") ?? "");
          if (path) props.onOpen(path);
        }}
      />
    </>
  );
}
