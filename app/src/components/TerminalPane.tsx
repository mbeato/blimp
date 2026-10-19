import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { Conversation, Port, Session } from "../lib/api";
import { errorText, type ServerLink } from "../lib/connection";
import { dropAt, dropTarget, equalShares, moveDivider, prune, removePane, show, type Panes, type Side } from "../lib/panes";
import { freeName, plainName, upload, type Item } from "../lib/transfers";
import { earlier, folderSessions, lastActivity, pickSession } from "../lib/sessions";
import { relTime } from "../lib/time";
import { Splitter } from "./Splitter";
import { TerminalView } from "./TerminalView";

// Things the window reaches into the pane for: ⌘N, and a session dropped here from another
// window at (x, y) in the page.
// release: another window took the session into one of its splits, so stop showing it here.
// dropFiles: files from Finder let go on a session's terminal.
export type PaneActions = {
  newClaude: () => void;
  dropIn: (name: string, x: number, y: number) => void;
  release: (name: string) => void;
  dropFiles: (name: string, items: Item[]) => void;
};
export const noActions: PaneActions = { newClaude: () => {}, dropIn: () => {}, release: () => {}, dropFiles: () => {} };

// Where files dropped on a terminal go on the server.
const UPLOADS = ".blimp/uploads";

const STATE_LABEL: Record<Session["state"], string> = {
  working: "Working",
  waiting: "Waiting for you",
  done: "Idle",
  unknown: "",
};

// No split narrower than this.
const MIN_SPLIT_PX = 160;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

// A session being dragged from the list, and where it would land.
type Drag = { name: string; label: string; x: number; y: number; target: { at: number; side: Side } | null };

