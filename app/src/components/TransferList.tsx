import { useEffect, useReducer } from "react";
import { inTauri } from "../lib/connection";
import { formatSize } from "../lib/files";
import { cancel, dismiss, reveal, transfers } from "../lib/transfers";

// Downloads and uploads with their progress, at the bottom left of the window. Finished uploads
// go by themselves; a finished download stays, with Show in Finder, until closed.
export function TransferList() {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => transfers.subscribe(rerender), []);
  const list = transfers.list();
  if (!list.length) return null;
  return (
    <div className="transfers" role="status" aria-label="Transfers">
      {list.map((t) => {
        const pct = t.total ? Math.min(100, Math.round((t.done / t.total) * 100)) : null;
        return (
          <div key={t.id} className={"transfer " + t.state}>
            <div className="transfer-line">
              <span className="transfer-what">{t.kind === "down" ? "↓" : "↑"}</span>
              <span className="transfer-name" title={t.label}>
                {t.label}
              </span>
              {t.state === "running" ? (
                <button className="tab-close" aria-label={`Cancel ${t.label}`} title="Cancel" onClick={() => cancel(t.id)}>
                  ×
                </button>
              ) : (
                <button className="tab-close" aria-label={`Close ${t.label}`} onClick={() => dismiss(t.id)}>
                  ×
                </button>
              )}
            </div>
            {t.state === "running" && (
              <>
                <div className="transfer-bar">
                  <div style={{ width: pct === null ? "30%" : `${pct}%` }} className={pct === null ? "unknown" : ""} />
                </div>
                <div className="transfer-note">{t.total ? `${formatSize(t.done)} of ${formatSize(t.total)}` : formatSize(t.done)}</div>
              </>
            )}
            {t.state === "done" && (
              <div className="transfer-note">
                {t.kind === "up" ? "Uploaded" : "Downloaded"}
                {t.saved && inTauri() && (
                  <button className="link-button" onClick={() => void reveal(t.saved!)}>
                    Show in Finder
                  </button>
                )}
              </div>
            )}
            {t.state === "cancelled" && <div className="transfer-note">Cancelled</div>}
            {t.state === "failed" && <div className="transfer-note error">{t.error}</div>}
          </div>
        );
      })}
    </div>
  );
}
