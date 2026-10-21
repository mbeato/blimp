import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import DOMPurify from "dompurify";
import type { FileBody } from "../lib/api";
import { errorText } from "../lib/connection";
import { baseName, decodeText, imageType, parentDir, resolvePath } from "../lib/files";
import { limiter } from "../lib/gallery";
import { openWebLink } from "../lib/links";
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

// Rendered Markdown. A relative link opens that file here, an http or https link opens in the
// system browser, and nothing navigates the app's window.
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
          const href = a.getAttribute("href") ?? "";
          const path = relativeTarget(props.path, href);
          if (path) props.onOpen(path);
          else openWebLink(href);
        }}
      />
    </>
  );
}

const dataUrl = (bytes: Uint8Array<ArrayBuffer>, type: string) =>
  new Promise<string>((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(r.result as string);
    r.onerror = () => fail(r.error);
    r.readAsDataURL(new Blob([bytes], { type }));
  });

// CSS url(...): quoted or not.
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]*))\s*\)/gi;

// CSS with its relative url()s (resolved against from's folder) as data: URLs, through inline.
// A url() to a part of the page (#id) stays, as does a data: URL; any other would load from the
// web or the app's own origin, so it points nowhere. @import is taken out (its sheet would load
// the same way), and so is anything that would end the <style> the CSS goes in.
async function inlineCss(css: string, from: string, inline: (path: string) => Promise<string | null>): Promise<string> {
  css = css.replace(/@import[^;]*;?/gi, "").replace(/<\/(style)/gi, "<\\/$1");
  const urls = await Promise.all(
    [...css.matchAll(CSS_URL)].map(async (m) => {
      const u = m[1] ?? m[2] ?? m[3];
      if (/^(data:|#)/i.test(u)) return m[0];
      const p = relativeTarget(from, u);
      return `url("${(p && (await inline(p))) || "about:invalid"}")`;
    }),
  );
  let i = 0;
  return css.replace(CSS_URL, () => urls[i++]);
}

// The page an HTML file shows, ready for a sandboxed frame. Relative images (<img>, and url() in its
// CSS) become data: URLs and relative stylesheets <style>, all read through load (/fs/file): the
// frame has no origin to load them from, and the token stays out of the page. Each file is read
// once, 4 at a time. Other things that would load (from the web, or from the app's own origin,
// which is what a relative URL means in the frame) are left out: other <link>s, scripts, frames,
// <base>, <meta http-equiv>, media sources. So are links that would take the frame elsewhere: a
// link to a part of the page (#id) still scrolls to it (about:srcdoc#id is the frame's own page).
async function framePage(path: string, text: string, load: (path: string) => Promise<FileBody>): Promise<string> {
  const doc = new DOMParser().parseFromString(text, "text/html");
  doc.querySelectorAll("script, base, meta[http-equiv], iframe, frame, object, embed").forEach((n) => n.remove());
  for (const n of doc.querySelectorAll("source, track, video, audio, input, [background]")) for (const a of ["src", "srcset", "poster", "background"]) n.removeAttribute(a);
  for (const n of doc.querySelectorAll("image, use, feImage"))
    for (const a of ["href", "xlink:href"]) if (!n.getAttribute(a)?.startsWith("#")) n.removeAttribute(a);
  for (const a of doc.querySelectorAll("a, area")) {
    const href = a.getAttribute("href");
    if (href?.startsWith("#")) a.setAttribute("href", "about:srcdoc" + href);
    else a.removeAttribute("href");
  }
  const run = limiter(4);
  const read = new Map<string, Promise<string | null>>();
  const inline = (p: string) => {
    let u = read.get(p);
    if (!u) read.set(p, (u = run(() => load(p)).then((b) => dataUrl(b.bytes, imageType(p)), () => null)));
    return u;
  };
  const work: Promise<unknown>[] = [];
  for (const img of doc.querySelectorAll("img")) {
    const src = img.getAttribute("src") ?? "";
    img.removeAttribute("srcset");
    if (/^data:/i.test(src)) continue;
    img.removeAttribute("src");
    const p = relativeTarget(path, src);
    // A missing image stays empty and shows its alt text.
    if (p) work.push(inline(p).then((u) => u && img.setAttribute("src", u)));
  }
  for (const n of doc.querySelectorAll("[style]")) work.push(inlineCss(n.getAttribute("style")!, path, inline).then((css) => n.setAttribute("style", css)));
  for (const style of doc.querySelectorAll("style")) work.push(inlineCss(style.textContent ?? "", path, inline).then((css) => void (style.textContent = css)));
  for (const link of doc.querySelectorAll("link")) {
    const p = /(^|\s)stylesheet(\s|$)/i.test(link.rel) ? relativeTarget(path, link.getAttribute("href") ?? "") : null;
    if (!p) {
      link.remove();
      continue;
    }
    const style = doc.createElement("style");
    link.replaceWith(style);
    work.push(
      run(() => load(p)).then(
        (b) => inlineCss(decodeText(b.bytes) ?? "", p, inline).then((css) => void (style.textContent = css)),
        () => style.remove(),
      ),
    );
  }
  await Promise.all(work);
  return (doc.doctype ? "<!doctype html>" : "") + doc.documentElement.outerHTML;
}

// An HTML file as a page, in a frame with an empty sandbox: no script runs, and the page gets an
// origin of its own, so it can't reach the app, its token or blimpd. srcdoc keeps the app's content
// security policy on it (docs/DESIGN.md). While a new version of the file loads, the last one stays.
export function HtmlView(props: { path: string; text: string; load: (path: string) => Promise<FileBody> }) {
  const [page, setPage] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    framePage(props.path, props.text, props.load).then(
      (h) => live && (setPage(h), setError("")),
      (e) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [props.text, props.path]);
  return (
    <>
      {error && <p className="view-note">Can't show this page: {error}. Edit shows its text.</p>}
      {page !== null && <iframe className="html-view" sandbox="" srcDoc={page} title={baseName(props.path)} />}
    </>
  );
}
