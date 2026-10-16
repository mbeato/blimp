import { useEffect, useState } from "react";
import type { Api } from "../lib/api";
import { errorText } from "../lib/connection";
import { baseName, parentDir } from "../lib/files";
import { fuzzyFilter } from "../lib/fuzzy";
import { Dialog } from "./Dialog";

// ⌘P: open a file in the session folder by typing part of its path.
export function QuickOpen(props: { api: Api | null; root: string; onPick: (rel: string) => void; onClose: () => void }) {
  const [files, setFiles] = useState<string[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);

  useEffect(() => {
    if (!props.api) return setError("Not connected.");
    props.api.fsFiles(props.root).then(
      (r) => (setFiles(r.files), setTruncated(r.truncated)),
      (e) => setError(errorText(e)),
    );
  }, [props.api, props.root]);

  const items = files ? fuzzyFilter(files, query, (f) => f) : [];
  const pick = (f: string | undefined) => f !== undefined && props.onPick(f);

  return (
    <Dialog onClose={props.onClose} className="palette">
      <input
        className="palette-input"
        autoFocus
        placeholder="Open a file by name"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setSel(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") setSel((n) => Math.min(n + 1, items.length - 1));
          else if (e.key === "ArrowUp") setSel((n) => Math.max(n - 1, 0));
          else if (e.key === "Enter") pick(items[sel]);
          else return;
          e.preventDefault();
        }}
      />
      <ul className="list" role="listbox">
        {items.map((f, n) => (
          <li
            key={f}
            role="option"
            aria-selected={n === sel}
            ref={n === sel ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
            className={"list-item" + (n === sel ? " selected" : "")}
            onMouseMove={() => setSel(n)}
            onClick={() => pick(f)}
          >
            <span className="list-main">{baseName(f)}</span>
            <span className="list-side">{f.includes("/") ? parentDir(f) : ""}</span>
          </li>
        ))}
        {error && <li className="list-empty error">{error}</li>}
        {!error && !files && <li className="list-empty">Loading files…</li>}
        {files && items.length === 0 && <li className="list-empty">{files.length ? "No file matches." : "No files here."}</li>}
        {truncated && items.length > 0 && <li className="list-empty">Only the first 20,000 files are searched.</li>}
      </ul>
    </Dialog>
  );
}
