import { useEffect, useRef, useState } from "react";
import type { Conversation, Session } from "../lib/api";
import { errorText, type ServerLink } from "../lib/connection";
import { earlier, folderSessions, lastActivity, pickSession } from "../lib/sessions";
import { relTime } from "../lib/time";
import { TerminalView } from "./TerminalView";

// Things the window's shortcuts and ⌘K reach into the pane for.
export type PaneActions = { newClaude: () => void };

const STATE_LABEL: Record<Session["state"], string> = {
  working: "Working",
  waiting: "Waiting for you",
  done: "Idle",
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

// The bottom pane: the selected session's terminal, and on its right the folder's sessions,
// as `claude --resume` scopes them: running ones (with their state), then earlier conversations.
// selected: the session shown, kept by the window (it's in the URL). null: pick one.
export function TerminalPane(props: {
  link: ServerLink;
  dir: string;
  selected: string | null;
  onSelect: (name: string | null) => void;
  onOpenPath: (path: string, line?: number, col?: number) => void;
  onNotice: (msg: string) => void;
  actions: { current: PaneActions };
}) {
  const { link, dir } = props;
  const api = link.status === "connected" ? link.api : null;
  const now = useNow(30_000);
  const loaded = link.sessions !== null;
  const running = folderSessions(link.sessions ?? [], dir);
  // Sessions shown at least once stay mounted, so switching back keeps their scrollback.
  const [mounted, setMounted] = useState<string[]>([]);
  // Just started: not in the server's list until its next update (about a second).
  const pending = useRef(new Map<string, number>()).current;
  const [convs, setConvs] = useState<Conversation[] | null>(null);
  const [menu, setMenu] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isRunning = (name: string) => running.some((s) => s.name === name);
  for (const name of pending.keys()) if (isRunning(name) || Date.now() - pending.get(name)! > 15_000) pending.delete(name);

  // Nothing selected, or the selected session ended: show another one of this folder's.
  const sel = props.selected;
  useEffect(() => {
    if (!loaded) return;
    if (sel && (isRunning(sel) || pending.has(sel))) return;
    const next = pickSession(running)?.name ?? null;
    if (next !== sel) props.onSelect(next);
  });

  useEffect(() => {
    if (sel && !mounted.includes(sel)) setMounted((m) => [...m, sel]);
  }, [sel]);

  // Ended sessions leave the stack.
  const names = running.map((s) => s.name).join("\n");
  useEffect(() => {
    if (!loaded) return;
    setMounted((m) => m.filter((n) => isRunning(n) || pending.has(n) || n === sel));
  }, [names]);

  // Earlier conversations: on open, and when a session starts or ends here.
  const ids = running.map((s) => s.sessionId ?? "").join("\n");
  useEffect(() => {
    if (!api) return;
    let live = true;
    api.conversations(dir).then(
      (c) => live && setConvs(c),
      () => live && setConvs([]),
    );
    return () => void (live = false);
  }, [api, dir, ids]);

  const start = async (body: { shell?: boolean; resume?: string }) => {
    setMenu(false);
    if (!api) return props.onNotice("Not connected.");
    if (busy) return;
    setBusy(true);
    try {
      const { name } = await api.createSession({ dir, ...body });
      pending.set(name, Date.now());
      props.onSelect(name);
    } catch (e) {
      props.onNotice(`Couldn't start a session: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };
  props.actions.current = { newClaude: () => void start({}) };

  const end = async (s: Session) => {
    setConfirm(null);
    if (!api) return;
    try {
      await api.endSession(s.name);
      setMounted((m) => m.filter((n) => n !== s.name));
      if (sel === s.name) props.onSelect(pickSession(running.filter((x) => x.name !== s.name))?.name ?? null);
    } catch (e) {
      props.onNotice(`Couldn't end ${s.title}: ${errorText(e)}`);
    }
  };

  // An idle Claude session ends at once: nothing is lost, its conversation can be resumed.
  // Anything that may be busy (working, waiting, a shell) asks first.
  const trash = (s: Session) => (s.kind === "claude" && s.state === "done" ? void end(s) : setConfirm(s.name));

  const past = convs ? earlier(convs, running) : [];

  return (
    <div className="tpane">
      <div className="tpane-terms">
        {mounted.map((name) => (
          <TerminalView
            key={name}
            link={link}
            name={name}
            dir={dir}
            active={name === sel}
            onOpenPath={props.onOpenPath}
            onClose={() => {
              setMounted((m) => m.filter((n) => n !== name));
              if (sel === name) props.onSelect(null);
            }}
          />
        ))}
        {loaded && !sel && (
          <div className="empty-center">
            <p>No session in this folder.</p>
            <div className="empty-actions">
              <button className="primary" disabled={!api || busy} onClick={() => void start({})}>
                New Claude session
              </button>
              <button disabled={!api || busy} onClick={() => void start({ shell: true })}>
                New shell
              </button>
            </div>
          </div>
        )}
        {!loaded && <div className="empty-center">Connecting…</div>}
      </div>
      <nav className="slist" aria-label="Sessions">
        <div className="pane-head">
          <span className="pane-title">Sessions</span>
          <div className="menu-anchor">
            <button
              className="icon-button small"
              title="New session"
              aria-label="New session"
              aria-expanded={menu}
              disabled={!api}
              onClick={() => setMenu((m) => !m)}
            >
              +
            </button>
            {menu && (
              <>
                <div className="menu-scrim" onClick={() => setMenu(false)} />
                <div className="menu" role="menu">
                  <button role="menuitem" onClick={() => void start({})}>
                    New Claude session<span className="menu-key">⌘N</span>
                  </button>
                  <button role="menuitem" onClick={() => void start({ shell: true })}>
                    New shell
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
        <div className="slist-scroll">
          {running.map((s) => (
            <div
              key={s.name}
              data-session={s.name}
              className={"srow" + (s.name === sel ? " selected" : "") + (link.status !== "connected" ? " stale" : "")}
              title={`${s.kind === "shell" ? "Shell" : s.title}\n${s.name}${STATE_LABEL[s.state] ? ` · ${STATE_LABEL[s.state]}` : ""}`}
            >
              {confirm === s.name ? (
                <div className="srow-confirm">
                  <span>End {s.kind === "shell" ? "this shell" : "this session"}?</span>
                  <button className="danger" onClick={() => void end(s)}>
                    End
                  </button>
                  <button onClick={() => setConfirm(null)}>Cancel</button>
                </div>
              ) : (
                <>
                  <button className="srow-main" onClick={() => props.onSelect(s.name)}>
                    <Mark s={s} />
                    <span className="srow-title">{s.kind === "shell" ? s.name : s.title}</span>
                    <span className="srow-time">{relTime(lastActivity(s), now)}</span>
                  </button>
                  <button className="srow-trash" title="End session" aria-label={`End ${s.kind === "shell" ? s.name : s.title}`} onClick={() => trash(s)}>
                    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
                      <path d="M2.5 4.5h11M6 4.5V2.5h4v2M4 4.5l.7 9h6.6l.7-9M6.8 7v4.5M9.2 7v4.5" fill="none" stroke="currentColor" />
                    </svg>
                  </button>
                </>
              )}
            </div>
          ))}
          {loaded && running.length === 0 && <p className="slist-note">Nothing running here.</p>}
          {past.length > 0 && <div className="slist-label">Earlier</div>}
          {past.map((c) => (
            <button key={c.sessionId} className="srow-main earlier" disabled={busy || !api} title={`Resume: ${c.title}`} onClick={() => void start({ resume: c.sessionId })}>
              <span className="srow-mark" />
              <span className="srow-title">{c.title}</span>
              <span className="srow-time">{relTime(c.updatedAt, now)}</span>
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}

function Mark(props: { s: Session }) {
  const { s } = props;
  // A shell has no state (Claude's files and hooks are where states come from).
  if (s.kind === "shell" && s.state === "unknown") return <span className="srow-mark shell" aria-label="Shell">{">_"}</span>;
  return (
    <span className={"srow-mark state-" + s.state} aria-label={STATE_LABEL[s.state] || undefined}>
      {s.state === "waiting" ? <span className="dot" /> : <span className="state-dot" />}
    </span>
  );
}
