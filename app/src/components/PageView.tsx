import { useState } from "react";
import { openWebLink } from "../lib/links";

// A browser tab on a port of the server: the page at base + path, where base is this computer's
// end of the forward (lib/ports.ts). The page is another origin (127.0.0.1:<port>), so it can't
// reach blimp's page or its token; the sandbox also keeps it from navigating blimp's window or
// opening windows of its own (Open in Browser is for that).
// The page's own address isn't readable from here (another origin), so the bar shows the
// address it was opened at, and Reload loads that again.
export type Page = { key: string; port: number; host: "127.0.0.1" | "::1"; base: string | null; path: string; error: string; nonce: number };

export function PageView(props: { page: Page; onGo: (path: string) => void; onReload: () => void }) {
  const { page } = props;
  const [draft, setDraft] = useState(page.path);
  const url = page.base ? page.base + page.path : null;
  return (
    <div className="page-view">
      <form
        className="page-bar"
        onSubmit={(e) => {
          e.preventDefault();
          props.onGo(draft.startsWith("/") ? draft : "/" + draft);
        }}
      >
        <button type="button" className="icon-button small" title="Reload" aria-label="Reload" disabled={!url} onClick={props.onReload}>
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
            <path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3" fill="none" stroke="currentColor" />
          </svg>
        </button>
        <span className="page-origin">localhost:{page.port}</span>
        <input aria-label="Path" value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} />
        <button type="button" className="link-button" disabled={!url} onClick={() => url && openWebLink(url)}>
          Open in Browser
        </button>
      </form>
      {page.error ? (
        <div className="empty error">{page.error}</div>
      ) : url ? (
        <iframe
          key={page.nonce}
          className="page-frame"
          title={`localhost:${page.port}`}
          src={url}
          sandbox="allow-scripts allow-same-origin allow-forms allow-modals"
        />
      ) : (
        <div className="empty">Opening port {page.port}…</div>
      )}
    </div>
  );
}
