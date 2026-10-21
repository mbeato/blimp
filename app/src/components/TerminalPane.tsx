import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { Conversation, Kind, Port, Session } from "../lib/api";
import { errorText, type ServerLink } from "../lib/connection";
import { dropAt, dropTarget, equalShares, forget, moveDivider, prune, removePane, show, unsplit, type Panes, type Side } from "../lib/panes";
import { freeName, pastedImages, plainName, upload, type Item } from "../lib/transfers";
import { earlier, folderSessions, hasState, isClaude, lastActivity, listItems, moveItem, pickSession, sessionReference, sessionTitle } from "../lib/sessions";
import { dragHover } from "../lib/place";
import { relTime } from "../lib/time";
import { Splitter } from "./Splitter";
import { TerminalView } from "./TerminalView";
import { StateMark } from "./StateMark";
import { InboxSummary } from "./InboxSummary";
import { inbox } from "../lib/inbox";
import { contextMeter, handoffNews, handoffWords } from "../lib/handoff";

// Things the window reaches into the pane for: ⌘N, a kind of session started from elsewhere
// (Settings' Codex sign-in), and a session dropped here from another window at (x, y) in the page.
// release: another window took the session into one of its splits, so stop showing it here.
// dropFiles: files from Finder let go on a session's terminal.
// targets / send: a browser tab's Send to session (the folder's sessions, the focused split's
// first; a page's file pasted into one after a line saying where it's from).
export type PaneActions = {
  newClaude: () => void;
  startKind: (kind: string) => void;
  dropIn: (name: string, x: number, y: number) => void;
  release: (name: string) => void;
  dropFiles: (name: string, items: Item[]) => void;
  targets: () => { name: string; title: string }[];
  // Pastes text into a session's prompt (a browser tab's Send to session).
  send: (name: string, text: string) => Promise<void>;
};
export const noActions: PaneActions = {
  newClaude: () => {},
  startKind: () => {},
  dropIn: () => {},
  release: () => {},
  dropFiles: () => {},
  targets: () => [],
  send: async () => {},
};

const EARLIER_KEY = "blimp.earlierOpen";

// Where files dropped on a terminal go on the server.
const UPLOADS = ".blimp/uploads";

const STATE_LABEL: Record<Session["state"], string> = {
  working: "Working",
  waiting: "Waiting for you",
  done: "Idle",
  unknown: "",
};

// The chevron's kinds until the server's list comes (or if it can't be had).
const FALLBACK_KINDS: Kind[] = [
  { id: "claude", label: "Claude Code", available: true },
  { id: "shell", label: "Shell", available: true },
];

// No split narrower than this.
const MIN_SPLIT_PX = 160;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

// A running session's row says what it's doing under its title: its state, else its kind; and
// the kind's label (GLM, Codex, or one of the user's own) beside it.
const doing = (s: Session) => STATE_LABEL[s.state] || (s.kind === "shell" ? "Shell" : isClaude(s) ? "Claude Code" : "");