// Re-render every 30 s so "2m ago" stays true.
function useNow(ms: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

// The bottom pane: the folder's sessions in terminal splits, side by side, and on their right
// the list of them, as `claude --resume` scopes them: running ones (with their state), then
// earlier conversations. Dragging a running session from the list onto a terminal splits it.
// panes: the splits, kept by the window's tab (it's in the URL); onPanes updates them.
// front: this tab is the one in front. showList: the list's show/hide button.
// onMoveOut: sessions leaving for another window (right-click > Open in New Window, or a drag let
// go outside the window at a point on screen); the pane then stops showing them.
// elsewhere: another window shows the session; a click on its row goes there (onFocusElsewhere,
// false if that window has gone), and dragging it into a split here takes it (onTake).
export function TerminalPane(props: {
  link: ServerLink;
  dir: string;
  panes: Panes;
  onPanes: (f: (p: Panes) => Panes) => void;
  front: boolean;
  showList: boolean;
  onOpenPath: (path: string, line?: number, col?: number) => void;
  onNotice: (msg: string) => void;
  onMoveOut: (names: string[], at?: { x: number; y: number }) => void;
  elsewhere: (name: string) => boolean;
  onFocusElsewhere: (name: string) => Promise<boolean>;
  onTake: (name: string) => void;
  // A port a session here listens on: open it in a browser tab.
  onOpenPort: (p: Port) => void;
  actions: { current: PaneActions };
}) {
  const { link, dir, panes: p, onPanes } = props;
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
  const [drag, setDrag] = useState<Drag | null>(null);
  // Right-click menu on a session (its row or its split's header), at the pointer.
  const [ctx, setCtx] = useState<{ name: string; x: number; y: number } | null>(null);
  const [listWidth, setListWidth] = useState(230);
  const box = useRef<HTMLDivElement>(null);
  // Moved to another window: not picked to fill an empty terminal here (the user can still
  // click or drag them back).
  const away = useRef(new Set<string>()).current;
  const pastes = useRef(new Map<string, (text: string) => void>()).current;
  // Divider positions, for the splits they were dragged for (another set of splits: equal again).
  const [sizes, setSizes] = useState<{ names: string; shares: number[] }>({ names: "", shares: [] });
  const terms = useRef<HTMLDivElement>(null);
  // Ended from here: still listed until the server's next update, but not to be shown again.
  const ended = useRef(new Set<string>()).current;
  // A drag ends with a pointerup on the row it started from: that click isn't a click.
  const dragged = useRef(false);
  // Ends a drag in progress: also when the tab closes mid-drag.
  const endDrag = useRef(() => {});
  useEffect(() => () => endDrag.current(), []);

  const isRunning = (name: string) => running.some((s) => s.name === name);
  for (const name of pending.keys()) if (isRunning(name) || Date.now() - pending.get(name)! > 15_000) pending.delete(name);
  for (const name of ended) if (loaded && !isRunning(name)) ended.delete(name);
  const alive = (name: string) => !ended.has(name) && (isRunning(name) || pending.has(name));
  const live = running.filter((s) => !ended.has(s.name));

  // Splits whose session ended close; with none left, show another one of this folder's.
  const fill = (q: Panes) => {
    const next = prune(q, alive);
    const pick = next.panes.length ? null : pickSession(live.filter((s) => !away.has(s.name)));
    return pick ? show(next, pick.name) : next;
  };
  const stale = loaded && fill(p) !== p;
  useEffect(() => {
    if (stale) onPanes(fill);
  });

  const shown = p.panes.join("\n");
  useEffect(() => {
    const add = p.panes.filter((n) => !mounted.includes(n));
    if (add.length) setMounted((m) => [...m, ...add]);
  }, [shown]);

  // Ended sessions leave the stack.
  const names = running.map((s) => s.name).join("\n");
  useEffect(() => {
    if (!loaded) return;
    setMounted((m) => m.filter((n) => alive(n) || p.panes.includes(n)));
  }, [names]);

  // Each split's share of the width. A split added, closed or moved makes them equal again.
  const shares = sizes.names === shown ? sizes.shares : equalShares(p.panes.length);
  const sharesRef = useRef(shares);
  sharesRef.current = shares;
  const lefts = shares.map((_, i) => shares.slice(0, i).reduce((a, b) => a + b, 0));

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
      showHere(name);
    } catch (e) {
      props.onNotice(`Couldn't start a session: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };
  props.actions.current = {
    newClaude: () => void start({}),
    // At the drop point, or on the right when it's not over the terminal (or the tab just came forward).
    dropIn: (name, x, y) => {
      away.delete(name);
      const t = targetAt(x, y);
      onPanes((q) => (t ? dropAt(q, name, t.at, t.side) : q.panes.length ? dropAt(q, name, q.panes.length - 1, "right") : show(q, name)));
    },
    release: (name) => {
      away.add(name);
      closeSplit(name);
    },
    // Uploads them to ~/.blimp/uploads under plain names, then types their paths in, as a paste:
    // Claude reads a file (a screenshot, say) from a path in the prompt.
    dropFiles: async (name, items) => {
      const api = link.api;
      if (!api || !link.home || !items.length) return;
      const dir = `${link.home}/${UPLOADS}`;
      // Each folder of the path (409 once it's there).
      for (let i = 1; i <= UPLOADS.split("/").length; i++) await api.fsMkdir(`${link.home}/${UPLOADS.split("/").slice(0, i).join("/")}`).catch(() => {});
      const taken = new Set((await api.fsList(dir).catch(() => ({ entries: [] }))).entries.map((e) => e.name));
      const paths: string[] = [];
      for (const item of items) {
        const as = freeName(plainName(item.name), taken);
        taken.add(as);
        const path = await upload(link, dir, item, "new", as);
        if (path) paths.push(path);
      }
      if (paths.length) pastes.get(name)?.(paths.join(" ") + " ");
    },
  };

  const showHere = (name: string) => {
    away.delete(name);
    onPanes((q) => show(q, name));
  };

  const moveOut = (names: string[], at?: { x: number; y: number }) => {
    setCtx(null);
    for (const n of names) away.add(n);
    onPanes((q) => names.reduce((acc, n) => (acc.panes.includes(n) ? removePane(acc, acc.panes.indexOf(n)) : acc), q));
    props.onMoveOut(names, at);
  };

  const end = async (s: Session) => {
    setConfirm(null);
    if (!api) return;
    try {
      await api.endSession(s.name);
      // The re-render this causes closes its split (the effect above), with `ended` up to date.
      ended.add(s.name);
      setMounted((m) => m.filter((n) => n !== s.name));
    } catch (e) {
      props.onNotice(`Couldn't end ${s.title}: ${errorText(e)}`);
    }
  };

  // An idle Claude session ends at once: nothing is lost, its conversation can be resumed.
  // Anything that may be busy (working, waiting, a shell) asks first.
  const trash = (s: Session) => (s.kind === "claude" && s.state === "done" ? void end(s) : setConfirm(s.name));

  const past = convs ? earlier(convs, running) : [];

  // Ports the folder's sessions listen on. One that opens while the pane is up is announced
  // (not the ones already open when it first loads), until opened, closed or 20 s pass.
  const ports = link.ports.filter((x) => running.some((s) => s.name === x.session));
  const seenPorts = useRef<Set<number> | null>(null);
  const [fresh, setFresh] = useState<Port | null>(null);
  const portsKey = ports.map((x) => x.port).join(",");
  useEffect(() => {
    if (!loaded || !link.portsKnown) return;
    if (!seenPorts.current) return void (seenPorts.current = new Set(ports.map((x) => x.port)));
    const added = ports.find((x) => !seenPorts.current!.has(x.port));
    for (const x of ports) seenPorts.current.add(x.port);
    if (added) setFresh(added);
    else if (fresh && !ports.some((x) => x.port === fresh.port)) setFresh(null);
  }, [portsKey, loaded, link.portsKnown]);
  useEffect(() => {
    if (!fresh) return;
    const t = setTimeout(() => setFresh(null), 20_000);
    return () => clearTimeout(t);
  }, [fresh]);

  const focusOn = (name: string) =>
    onPanes((q) => {
      const i = q.panes.indexOf(name);
      return i >= 0 && i !== q.focus ? { panes: q.panes, focus: i } : q;
    });
  const closeSplit = (name: string) =>
    onPanes((q) => {
      const i = q.panes.indexOf(name);
      return i >= 0 ? removePane(q, i) : q;
    });

  // Where a drag at (x, y) in the window would land: a half of the split under it.
  const targetAt = (x: number, y: number): Drag["target"] => {
    const r = terms.current?.getBoundingClientRect();
    if (!r || !r.width || x < r.left || x > r.right || y < r.top || y > r.bottom) return null;
    return dropTarget(sharesRef.current, (x - r.left) / r.width);
  };

  // Dragging a running session, from its row or its split's header (pointer events, not HTML
  // drag and drop, which WebKit and Tauri's own file drop handling make unreliable). Let go over
  // the terminal: a split there. Let go outside the window: to the blimp window there, or a new
  // window (the pointer stays captured, so the page sees where). Esc cancels.
  const startDrag = (e: ReactPointerEvent, s: Session) => {
    if (e.button !== 0) return;
    dragged.current = false;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {}
    const x0 = e.clientX;
    const y0 = e.clientY;
    const label = s.kind === "shell" ? s.name : s.title;
    let on = false;
    const done = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", done);
      window.removeEventListener("keydown", key, true);
      document.body.classList.remove("dragging-session");
      endDrag.current = () => {};
      setDrag(null);
    };
    const move = (ev: PointerEvent) => {
      if (!on && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
      if (!on) document.body.classList.add("dragging-session");
      on = true;
      setDrag({ name: s.name, label, x: ev.clientX, y: ev.clientY, target: targetAt(ev.clientX, ev.clientY) });
    };
    const up = (ev: PointerEvent) => {
      done();
      if (!on) return;
      dragged.current = true;
      if (ev.clientX < 0 || ev.clientY < 0 || ev.clientX >= innerWidth || ev.clientY >= innerHeight) return moveOut([s.name], { x: ev.screenX, y: ev.screenY });
      const t = targetAt(ev.clientX, ev.clientY);
      if (t) {
        away.delete(s.name);
        onPanes((q) => dropAt(q, s.name, t.at, t.side));
        props.onTake(s.name);
      }
    };
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      dragged.current = on;
      done();
    };
    endDrag.current();
    endDrag.current = done;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", done);
    window.addEventListener("keydown", key, true);
  };

  const split = p.panes.length > 1;
  const sessionOf = (name: string) => running.find((x) => x.name === name);
  const openMenu = (e: ReactMouseEvent, name: string) => {
    e.preventDefault();
    e.stopPropagation();
    setCtx({ name, x: e.clientX, y: e.clientY });
  };
  const titleOf = (name: string) => {
    const s = running.find((x) => x.name === name);
    return s ? (s.kind === "shell" ? s.name : s.title) : name;
  };
  const t = drag?.target;
  const half = t && p.panes.length ? shares[t.at] / 2 : 1;
  const overlay = t && { left: (p.panes.length ? lefts[t.at] + (t.side === "right" ? half : 0) : 0) * 100, width: half * 100 };

  // The splits on screen come first in the list, in their left-to-right order, joined as a group
  // and numbered as their headers are. (One split alone stays where it is.)
  const group = split ? p.panes.map(sessionOf).filter((x): x is Session => !!x) : [];
  const rest = running.filter((s) => !group.includes(s));
  const row = (s: Session, num?: number) => {
    const far = !p.panes.includes(s.name) && props.elsewhere(s.name);
    return (
      <div
        key={s.name}
        data-session={s.name}
        className={
          "srow" +
          (s.name === p.panes[p.focus] ? " selected" : p.panes.includes(s.name) ? " shown" : "") +
          (link.status !== "connected" ? " stale" : "") +
          (drag?.name === s.name ? " dragging" : "") +
          (far ? " elsewhere" : "")
        }
        title={`${s.kind === "shell" ? "Shell" : s.title}\n${s.name}${STATE_LABEL[s.state] ? ` · ${STATE_LABEL[s.state]}` : ""}${far ? "\nIn another window: click to go there" : ""}\nDrag onto the terminal to split, or out of the window; right-click for more`}
        onContextMenu={(e) => openMenu(e, s.name)}
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
            <button
              className="srow-main"
              onPointerDown={(e) => startDrag(e, s)}
              onClick={async () => {
                if (dragged.current) return void (dragged.current = false);
                if (far && (await props.onFocusElsewhere(s.name))) return;
                showHere(s.name);
              }}
            >
              <Mark s={s} />
              {num && <span className="split-num">{num}</span>}
              <span className="srow-title">{s.kind === "shell" ? s.name : s.title}</span>
              {far && (
                <svg className="srow-away" width="14" height="14" viewBox="0 0 16 16" aria-label="In another window">
                  <path d="M5.5 2.5h8v7h-8zM2.5 6.5v7h8" fill="none" stroke="currentColor" />
                </svg>
              )}
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
    );
  };

  return (
    <div className="tpane" ref={box}>
      <div className="tpane-terms" ref={terms}>
        {/* Every mounted terminal stays in this one parent, placed by its split, so moving a
            session between splits never remounts it (that would drop its scrollback). */}
        {mounted.map((name) => {
          const i = p.panes.indexOf(name);
          return (
            <div
              key={name}
              className={"tsplit" + (split ? " grouped" : "") + (split && i === p.focus ? " focused" : "")}
              data-split={name}
              hidden={i < 0}
              style={i >= 0 ? { left: `${lefts[i] * 100}%`, width: `${shares[i] * 100}%` } : undefined}
              onFocus={() => focusOn(name)}
              onMouseDown={() => focusOn(name)}
            >
              {split && (
                <div
                  className="tsplit-head"
                  title="Drag to move it, or out of the window; right-click for more"
                  onPointerDown={(e) => {
                    const s = sessionOf(name);
                    if (s && !(e.target as Element).closest("button")) startDrag(e, s);
                  }}
                  onContextMenu={(e) => openMenu(e, name)}
                >
                  <span className="split-num">{i + 1}</span>
                  <span className="tsplit-title">{titleOf(name)}</span>
                  <button className="tab-close" title="Close split (the session keeps running)" aria-label={`Close split: ${titleOf(name)}`} onClick={() => closeSplit(name)}>
                    ×
                  </button>
                </div>
              )}
              <div className="tsplit-body">
                <TerminalView
                  link={link}
                  name={name}
                  dir={dir}
                  visible={i >= 0}
                  focused={props.front && i === p.focus}
                  onOpenPath={props.onOpenPath}
                  pastes={pastes}
                  onClose={() => {
                    setMounted((m) => m.filter((n) => n !== name));
                    closeSplit(name);
                  }}
                />
              </div>
            </div>
          );
        })}
        {shares.slice(1).map((_, i) => (
          <div key={i} className="tsplit-divider" style={{ left: `${lefts[i + 1] * 100}%` }}>
            <Splitter
              label="Resize split"
              onDrag={(x) => {
                const r = terms.current!.getBoundingClientRect();
                setSizes({ names: shown, shares: moveDivider(shares, i, (x - r.left) / r.width, Math.min(0.45, MIN_SPLIT_PX / r.width)) });
              }}
            />
          </div>
        ))}
        {overlay && <div className="drop-zone" style={{ left: `${overlay.left}%`, width: `${overlay.width}%` }} />}
        {fresh && props.front && (
          <div className="port-notice" role="status">
            <span>
              Port {fresh.port} is open <span className="port-by">({fresh.command} in {titleOf(fresh.session)})</span>
            </span>
            <button
              onClick={() => {
                props.onOpenPort(fresh);
                setFresh(null);
              }}
            >
              Open
            </button>
            <button className="tab-close" aria-label="Dismiss" onClick={() => setFresh(null)}>
              ×
            </button>
          </div>
        )}
        {loaded && !p.panes.length && (
          <div className="empty-center">
            <p>{live.length ? "Pick a session on the right, or start one." : "No session in this folder."}</p>
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
      {props.showList && (
        <Splitter label="Resize sessions" onDrag={(x) => setListWidth(clamp(box.current!.getBoundingClientRect().right - x, 160, 520))} />
      )}
      <nav className="slist" aria-label="Sessions" hidden={!props.showList} style={{ width: listWidth }}>
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
          {group.length > 1 && (
            <div className="sgroup" role="group" aria-label="Side by side">
              {group.map((s, i) => row(s, i + 1))}
            </div>
          )}
          {rest.map((s) => row(s))}
          {loaded && running.length === 0 && <p className="slist-note">Nothing running here.</p>}
          {ports.length > 0 && <div className="slist-label">Ports</div>}
          {ports.map((x) => (
            <button
              key={x.port}
              className="srow-main port-row"
              title={`Open localhost:${x.port} in a tab\n${x.command} in ${titleOf(x.session)}`}
              onClick={() => {
                props.onOpenPort(x);
                if (fresh?.port === x.port) setFresh(null);
              }}
            >
              <span className="srow-mark port-mark" aria-hidden>
                ⇄
              </span>
              <span className="srow-title">localhost:{x.port}</span>
              <span className="srow-time">{x.command}</span>
            </button>
          ))}
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
      {drag && (
        <div className="drag-ghost" style={{ left: drag.x + 12, top: drag.y + 10 }}>
          {drag.label}
        </div>
      )}
      {ctx && (
        <>
          <div
            className="menu-scrim"
            onClick={() => setCtx(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setCtx(null);
            }}
          />
          <div className="menu context-menu" role="menu" style={{ left: Math.min(ctx.x, innerWidth - 240), top: Math.min(ctx.y, innerHeight - 90) }} onKeyDown={(e) => e.key === "Escape" && setCtx(null)}>
            <button role="menuitem" autoFocus onClick={() => moveOut([ctx.name])}>
              Open in New Window
            </button>
            {split && p.panes.includes(ctx.name) && (
              <button role="menuitem" onClick={() => moveOut(p.panes)}>
                Open All Splits in New Window
              </button>
            )}
          </div>
        </>
      )}
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
