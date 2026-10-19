import { useEffect, useRef, useState, type RefObject } from "react";
import { pageFile, pageFileName, shownUrl, typedUrl, view, type Page, type PageText } from "../lib/browser";
import { inTauri } from "../lib/connection";
import { openWebLink } from "../lib/links";
import { useOverlay } from "../lib/overlay";

export type { Page };

// A session Send to session can paste into.
export type Target = { name: string; title: string };

// A browser tab: the bar (Back, Forward, Reload, the address, Open in Browser, Send to session)
// and the page. In the Mac app the page is a native web view the Rust shell keeps over the area
// below the bar (`shown` says when it may be on screen); in a browser it's a sandboxed iframe,
// another origin, so it can't reach blimp's page or its token, navigate blimp's window or open
// windows of its own. An iframe's address and history aren't readable from here, so there Back
// and Forward are off and the bar shows the address it was opened at.
export function PageView(props: {
  page: Page;
  shown: boolean;
  onGo: (url: string) => void;
  onReload: () => void;
  onLabel: (label: string) => void;
  targets: () => Target[];
  onSend: (to: string, text: PageText) => Promise<void>;
  onNotice: (text: string) => void;
}) {
  const { page } = props;
  const native = inTauri();
  const [draft, setDraft] = useState(shownUrl(page, page.url));
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState<Target[] | null>(null);
  const [sending, setSending] = useState(false);
  const area = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useOverlay(!!menu);
  // The bar follows the page while it isn't being typed in.
  useEffect(() => {
    if (!editing) setDraft(shownUrl(page, page.url));
  }, [page.url, page.base, editing]);
  // A new tab starts in the address field.
  useEffect(() => {
    if (!page.url && !page.port) input.current?.focus();
  }, []);

  useNativeView(native ? page : null, area, props.shown, props.onLabel);

  const go = (text: string) => {
    const url = typedUrl(page, text);
    if (!url) return props.onNotice(`Not a web address: ${text}`);
    setEditing(false);
    input.current?.blur();
    props.onGo(url);
  };

  const send = async (to: string) => {
    setMenu(null);
    if (!page.url) return;
    setSending(true);
    try {
      const text: PageText = page.label
        ? await view.read(page.label)
        : { url: page.url, title: page.title, text: "", selection: false };
      await props.onSend(to, text);
    } catch (e) {
      props.onNotice(`Couldn't read the page: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSending(false);
    }
  };

  const icon = (d: string) => (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <path d={d} fill="none" stroke="currentColor" />
    </svg>
  );
  const canNav = native && !!page.label;
  return (
    <div className="page-view">
      <form
        className="page-bar"
        onSubmit={(e) => {
          e.preventDefault();
          go(draft);
        }}
      >
        <button type="button" className="icon-button small" title="Back" aria-label="Back" disabled={!canNav} onClick={() => page.label && void view.nav(page.label, "back")}>
          {icon("M10 3.5L5.5 8l4.5 4.5")}
        </button>
        <button type="button" className="icon-button small" title="Forward" aria-label="Forward" disabled={!canNav} onClick={() => page.label && void view.nav(page.label, "forward")}>
          {icon("M6 3.5L10.5 8 6 12.5")}
        </button>
        <button type="button" className="icon-button small" title="Reload" aria-label="Reload" disabled={!page.url} onClick={props.onReload}>
          {icon("M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3")}
        </button>
        <input
          ref={input}
          aria-label="Address"
          placeholder="Type an address"
          value={draft}
          onChange={(e) => (setEditing(true), setDraft(e.target.value))}
          onFocus={(e) => e.target.select()}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => e.key === "Escape" && (setEditing(false), setDraft(shownUrl(page, page.url)), input.current?.blur())}
          spellCheck={false}
          autoCapitalize="off"
        />
        {page.loading && <span className="page-loading" aria-label="Loading" />}
        <button type="button" className="link-button" disabled={!page.url} onClick={() => page.url && openWebLink(page.url)}>
          Open in Browser
        </button>
        <div className="menu-anchor">
          <button
            type="button"
            className="link-button"
            aria-expanded={!!menu}
            disabled={!page.url || sending}
            title={native ? "Paste this page's address, title and text (or the selection) into a session" : "Paste this page's address into a session"}
            onClick={() => setMenu(menu ? null : props.targets())}
          >
            {sending ? "Sending…" : "Send to session"}
          </button>
          {menu && (
            <>
              <div className="menu-scrim" onClick={() => setMenu(null)} />
              <div className="menu send-menu" role="menu" onKeyDown={(e) => e.key === "Escape" && setMenu(null)}>
                {menu.length === 0 && <div className="menu-note-row">No session running in this folder</div>}
                {menu.map((t) => (
                  <button key={t.name} role="menuitem" onClick={() => void send(t.name)}>
                    <span className="menu-label">{t.title}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </form>
      {page.error ? (
        <div className="empty error">{page.error}</div>
      ) : !page.url ? (
        <div className="empty">{page.port ? `Opening port ${page.port.port}…` : "Type an address above"}</div>
      ) : native ? (
        <div ref={area} className="page-frame page-native" data-view={page.label} />
      ) : (
        <iframe
          key={page.nonce}
          className="page-frame"
          title={page.title || page.url}
          src={page.url}
          sandbox="allow-scripts allow-same-origin allow-forms allow-modals"
        />
      )}
    </div>
  );
}

// Keeps the native view over `area`: opened once there's an address, moved and resized with
// it, shown only while `shown`. Closed by Workbench with the tab.
function useNativeView(page: Page | null, area: RefObject<HTMLDivElement | null>, shown: boolean, onLabel: (label: string) => void) {
  const last = useRef("");
  const opening = useRef(false);
  const rect = () => {
    const r = area.current?.getBoundingClientRect();
    return r && { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const place = () => {
    const r = rect();
    if (!page?.label || !r || !shown) return;
    const k = `${r.x},${r.y},${r.w},${r.h}`;
    if (k === last.current) return;
    last.current = k;
    void view.bounds(page.label, r).catch(() => {});
  };
  // Open it.
  useEffect(() => {
    if (!page?.url || page.label || opening.current || !shown) return;
    const r = rect();
    if (!r) return;
    opening.current = true;
    view.open(page.url, r).then(
      (label) => {
        last.current = `${r.x},${r.y},${r.w},${r.h}`;
        onLabel(label);
      },
      () => (opening.current = false),
    );
  });
  // Show or hide it; when shown, put it where the area is now.
  useEffect(() => {
    if (!page?.label) return;
    if (shown) {
      last.current = "";
      place();
    }
    void view.show(page.label, shown).catch(() => {});
  }, [page?.label, shown]);
  // Follow the area: its size (ResizeObserver), the window's, and anything that moves it (checked
  // after each render).
  useEffect(place);
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    const ro = new ResizeObserver(place);
    ro.observe(el);
    window.addEventListener("resize", place);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", place);
    };
  });
}

// What Send to session uploads, and the line pasted before its path.
export function sendItem(text: PageText) {
  const name = pageFileName(text.url);
  return { item: { name, file: new File([pageFile(text)], name, { type: "text/markdown" }) }, prefix: `Page ${text.url}: ` };
}