// A session being dragged from the list, and where it would land.
// The row (or split header) being dragged is drawn at the pointer, as grabbed: (dx, dy) from
// its corner, w by h. out: the pointer is outside the window (the window under it draws it).
// gap: over the list, the gap between its rows it would drop in (the row, with its whole group).
type Drag = {
  s: Session;
  label: string;
  x: number;
  y: number;
  dx: number;
  dy: number;
  w: number;
  h: number;
  row: boolean;
  out: boolean;
  target: { at: number; side: Side } | null;
  gap: number | null;
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

// The bottom pane: the folder's sessions in terminal splits, side by side, and on their right
// the list of them, as `claude --resume` scopes them: running ones (with their state), then
// earlier conversations. Dragging a running session from the list onto a terminal splits it.
// panes: the splits, kept by the window's tab (it's in the URL); onPanes updates them.
// front: this tab is the one in front. showList: the list's show/hide button.
// onMoveOut: sessions leaving for another window (right-click > Open in New Window, or a drag let
// go outside the window at a point on screen); the pane then stops showing them.
// elsewhere: another window of this app shows the session. It's listed only there, and never picked
// to fill a terminal here. onTake: a session shown here on purpose (a click, a drag, a drop from
// another window); App has any other window showing it let it go.
export function TerminalPane(props: {
  link: ServerLink;
  dir: string;
  panes: Panes;
  onPanes: (f: (p: Panes) => Panes) => void;
  front: boolean;
  showList: boolean;
  onOpenPath: (path: string, line?: number, col?: number) => void;
  onOpenUrl: (url: string) => void;
  onNotice: (msg: string) => void;
  onMoveOut: (names: string[], at?: { x: number; y: number }) => void;
  elsewhere: (name: string) => boolean;
  onTake: (name: string) => void;
  // A session dragged in another window is over this pane's window, here (page pixels): show
  // where it would land.
  hoverAt?: { x: number; y: number } | null;
  // A port a session here listens on: open it in a browser tab.
  onOpenPort: (p: Port) => void;
  // The chevron's "Models and keys…": Settings, at Models.
  onModels: () => void;
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
  // The server's kinds of session, fetched each time the chevron opens.
  const [kinds, setKinds] = useState<Kind[] | null>(null);
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
  const scroll = useRef<HTMLDivElement>(null);
  // Ended from here: still listed until the server's next update, but not to be shown again.
  const ended = useRef(new Set<string>()).current;
  // A drag ends with a pointerup on the row it started from: that click isn't a click.
  const dragged = useRef(false);
  // Ends a drag in progress: also when the tab closes mid-drag.
  const endDrag = useRef(() => {});
  useEffect(() => () => endDrag.current(), []);
  // Continue in New Session, asked for here: by session, whether its handoff was seen being written.
  const handing = useRef(new Map<string, boolean>()).current;

  const isRunning = (name: string) => running.some((s) => s.name === name);
  for (const name of pending.keys()) if (isRunning(name) || Date.now() - pending.get(name)! > 15_000) pending.delete(name);
  for (const name of ended) if (loaded && !isRunning(name)) ended.delete(name);
  const alive = (name: string) => !ended.has(name) && (isRunning(name) || pending.has(name));
  const live = running.filter((s) => !ended.has(s.name));

  // Splits whose session ended close; with none left, show another one of this folder's.
  const fill = (q: Panes) => {
    const next = prune(q, alive);
    const pick = next.panes.length ? null : pickSession(live.filter((s) => !away.has(s.name) && !props.elsewhere(s.name)));
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

  const start = async (body: { kind?: string; resume?: string }) => {
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
    startKind: (kind) => void start({ kind }),
    // At the drop point, or on the right when it's not over the terminal (or the tab just came forward).
    dropIn: (name, x, y) => {
      away.delete(name);
      props.onTake(name);
      const t = targetAt(x, y);
      onPanes((q) => (t ? dropAt(q, name, t.at, t.side) : q.panes.length ? dropAt(q, name, q.panes.length - 1, "right") : show(q, name)));
    },
    release: (name) => {
      away.add(name);
      onPanes((q) => forget(q, [name]));
    },
    // Uploads them to ~/.blimp/uploads under plain names, then types their paths in, as a paste:
    // Claude reads a file (a screenshot, say) from a path in the prompt.
    dropFiles: (name, items) => void uploadInto(name, items),
    targets: () => {
      const focused = p.panes[p.focus];
      const list = listed.filter((s) => !ended.has(s.name));
      return [...list.filter((s) => s.name === focused), ...list.filter((s) => s.name !== focused)].map((s) => ({ name: s.name, title: sessionTitle(s) }));
    },
    // On one line, so a shell doesn't run it. A session not on screen is shown first (its
    // terminal takes the paste once it's up).
    send: async (name, text) => {
      if (!pastes.has(name)) showHere(name);
      for (let i = 0; i < 50 && !pastes.has(name); i++) await new Promise((r) => setTimeout(r, 100));
      pastes.get(name)?.(text);
    },
  };

  const uploadInto = async (name: string, items: Item[]) => {
    const paths = await uploadAll(items);
    if (paths.length) pastes.get(name)?.(paths.join(" ") + " ");
  };

  const uploadAll = async (items: Item[]): Promise<string[]> => {
    const api = link.api;
    if (!api || !link.home || !items.length) return [];
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
    return paths;
  };

  // Claude writes a handoff; once the new session has started (lib/handoff.ts), it opens in a split to
  // the right of this one. A handoff that fails says why.
  const handOff = async (s: Session) => {
    setCtx(null);
    if (!api) return props.onNotice("Not connected.");
    handing.set(s.name, false);
    try {
      await api.handoff(s.name);
    } catch (e) {
      handing.delete(s.name);
      props.onNotice(`Couldn't continue in a new session: ${errorText(e)}`);
    }
  };
  const handoffs = (link.sessions ?? []).map((s) => (s.handoff ? `${s.name}:${s.handoff.state}` : "")).join(",");
  useEffect(() => {
    if (!handing.size || !link.sessions) return;
    for (const n of handoffNews(handing, link.sessions)) {
      const child = n.child;
      if (!child) {
        props.onNotice(`The handoff didn't finish: ${n.error}`);
        continue;
      }
      pending.set(child, Date.now());
      away.delete(child);
      props.onTake(child);
      onPanes((q) => {
        const i = q.panes.indexOf(n.parent);
        return q.panes.length ? dropAt(q, child, i >= 0 ? i : q.panes.length - 1, "right") : show(q, child);
      });
    }
  }, [handoffs]);

  const showHere = (name: string) => {
    away.delete(name);
    props.onTake(name);
    onPanes((q) => show(q, name));
  };

  const moveOut = (names: string[], at?: { x: number; y: number }) => {
    setCtx(null);
    for (const n of names) away.add(n);
    onPanes((q) => forget(q, names));
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
  const trash = (s: Session) => (isClaude(s) && s.state === "done" ? void end(s) : setConfirm(s.name));

  const past = convs ? earlier(convs, running) : [];
  // Earlier conversations fold away (folded at first); the choice is kept on this computer.
  const [showEarlier, setShowEarlier] = useState(() => {
    try {
      return localStorage.getItem(EARLIER_KEY) === "open";
    } catch {
      return false;
    }
  });
  const toggleEarlier = () =>
    setShowEarlier((o) => {
      try {
        localStorage.setItem(EARLIER_KEY, o ? "closed" : "open");
      } catch {}
      return !o;
    });

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
      return i >= 0 && i !== q.focus ? { ...q, focus: i } : q;
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

  // The list's row (a session, or a split group) that has this session.
  const itemOf = (name: string) => itemsRef.current.findIndex((it) => (Array.isArray(it) ? it.some((x) => x.name === name) : it.name === name));

  // Over the list at (x, y): the gap between its rows a drag would drop in (0: above the first,
  // the row count: below the last), as long as that moves the row. Never inside a group: a group's
  // rows are one row here.
  const gapAt = (name: string, x: number, y: number): number | null => {
    const el = scroll.current;
    const r = el?.getBoundingClientRect();
    if (!el || !r || !r.width || x < r.left || x > r.right || y < r.top || y > r.bottom) return null;
    const from = itemOf(name);
    if (from < 0) return null;
    const rows = [...el.querySelectorAll(":scope > [data-item]")];
    const i = rows.findIndex((row) => {
      const b = row.getBoundingClientRect();
      return y < b.top + b.height / 2;
    });
    const gap = i < 0 ? rows.length : i;
    return gap === from || gap === from + 1 ? null : gap;
  };

  // Dragging a running session, from its row or its split's header (pointer events, not HTML
  // drag and drop, which WebKit and Tauri's own file drop handling make unreliable). Let go over
  // the terminal: a split there. Let go in the list: its row (with its whole group, if it's in
  // one) moves to that gap, and stays there. Let go outside the window: to the blimp window there,
  // or a new window (the pointer stays captured, so the page sees where). Esc cancels.
  const startDrag = (e: ReactPointerEvent, s: Session) => {
    if (e.button !== 0) return;
    dragged.current = false;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {}
    const x0 = e.clientX;
    const y0 = e.clientY;
    const label = sessionTitle(s);
    const from = e.currentTarget.closest(".srow, .tsplit-head") ?? e.currentTarget;
    const box = from.getBoundingClientRect();
    const grab = { dx: Math.min(x0 - box.left, 260 - 16), dy: y0 - box.top, w: Math.min(box.width, 260), h: box.height, row: from.classList.contains("srow") };
    const place = { server: link.key, dir, session: s.name };
    let on = false;
    let out = false;
    const done = () => {
      if (out) dragHover(null);
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
      const was = out;
      out = ev.clientX < 0 || ev.clientY < 0 || ev.clientX >= innerWidth || ev.clientY >= innerHeight;
      if (out) dragHover({ p: place, label, x: ev.screenX, y: ev.screenY });
      else if (was) dragHover(null);
      setDrag({ s, label, x: ev.clientX, y: ev.clientY, ...grab, out, target: targetAt(ev.clientX, ev.clientY), gap: out ? null : gapAt(s.name, ev.clientX, ev.clientY) });
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
      const gap = gapAt(s.name, ev.clientX, ev.clientY);
      if (gap !== null) {
        const order = moveItem(itemsRef.current, itemOf(s.name), gap);
        onPanes((q) => ({ ...q, order }));
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
    return s ? sessionTitle(s) : name;
  };
  // A drag of this pane's own, or one from another window over this one (props.hoverAt).
  const t = drag ? drag.target : props.hoverAt ? targetAt(props.hoverAt.x, props.hoverAt.y) : null;
  const half = t && p.panes.length ? shares[t.at] / 2 : 1;
  const overlay = t && { left: (p.panes.length ? lefts[t.at] + (t.side === "right" ? half : 0) : 0) * 100, width: half * 100 };

  // Newest first. The splits on screen are joined as a group, in their left-to-right order and
  // numbered as their headers are; kept split groups the same way but dimmer (a click on one
  // brings its group back). Each group sits where its newest session would be.
  // A session another window shows is listed only there (unless it's in a split here too).
  const listed = running.filter((s) => p.panes.includes(s.name) || !props.elsewhere(s.name));
  const toSessions = (g: string[]) => g.map((n) => listed.find((x) => x.name === n)).filter((x): x is Session => !!x);
  const group = split ? toSessions(p.panes) : [];
  const kept = p.groups.map(toSessions).filter((g) => g.length > 1);
  const items = listItems(listed, group.length > 1 ? [group, ...kept] : kept, p.order);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  // The row being dragged within the list (with its whole group).
  const moving = drag && drag.gap !== null ? itemOf(drag.s.name) : -1;
  const row = (s: Session, num?: number, item?: number) => {
    const meter = contextMeter(s.context);
    const parent = s.parent ? link.sessions?.find((x) => x.name === s.parent) : undefined;
    return (
      <div
        key={s.name}
        data-session={s.name}
        data-item={item}
        className={
          "srow" +
          (s.name === p.panes[p.focus] ? " selected" : p.panes.includes(s.name) ? " shown" : "") +
          (link.status !== "connected" ? " stale" : "") +
          (drag?.s.name === s.name ? " dragging" : "")
        }
        title={`${s.kind === "shell" ? "Shell" : sessionTitle(s)}${s.label ? ` · ${s.label}` : ""}\n${s.name}${STATE_LABEL[s.state] ? ` · ${STATE_LABEL[s.state]}` : ""}${meter ? `\n${meter.label}` : ""}\nDrag onto the terminal to split, or out of the window; right-click for more`}
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
              onClick={() => {
                if (dragged.current) return void (dragged.current = false);
                showHere(s.name);
              }}
            >
              <Mark s={s} />
              {num && <span className="split-num">{num}</span>}
              <span className="srow-title">
                {s.parent && (
                  <span className="srow-parent" title={`Continued from ${parent ? sessionTitle(parent) : s.parent}`}>
                    ↳{" "}
                  </span>
                )}
                {sessionTitle(s)}
              </span>
              <span className="srow-side">
                <span className="srow-time">{relTime(lastActivity(s), now)}</span>
                <Doing s={s} />
              </span>
            </button>
            <button className="srow-trash" title="End session" aria-label={`End ${sessionTitle(s)}`} onClick={() => trash(s)}>
              <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
                <path d="M2.5 4.5h11M6 4.5V2.5h4v2M4 4.5l.7 9h6.6l.7-9M6.8 7v4.5M9.2 7v4.5" fill="none" stroke="currentColor" />
              </svg>
            </button>
            {meter && <span className={"ctx-meter" + (meter.high ? " high" : "")} style={{ width: `${meter.width}%` }} role="img" aria-label={meter.label} />}
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
                  {sessionOf(name)?.label && <span className="kind-label">{sessionOf(name)!.label}</span>}
                  <button className="tab-close" title="Close split (the session keeps running)" aria-label={`Close split: ${titleOf(name)}`} onClick={() => closeSplit(name)}>
                    ×
                  </button>
                </div>
              )}
              <div
                className="tsplit-body"
                // A screenshot on the clipboard goes up like a dropped file, its path typed in. Caught
                // before xterm's own paste, which would type nothing for an image.
                onPasteCapture={(e) => {
                  const items = pastedImages([...e.clipboardData.files], e.clipboardData.types.includes("text/plain"));
                  if (!items.length) return;
                  e.preventDefault();
                  e.stopPropagation();
                  void uploadInto(name, items);
                }}
              >
                <TerminalView
                  link={link}
                  name={name}
                  dir={dir}
                  visible={i >= 0}
                  focused={props.front && i === p.focus}
                  onOpenPath={props.onOpenPath}
                  onOpenUrl={props.onOpenUrl}
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
              <button disabled={!api || busy} onClick={() => void start({ kind: "shell" })}>
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
            {/* + starts a Claude session at once; the chevron beside it has the other kinds. */}
            <button className="icon-button small" title="New Claude session (⌘N)" aria-label="New Claude session" disabled={!api || busy} onClick={() => void start({})}>
              +
            </button>
            <button className="icon-button small new-more" title="More kinds of session" aria-label="More kinds of session" aria-expanded={menu}
              disabled={!api}
              onClick={() => {
                if (!menu) api?.kinds().then(setKinds, () => {});
                setMenu(!menu);
              }}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                <path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" />
              </svg>
            </button>
            {menu && (
              <>
                <div className="menu-scrim" onClick={() => setMenu(false)} />
                <div className="menu kinds-menu" role="menu">
                  {/* Every kind the server knows; one that can't start here is greyed, saying why. */}
                  {(kinds ?? FALLBACK_KINDS).map((k) => (
                    <button key={k.id} role="menuitem" disabled={!k.available || busy} title={k.note} onClick={() => void start({ kind: k.id })}>
                      <span className="menu-label">
                        {k.label}
                        {k.note && <span className="menu-note">{k.note}</span>}
                      </span>
                      {k.id === "claude" && <span className="menu-key">⌘N</span>}
                    </button>
                  ))}
                  <div className="menu-sep" role="separator" />
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMenu(false);
                      props.onModels();
                    }}
                  >
                    Models and keys…
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
        <div className="slist-scroll" ref={scroll}>
          <InboxSummary inbox={inbox(listed, past)} disabled={busy || !api} onSession={(s) => showHere(s.name)} onPast={(c) => void start({ resume: c.sessionId })} />
          {/* Each row (a session, or a split group) is one data-item: a drag drops between them. */}
          {items.flatMap((it, n) => [
            drag?.gap === n ? <div key="drop" className="slist-drop" aria-hidden /> : null,
            !Array.isArray(it) ? (
              row(it, undefined, n)
            ) : (
              <div
                key={it.map((s) => s.name).join("\n")}
                data-item={n}
                className={"sgroup" + (it === group ? "" : " kept") + (moving === n ? " moving" : "")}
                role="group"
                aria-label={it === group ? "Side by side" : "Side by side, not on screen"}
              >
                {it.map((s, i) => row(s, i + 1))}
              </div>
            ),
          ])}
          {drag?.gap === items.length && <div className="slist-drop" aria-hidden />}
          {loaded && listed.length === 0 && <p className="slist-note">Nothing running here.</p>}
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
          {past.length > 0 && (
            <button className="slist-label slist-fold" aria-expanded={showEarlier} onClick={() => toggleEarlier()}>
              <span className={"tree-twisty" + (showEarlier ? " open" : "")}>›</span>
              Earlier <span className="slist-count">{past.length}</span>
            </button>
          )}
          {showEarlier && past.map((c) => (
            <button key={c.sessionId} className="srow-main earlier" disabled={busy || !api} title={`Resume: ${c.title}`} onClick={() => void start({ resume: c.sessionId })}>
              <span className="srow-mark" aria-label={c.unread ? "New reply" : undefined}>{c.unread && <span className="unread-dot" />}</span>
              <span className="srow-title">{c.title}</span>
              <span className="srow-time">{relTime(c.updatedAt, now)}</span>
            </button>
          ))}
        </div>
      </nav>
      {drag && !drag.out && <DragGhost s={drag.s} label={drag.label} x={drag.x - drag.dx} y={drag.y - drag.dy} w={drag.w} h={drag.h} tall={drag.row} />}
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
          <div className="menu context-menu" role="menu" style={{ left: Math.min(ctx.x, innerWidth - 240), top: Math.min(ctx.y, innerHeight - 180) }} onKeyDown={(e) => e.key === "Escape" && setCtx(null)}>
            <button role="menuitem" autoFocus onClick={() => moveOut([ctx.name])}>
              Open in New Window
            </button>
            {split && p.panes.includes(ctx.name) && (
              <button role="menuitem" onClick={() => moveOut(p.panes)}>
                Open All Splits in New Window
              </button>
            )}
            {((split && p.panes.includes(ctx.name)) || p.groups.some((g) => g.includes(ctx.name))) && (
              <button role="menuitem" onClick={() => (setCtx(null), onPanes((q) => unsplit(q, ctx.name)))}>
                Unsplit
              </button>
            )}
            {sessionOf(ctx.name) && (
              <button role="menuitem" title="For another session: its Claude can read this one's conversation and send it a message" onClick={() => (setCtx(null), void navigator.clipboard.writeText(sessionReference(sessionOf(ctx.name)!)).catch(() => {}))}>
                Copy Reference
              </button>
            )}
            {sessionOf(ctx.name) && isClaude(sessionOf(ctx.name)!) && (
              <button role="menuitem" disabled={sessionOf(ctx.name)!.handoff?.state === "writing"} title="Claude writes down where the work stands, then a new session picks it up from there"
                onClick={() => void handOff(sessionOf(ctx.name)!)}
              >
                Continue in New Session
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// A session row lifted off the list, under the pointer while it's dragged (also in the window a
// drag from another one is over, where `s` may not be known). h: as tall as what was grabbed;
// tall: a row of the list, with what the session is doing under its title.
export function DragGhost(props: { s?: Session; label: string; x: number; y: number; w: number; h?: number; tall?: boolean }) {
  return (
    <div className={"drag-ghost" + (props.tall && props.s ? " tall" : "")} style={{ left: props.x, top: props.y, width: props.w, height: props.h }} aria-hidden>
      <span className="srow-line">
        {props.s ? <Mark s={props.s} /> : <span className="srow-mark" />}
        <span className="srow-title">{props.label}</span>
      </span>
      {props.tall && props.s && <Doing s={props.s} />}
    </div>
  );
}

function Doing(props: { s: Session }) {
  const { s } = props;
  const words = handoffWords(s) ?? doing(s);
  return (
    <span className={"srow-doing state-" + s.state}>
      {words}
      {words && s.label && <span aria-hidden> · </span>}
      {s.label && <span className="kind-label">{s.label}</span>}
    </span>
  );
}

function Mark(props: { s: Session }) {
  const { s } = props;
  // A shell, or a kind without hooks, has no state (Claude's and Codex's hooks are where states come from).
  if (!hasState(s) && s.state === "unknown") return <span className="srow-mark shell" aria-label={s.label ?? "Shell"}>{">_"}</span>;
  return (
    <span className={"srow-mark state-" + s.state} aria-label={(s.state !== "waiting" && s.unread ? "New reply" : STATE_LABEL[s.state]) || undefined}>
      <StateMark s={s} />
    </span>
  );
}
