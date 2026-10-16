import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Conversation, DirListing, RecentFolder } from "../lib/api";
import { errorText, type ServerLink } from "../lib/connection";
import { tildify } from "../lib/sidebar";
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

type Props = {
  links: ServerLink[]; // connected servers
  initial: ServerLink;
  onStart: (link: ServerLink, dir: string, resume?: string) => Promise<void>;
  onClose: () => void;
};

// ⌘⇧N: pick a folder (recent, browse or typed), then start a new conversation or resume one.
export function NewSessionDialog(props: Props) {
  const [link, setLink] = useState(props.initial);
  const [dir, setDir] = useState<string | null>(null); // chosen folder; null while picking
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const start = async (resume?: string) => {
    if (!dir || busy) return;
    setBusy(true);
    setError("");
    try {
      await props.onStart(link, dir, resume);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <Dialog onClose={props.onClose} className="newsession">
      <div className="dialog-head">
        <h2>{dir ? tildify(dir, link.home) : "New session in…"}</h2>
        {!dir && props.links.length > 1 && (
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
        {dir && (
          <button className="link-button" onClick={() => (setDir(null), setError(""))}>
            Change folder
          </button>
        )}
      </div>
      {dir ? (
        <ConversationPicker key={link.key + dir} link={link} dir={dir} busy={busy} onPick={start} />
      ) : (
        <FolderPicker key={link.key} link={link} onPick={(d) => (setDir(d), setError(""))} />
      )}
      {error && <p className="dialog-error">{error}</p>}
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
  }, [api, view, browsePath]);

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
          <button onClick={() => props.onPick(listing?.path ?? browsePath)}>Use this folder</button>
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

function ConversationPicker(props: { link: ServerLink; dir: string; busy: boolean; onPick: (resume?: string) => void }) {
  const [convs, setConvs] = useState<Conversation[] | null>(null);
  const [error, setError] = useState("");
  const [sel, setSel] = useState(0);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => list.current?.focus(), []);
  useEffect(() => {
    props.link.api!.conversations(props.dir).then(setConvs, (e) => setError(errorText(e)));
  }, [props.link, props.dir]);

  // Row 0 is "New conversation", the rest resume.
  const pick = (n: number) => (n === 0 ? props.onPick() : convs?.[n - 1] && props.onPick(convs[n - 1].sessionId));
  const count = 1 + (convs?.length ?? 0);

  return (
    <ul
      className={"list" + (props.busy ? " busy" : "")}
      role="listbox"
      tabIndex={0}
      ref={list}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") setSel((n) => Math.min(n + 1, count - 1));
        else if (e.key === "ArrowUp") setSel((n) => Math.max(n - 1, 0));
        else if (e.key === "Enter") pick(sel);
        else return;
        e.preventDefault();
      }}
    >
      <Item n={0} sel={sel} setSel={setSel} onClick={() => pick(0)}>
        <span className="list-main strong">New conversation</span>
      </Item>
      {convs && convs.length > 0 && <li className="list-label">Resume</li>}
      {convs?.map((c, i) => (
        <Item key={c.sessionId} n={i + 1} sel={sel} setSel={setSel} onClick={() => pick(i + 1)}>
          <span className="list-main">{c.title}</span>
          <span className="list-side">{relTime(c.updatedAt)}</span>
        </Item>
      ))}
      {!convs && !error && <li className="list-empty">Loading earlier conversations…</li>}
      {error && <li className="list-empty error">{error}</li>}
    </ul>
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
