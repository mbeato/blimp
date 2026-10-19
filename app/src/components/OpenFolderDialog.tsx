import { useEffect, useState, type ReactNode } from "react";
import { ApiError, type DirListing, type RecentFolder } from "../lib/api";
import { errorText, type ServerLink } from "../lib/connection";
import { joinPath } from "../lib/files";
import { tildify } from "../lib/sessions";
import { relTime } from "../lib/time";
import { Dialog } from "./Dialog";

// "~/x" and "x" are relative to the server's home folder.
export function expandPath(text: string, home: string): string {
  let p = text.trim();
  if (p === "~") p = home;
  else if (p.startsWith("~/")) p = home + p.slice(1);
  else if (!p.startsWith("/")) p = `${home}/${p}`;
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

const parent = (p: string) => p.replace(/\/[^/]+$/, "") || "/";

// ⌘O: pick a folder on a server (recent, browse or typed) to open as the window's project.
// While browsing, New folder makes one and goes into it.
export function OpenFolderDialog(props: {
  links: ServerLink[]; // connected servers
  initial: ServerLink;
  onPick: (link: ServerLink, dir: string) => void;
  onClose: () => void;
}) {
  const [link, setLink] = useState(props.initial);
  return (
    <Dialog onClose={props.onClose} className="newsession">
      <div className="dialog-head">
        <h2>Open folder</h2>
        {props.links.length > 1 && (
          <select
            value={link.key}
            onChange={(e) => setLink(props.links.find((l) => l.key === e.target.value) ?? link)}
            aria-label="Server"
          >
            {props.links.map((l) => (
              <option key={l.key} value={l.key}>
                {l.key}
              </option>
            ))}
          </select>
        )}
      </div>
      <FolderPicker key={link.key} link={link} onPick={(d) => props.onPick(link, d)} />
    </Dialog>
  );
}

function FolderPicker(props: { link: ServerLink; onPick: (dir: string) => void }) {
  const api = props.link.api!;
  const home = props.link.home;
  const [view, setView] = useState<"recent" | "browse">("recent");
  const [typed, setTyped] = useState("");
  const [recent, setRecent] = useState<RecentFolder[] | null>(null);
  const [listing, setListing] = useState<DirListing | null>(null);
  const [browsePath, setBrowsePath] = useState(home);
  const [error, setError] = useState("");
  const [sel, setSel] = useState(0);
  const [naming, setNaming] = useState(false);
  const [nameError, setNameError] = useState("");
  const [reload, setReload] = useState(0);

  const makeFolder = async (name: string) => {
    name = name.trim();
    if (!name) return setNaming(false);
    if (name.includes("/") || name === "." || name === "..") return setNameError("A name can't contain / or be . or ..");
    const path = joinPath(listing?.path ?? browsePath, name);
    try {
      await api.fsMkdir(path);
    } catch (e) {
      return setNameError(e instanceof ApiError && e.status === 409 ? `${name} already exists.` : errorText(e));
    }
    setNaming(false);
    setNameError("");
    setBrowsePath(path);
    setSel(0);
    setReload((n) => n + 1);
  };

  useEffect(() => {
    api.recentFolders().then(setRecent, (e) => setError(errorText(e)));
  }, [api]);

  useEffect(() => {
    if (view !== "browse") return;
    setListing(null);
    api.fsList(browsePath).then(
      (l) => (setListing(l), setError("")),
      (e) => setError(errorText(e)),
    );
  }, [api, view, browsePath, reload]);

  const dirs = listing?.entries.filter((e) => e.kind === "dir" && e.name !== ".git") ?? [];
  const count = view === "recent" ? (recent?.length ?? 0) : dirs.length;
  const activate = (n: number) => {
    if (view === "recent" && recent?.[n]) props.onPick(recent[n].dir);
    else if (view === "browse" && dirs[n]) (setBrowsePath(`${listing!.path.replace(/\/$/, "")}/${dirs[n].name}`), setSel(0));
  };

  return (
    <>
      <input
        className="dialog-input"
        autoFocus
        placeholder="Type a folder path, like ~/projects/app"
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") setSel((n) => Math.min(n + 1, count - 1));
          else if (e.key === "ArrowUp") setSel((n) => Math.max(n - 1, 0));
          else if (e.key === "Enter") typed.trim() ? props.onPick(expandPath(typed, home)) : activate(sel);
          else return;
          e.preventDefault();
        }}
      />
      <div className="segmented" role="tablist">
        {(["recent", "browse"] as const).map((v) => (
          <button key={v} role="tab" aria-selected={view === v} onClick={() => (setView(v), setSel(0))}>
            {v === "recent" ? "Recent folders" : "Browse"}
          </button>
        ))}
      </div>
      {view === "browse" && (
        <div className="browse-bar">
          <button className="link-button" disabled={browsePath === "/"} onClick={() => (setBrowsePath(parent(browsePath)), setSel(0))}>
            Up
          </button>
          <span className="browse-path">{tildify(listing?.path ?? browsePath, home)}</span>
          <button onClick={() => (setNaming(true), setNameError(""))}>New folder</button>
          <button className="primary" onClick={() => props.onPick(listing?.path ?? browsePath)}>
            Open
          </button>
        </div>
      )}
      {view === "browse" && naming && (
        <div className="browse-new">
          <input
            className="dialog-input"
            autoFocus
            aria-label="New folder name"
            placeholder="New folder name"
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") void makeFolder(e.currentTarget.value);
              else if (e.key === "Escape") setNaming(false);
              else return;
              e.preventDefault();
            }}
          />
          {nameError && <p className="dialog-error">{nameError}</p>}
        </div>
      )}
      <ul className="list" role="listbox">
        {view === "recent" &&
          recent?.map((r, n) => (
            <Item key={r.dir} n={n} sel={sel} setSel={setSel} onClick={() => activate(n)}>
              <span className="list-main">{tildify(r.dir, home)}</span>
              <span className="list-side">{relTime(r.lastUsed)}</span>
            </Item>
          ))}
        {view === "browse" &&
          dirs.map((d, n) => (
            <Item key={d.name} n={n} sel={sel} setSel={setSel} onClick={() => activate(n)}>
              <span className="list-main">{d.name}/</span>
            </Item>
          ))}
        {!error && view === "recent" && recent?.length === 0 && <li className="list-empty">No recent folders. Browse or type a path.</li>}
        {!error && view === "browse" && listing && dirs.length === 0 && <li className="list-empty">No folders here.</li>}
        {!error && ((view === "recent" && !recent) || (view === "browse" && !listing)) && <li className="list-empty">Loading…</li>}
        {error && <li className="list-empty error">{error}</li>}
      </ul>
    </>
  );
}

function Item(props: { n: number; sel: number; setSel: (n: number) => void; onClick: () => void; children: ReactNode }) {
  const on = props.n === props.sel;
  return (
    <li
      role="option"
      aria-selected={on}
      ref={on ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
      className={"list-item" + (on ? " selected" : "")}
      onMouseMove={() => props.setSel(props.n)}
      onClick={props.onClick}
    >
      {props.children}
    </li>
  );
}
