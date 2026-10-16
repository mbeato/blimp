import { useEffect, useState } from "react";
import type { Session } from "../lib/api";
import type { ServerLink } from "../lib/connection";
import { folderGroups, lastActivity, tildify, waitingQueue } from "../lib/sidebar";
import { relTime } from "../lib/time";

const STATE_LABEL: Record<Session["state"], string> = {
  working: "working",
  waiting: "waiting for you",
  done: "done",
  unknown: "",
};

// Re-render every 30 s so "2m ago" stays true.
function useNow(ms: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

type Props = {
  links: ServerLink[];
  activeTab: string | null;
  onOpen: (link: ServerLink, name: string) => void;
  onNewIn: (link: ServerLink, dir: string) => void;
  onAddServer: () => void;
  onRemoveServer: (link: ServerLink) => void;
};

export function Sidebar(props: Props) {
  const now = useNow(30_000);
  const many = props.links.length > 1;
  const waiting = waitingQueue(props.links.map((link) => ({ link, sessions: link.sessions ?? [] })));
  return (
    <nav className="sidebar" aria-label="Sessions">
      <div className="sidebar-scroll">
        {waiting.length > 0 && (
          <div className="group waiting-group">
            <div className="group-head">
              <span className="group-label">Waiting for you</span>
            </div>
            {/* This group has no folder header, so each row says where it runs (and on which server). */}
            {waiting.map(({ link, s }) => (
              <Row
                key={`${link.key}/${s.name}`}
                s={s}
                link={link}
                where={(many ? `${link.key} · ` : "") + tildify(s.dir, link.home)}
                now={now}
                activeTab={props.activeTab}
                onOpen={props.onOpen}
              />
            ))}
          </div>
        )}
        {props.links.map((link) => (
          <ServerSection key={link.key} link={link} showHeader={many} now={now} {...props} />
        ))}
      </div>
      <button className="sidebar-add" onClick={props.onAddServer}>
        <span aria-hidden>+</span> Add server
      </button>
    </nav>
  );
}

function ServerSection(props: Props & { link: ServerLink; showHeader: boolean; now: number }) {
  const { link } = props;
  const sessions = link.sessions ?? [];
  const folders = folderGroups(sessions, link.home);
  return (
    <section className="server">
      {props.showHeader && (
        <div className="server-head">
          <span className="server-name">{link.key}</span>
          {link.status !== "connected" && <span className="server-status">{link.status === "offline" ? "offline" : "connecting"}</span>}
        </div>
      )}
      {link.status === "offline" && (
        <div className="server-error">
          <p>{link.error}</p>
          <div className="server-error-actions">
            <button onClick={() => link.retryNow()}>Try again</button>
            <button onClick={() => props.onRemoveServer(link)}>Remove server</button>
          </div>
        </div>
      )}
      {link.sessions === null && link.status === "connecting" && <p className="sidebar-note">Connecting to {link.server.host}…</p>}
      {link.sessions !== null && sessions.length === 0 && (
        <p className="sidebar-note">No sessions running. Press ⌘⇧N to start one.</p>
      )}
      {folders.map((g) => (
        <div className="group" key={g.dir}>
          <div className="group-head" title={g.dir}>
            <span className="group-label">{g.label}</span>
            <button
              className="group-new"
              title={`New session in ${g.label}`}
              aria-label={`New session in ${g.label}`}
              onClick={() => props.onNewIn(link, g.dir)}
            >
              +
            </button>
          </div>
          {g.sessions.map((s) => (
            <Row key={s.name} s={s} link={link} now={props.now} activeTab={props.activeTab} onOpen={props.onOpen} />
          ))}
        </div>
      ))}
    </section>
  );
}

// where: shown in place of the state, for rows outside a folder group (the state is the group's).
// A server that isn't connected keeps its last list, dimmed: those states may be out of date.
function Row(props: {
  s: Session;
  link: ServerLink;
  where?: string;
  now: number;
  activeTab: string | null;
  onOpen: (link: ServerLink, name: string) => void;
}) {
  const { s, link } = props;
  const selected = props.activeTab === `${link.key}/${s.name}`;
  const stale = link.status !== "connected";
  return (
    <button
      className={"row" + (selected ? " selected" : "") + (stale ? " stale" : "")}
      onClick={() => props.onOpen(link, s.name)}
      title={`${s.title}\n${tildify(s.dir, link.home)}`}
    >
      <span className="row-mark">{s.state === "waiting" && <span className="dot" />}</span>
      <span className="row-title">{s.title}</span>
      {props.where ? (
        <span className="row-where">{props.where}</span>
      ) : (
        <span className={"row-state state-" + s.state}>{STATE_LABEL[s.state]}</span>
      )}
      <span className="row-time">{relTime(lastActivity(s), props.now)}</span>
    </button>
  );
}
