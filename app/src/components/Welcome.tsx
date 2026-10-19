import { useEffect, useState } from "react";
import type { ServerLink } from "../lib/connection";
import { recentProjects, type Recent } from "../lib/recent";
import { tildify } from "../lib/sessions";
import { relTime } from "../lib/time";

// Home's editor area while no file is open: recent projects, Open Folder, and the servers.
// shown: Home is the tab in front. The list is read again each time it comes forward, since
// the folders opened meanwhile were opened from other tabs (and windows).
export function Welcome(props: {
  link: ServerLink;
  shown: boolean;
  links: ServerLink[];
  onServer: (link: ServerLink) => void;
  onOpen: (dir: string) => void;
  onOpenFolder: () => void;
  onNewWindow: () => void;
  onAddServer: () => void;
  onRemoveServer: (link: ServerLink) => void;
  onForget: (dir: string) => void;
}) {
  const { link } = props;
  const [recent, setRecent] = useState<Recent[] | null>(null);
  useEffect(() => {
    let live = true;
    recentProjects(link.key).then((r) => live && setRecent(r));
    return () => void (live = false);
  }, [link.key, props.shown]);

  return (
    <div className="welcome-page">
      <div className="welcome-col">
        <h1>blimp</h1>
        <div className="welcome-server">
          {props.links.length > 1 ? (
            <select value={link.key} aria-label="Server" onChange={(e) => props.onServer(props.links.find((l) => l.key === e.target.value) ?? link)}>
              {props.links.map((l) => (
                <option key={l.key} value={l.key}>
                  {l.key}
                </option>
              ))}
            </select>
          ) : (
            <span className="welcome-host">{link.key}</span>
          )}
          <span className={"conn conn-" + link.status}>{link.status === "connected" ? "connected" : link.status === "offline" ? "offline" : "connecting…"}</span>
          <button className="link-button" onClick={props.onAddServer}>
            Add server
          </button>
        </div>
        {link.status === "offline" && (
          <div className="server-error">
            <p>{link.error}</p>
            <div className="server-error-actions">
              <button onClick={() => link.retryNow()}>Try again</button>
              <button onClick={() => props.onRemoveServer(link)}>Remove server</button>
            </div>
          </div>
        )}

        <h2>Start</h2>
        <div className="welcome-actions">
          <button className="link-button" disabled={link.status !== "connected"} onClick={props.onOpenFolder}>
            Open Folder… <span className="menu-key">⌘O</span>
          </button>
          <button className="link-button" onClick={props.onNewWindow}>
            New Window <span className="menu-key">⌘⇧N</span>
          </button>
        </div>

        <h2>Recent</h2>
        {recent?.length ? (
          <ul className="welcome-recent">
            {recent.map((r) => (
              <li key={r.dir}>
                <button className="link-button" title={r.dir} onClick={() => props.onOpen(r.dir)}>
                  {r.dir.slice(r.dir.lastIndexOf("/") + 1) || r.dir}
                </button>
                <span className="welcome-dir">{tildify(r.dir, link.home)}</span>
                <span className="welcome-time">{relTime(r.at)}</span>
                <button
                  className="welcome-forget"
                  title="Remove from the list"
                  aria-label={`Remove ${r.dir} from the list`}
                  onClick={() => {
                    props.onForget(r.dir);
                    setRecent((list) => list?.filter((x) => x.dir !== r.dir) ?? null);
                  }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="welcome-note">{recent ? "Folders you open show up here." : ""}</p>
        )}

        <h2>Keys</h2>
        <dl className="keys welcome-keys">
          <dt>⌘K</dt>
          <dd>Jump to any session</dd>
          <dt>⌘N</dt>
          <dd>New Claude session in this folder</dd>
          <dt>⌘P</dt>
          <dd>Open a file by name</dd>
          <dt>⌘B / ⌘J / ⌘⌥B</dt>
          <dd>Show or hide files / terminal / sessions</dd>
          <dt>⌘-click</dt>
          <dd>Open a path from the terminal</dd>
          <dt>Drag a session</dt>
          <dd>Onto the terminal, to split it</dd>
        </dl>
      </div>
    </div>
  );
}
