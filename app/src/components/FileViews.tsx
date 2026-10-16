import { useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { errorText } from "../lib/connection";
import { imageType, parentDir, resolvePath } from "../lib/files";

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

// Rendered Markdown. A relative link opens that file here; nothing navigates the app's window.
export function MarkdownView(props: { path: string; text: string; onOpen: (path: string) => void }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(props.text, { async: false }), PURIFY), [props.text]);
  return (
    <div
      className="md-view"
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest("a");
        if (!a) return;
        e.preventDefault();
        const href = a.getAttribute("href") ?? "";
        if (!href || /^([a-z][a-z0-9+.-]*:|#|\/)/i.test(href)) return;
        let rel = href.split(/[?#]/)[0];
        try {
          rel = decodeURIComponent(rel);
        } catch {}
        props.onOpen(resolvePath(parentDir(props.path), rel));
      }}
    />
  );
}
