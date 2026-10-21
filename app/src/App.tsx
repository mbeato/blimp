import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { AddServerDialog } from "./components/AddServerDialog";
import { OpenFolderDialog } from "./components/OpenFolderDialog";
import { Palette } from "./components/Palette";
import { DragGhost, noActions, TerminalPane, type PaneActions } from "./components/TerminalPane";
import { SettingsDialog } from "./components/SettingsDialog";
import { TransferList } from "./components/TransferList";
import { UpdateBars } from "./components/UpdateBars";
import { Welcome } from "./components/Welcome";
import { Workbench, type FileDrop, type Opener, type PageOpener } from "./components/Workbench";
import { errorText, inTauri, loadServers, saveServers, serverKey, ServerLink, type Server } from "./lib/connection";
import { baseName, parentDir } from "./lib/files";
import type { Item } from "./lib/transfers";
import type { Panes } from "./lib/panes";
import {
  dropSession,
  focusProject,
  focusSession,
  onDragHover,
  onDropSession,
  onReleaseSession,
  onSelectSession,
  onShown,
  openWindow,
  projectKey,
  readLayout,
  restoreWindows,
  saveWindowLayout,
  setShown,
  setViewing,
  setWindowProjects,
  takeSession,
  windowLabel,
  type Hover,
  type Shown,
  setWindowTitle,
  writeLayout,
  type Place,
} from "./lib/place";
import { forgetProject, lastLayout, lastServer, rememberLayout, rememberProject } from "./lib/recent";
import { tildify } from "./lib/sessions";
import { closeTab, dropHomeTabs, homeTab, keepServers, moveTab, newLayout, openTab, releaseSession, setPageOrder, setPanes, tabKey, type Layout, type Show, type Tab } from "./lib/tabs";
import { startReorder } from "./lib/reorder";
import { getSettings, startSettings, useSettings } from "./lib/settings";
import { notify, setBadge, toMarkSeen, WaitWatcher } from "./lib/waiting";
import { jobsOpen, JobWatcher } from "./lib/jobs";

type DialogKind = "palette" | "open" | "add" | "settings" | null;

// One window: project tabs along the top (Home, the server's home folder, first), each laid out
// by its own Workbench. Every tab stays mounted while open, so its files and terminals survive
// switching. Several windows each run their own App; Rust shares the SSH tunnels between them.
export function App() {
  const [servers, setServers] = useState<Server[] | null>(null);
  // null until the servers have loaded, when a new start reopens the last tabs.
  const [layout, setLayout] = useState<Layout | null>(() => readLayout());
  const [dialog, setDialog] = useState<DialogKind>(null);
  // Settings opened at a section (the session chevron's "Models and keys…" opens it at Models).
  const [settingsAt, setSettingsAt] = useState<"models" | undefined>();
  const [notice, setNotice] = useState("");
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  // Per tab (by workbench key): ⌘-click's file opener and the terminal pane's actions (⌘N).
  const openers = useRef(new Map<string, { current: Opener }>()).current;
  const actions = useRef(new Map<string, { current: PaneActions }>()).current;
  const fileDrops = useRef(new Map<string, { current: FileDrop }>()).current;
  const pageOpeners = useRef(new Map<string, { current: PageOpener }>()).current;
  const refFor = <T,>(m: Map<string, { current: T }>, k: string, init: T) => {
    if (!m.has(k)) m.set(k, { current: init });
    return m.get(k)!;
  };

  // Links live outside React state: they are long-lived objects that mutate and call back.
  const links = useRef(new Map<string, ServerLink>()).current;
  const viewingRef = useRef<string[]>([]);
  const watcher = useRef<WaitWatcher | null>(null);
  // Settings > Notifications: the watcher still follows states, it just doesn't announce them.
  watcher.current ??= new WaitWatcher(
    (title, body, id) => getSettings().notifications && notify(title, body, id),
    () => ({ focused: document.hasFocus(), viewing: viewingRef.current }),
  );
  // A background job that finished: announced even for a session on screen, not while its jobs popover is.
  const jobWatcher = useRef<JobWatcher | null>(null);
  jobWatcher.current ??= new JobWatcher(
    (title, body, id) => getSettings().notifications && notify(title, body, id),
    (session) => document.hasFocus() && jobsOpen.current === session,
  );
  const settings = useSettings();
  // The sessions on screen in this window while it has focus are read, here and on the phone.
  const seenSent = useRef(new Map<string, number>()).current;
  const markSeen = (l: ServerLink) => {
    if (l.status !== "connected" || !l.sessions || !l.api) return;
    const api = l.api;
    for (const id of toMarkSeen(l.key, l.sessions, { focused: document.hasFocus(), viewing: viewingRef.current }, seenSent))
      void api.seen(id).catch(() => {});
  };
  const onLinkChange = useRef((l: ServerLink) => {
    if (l.status === "connected" && l.sessions) watcher.current!.update(l.key, l.home, l.sessions);
    if (l.status === "connected" && l.sessions) jobWatcher.current!.update(l.key, l.home, l.sessions);
    markSeen(l);
    rerender();
  }).current;

  useEffect(() => {
    void startSettings();
    // blimp > Settings… in the menu bar.
    let off = () => {};
    if (inTauri())
      void import("@tauri-apps/api/webviewWindow").then(({ getCurrentWebviewWindow }) =>
        getCurrentWebviewWindow()
          .listen("open-settings", () => setDialog("settings"))
          .then((f) => (off = f)),
      );
    return () => off();
  }, []);

  useEffect(() => {
    loadServers().then(
      async (list) => {
        const keys = list.map(serverKey);
        if (!layout && keys.length) {
          // A new start reopens the last run's windows (the Mac app; a browser has one), or opens
          // Home on the server used last.
          const saved = (await restoreWindows()) ?? (await lastLayout());
          const last = await lastServer();
          setLayout(keepServers(saved ?? newLayout(keys.includes(last ?? "") ? last! : keys[0]), keys));
        }
        setServers(list);
      },
      (e) => (setServers([]), setNotice(errorText(e))),
    );
    return () => links.forEach((l) => l.stop());
  }, []);

  // Start a link for every saved server, stop links for removed ones.
  useEffect(() => {
    if (!servers) return;
    const want = servers.map(serverKey);
    for (const [k, l] of links) if (!want.includes(k)) (l.stop(), links.delete(k));
    for (const s of servers) {
      if (links.has(serverKey(s))) continue;
      const l = new ServerLink(s, onLinkChange);
      links.set(l.key, l);
      l.start();
    }
    setLayout((l) => (l ? keepServers(l, want) : want.length ? newLayout(want[0]) : null));
    rerender();
  }, [servers]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  const linkList = (servers ?? []).map((s) => links.get(serverKey(s))).filter((l): l is ServerLink => !!l);
  // Home folders become known as servers answer.
  const homesKey = linkList.map((l) => l.home).join("\n");
  useEffect(() => setLayout((l) => l && dropHomeTabs(l, (s) => links.get(s)?.home || undefined)), [homesKey]);
  const connected = linkList.filter((l) => l.status === "connected");
  const rootOf = (t: Tab) => t.dir ?? (links.get(t.server)?.home || null);
  const front = layout ? layout.tabs[layout.active] : null;
  const link = front ? (links.get(front.server) ?? null) : null;
  const root = front ? rootOf(front) : null;

  // Only servers blimp can see right now: an offline server's last list may be long out of date.
  const waitingCount = connected.reduce((n, l) => n + (l.sessions?.filter((s) => s.state === "waiting").length ?? 0), 0);
  useEffect(() => void setBadge(settings.dockBadge ? waitingCount : 0), [waitingCount, settings.dockBadge]);

  // The URL keeps the tabs, so a reload stays put. For the next launch, the Mac app keeps every
  // window's tabs (and where the window is); a browser keeps its one window's.
  useEffect(() => {
    if (!layout) return;
    writeLayout(layout);
    if (inTauri()) saveWindowLayout(layout);
    else void rememberLayout(layout);
  }, [layout]);
  const projects = (layout?.tabs ?? []).map((t) => (rootOf(t) ? projectKey(t.server, rootOf(t)!) : "")).filter(Boolean);
  const projectsKey = projects.join("\t");
  useEffect(() => setWindowProjects(projects), [projectsKey]);
  useEffect(() => void setWindowTitle(root && front?.dir ? `${baseName(root)} — blimp` : "blimp"), [root, front?.dir]);

  // What this window shows (the front tab's splits), while it has focus: no notification for
  // those sessions from any window.
  const viewing = front ? front.panes.map((n) => `${front.server}/${n}`) : [];
  viewingRef.current = viewing;
  const viewingKey = viewing.join("\n");
  useEffect(() => {
    const sync = () => {
      setViewing(document.hasFocus() ? viewingRef.current : []);
      links.forEach(markSeen);
    };
    sync();
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    return () => {
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
    };
  }, [viewingKey]);

  // Sessions other windows show ("<server key>/<name>"): their rows say so, and a click there
  // brings that window forward instead of showing the session twice.
  const [elsewhere, setElsewhere] = useState<Set<string>>(new Set());
  const me = useRef<string | null>(null);
  // Another window took one of this window's sessions, or has one this window filled in on its own.
  const releasing = useRef<Promise<() => void> | null>(null);
  const others = (s: Shown) => new Set(Object.entries(s).flatMap(([label, keys]) => (label === me.current ? [] : keys)));
  const shownKey = (layout?.tabs ?? []).flatMap((t) => t.panes.map((n) => `${t.server}/${n}`)).join("\n");
  useEffect(() => {
    let live = true;
    void (async () => {
      me.current ??= await windowLabel();
      // Listening first: the answer to what this window shows can be to let one go (a launch, when
      // every window says what it shows at once), and an event sent before then is lost.
      await (releasing.current ??= onReleaseSession((key) => releaseRef.current(key)));
      const s = await setShown(shownKey ? shownKey.split("\n") : []);
      if (live) setElsewhere(others(s));
    })();
    return () => void (live = false);
  }, [shownKey]);
  useEffect(() => {
    let off = () => {};
    void onShown((s, label) => ((me.current = label), setElsewhere(others(s)))).then((f) => (off = f));
    return () => {
      off();
      void releasing.current?.then((f) => f());
      releasing.current = null;
    };
  }, []);
  const releaseRef = useRef((_: string) => {});
  releaseRef.current = (key) => {
    // The pane keeps it from filling an empty terminal with it again; the layout lets it go even
    // where there's no pane yet.
    for (const t of layout?.tabs ?? []) {
      const l = links.get(t.server);
      const r = rootOf(t);
      const name = key.startsWith(t.server + "/") ? key.slice(t.server.length + 1) : null;
      if (l && r && name && t.panes.includes(name)) actions.get(wbKey(l, r))?.current.release(name);
    }
    setLayout((l) => l && releaseSession(l, key));
  };

  // A folder as a tab's dir: null for the server's home folder (Home).
  const tabDir = (server: string, dir: string | null | undefined) => (!dir || dir === links.get(server)?.home ? null : dir);

  const open = (server: string, dir: string | null, session?: string) => {
    setDialog(null);
    if (session) takeSession(`${server}/${session}`);
    setLayout((l) => l && openTab(l, server, dir, session));
    if (dir) void rememberProject(server, dir);
  };

  // ⌘K in another window picked a session in a folder this window has a tab for.
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    let off = () => {};
    void onSelectSession((p) => p.server && openRef.current(p.server, tabDir(p.server, p.dir), p.session)).then((f) => (off = f));
    return () => off();
  }, []);

  // Opens a folder in a tab (or brings its tab forward).
  const openProject = async (l: ServerLink, d: string) => {
    setDialog(null);
    try {
      await l.api!.fsList(d);
    } catch (e) {
      return setNotice(`Couldn't open ${tildify(d, l.home)}: ${errorText(e)}`);
    }
    open(l.key, tabDir(l.key, d));
  };

  const newWindow = (p: Place = { server: link?.key }) => void openWindow(p);

  // Sessions of tab t leaving for another window: a drag let go at a point on screen (that
  // window, or a new one there), or Open in New Window (a new window with them split side by
  // side, in their folder's tab).
  const moveOut = (t: Tab, names: string[], at?: { x: number; y: number }) => {
    const dir = rootOf(t);
    if (!dir) return;
    if (at && names.length === 1) return void dropSession({ server: t.server, dir, session: names[0] }, at.x, at.y);
    const folder = { ...homeTab(t.server), dir: t.dir, panes: names };
    void openWindow(t.dir ? { tabs: [homeTab(t.server), folder], active: 1, show: layout!.show } : { tabs: [folder], active: 0, show: layout!.show });
  };

  // A session dragged here from another window, let go at (x, y): into its folder's tab, at that
  // point once the tab is in front (the pane places it after the render that shows the tab).
  const dropped = useRef<{ server: string; dir: string | null; name: string; x: number; y: number } | null>(null);
  const onDrop = useRef((_: Place, __: number, ___: number) => {});
  onDrop.current = (p, x, y) => {
    if (!p.server || !p.session) return;
    const dir = tabDir(p.server, p.dir);
    dropped.current = { server: p.server, dir, name: p.session, x, y };
    setLayout((l) => l && openTab(l, p.server!, dir));
    rerender();
  };
  useEffect(() => {
    let off = () => {};
    void onDropSession((p, x, y) => onDrop.current(p, x, y)).then((f) => (off = f));
    return () => off();
  }, []);
  // A session dragged in another window, over this one: drawn here, and where it would land.
  const [hover, setHover] = useState<Hover | null>(null);
  useEffect(() => {
    let off = () => {};
    void onDragHover(setHover).then((f) => (off = f));
    return () => off();
  }, []);
  useEffect(() => {
    const d = dropped.current;
    const l = d && links.get(d.server);
    const r = d && l && (d.dir ?? (l.home || null));
    if (!d || !l || !r) return;
    dropped.current = null;
    actions.get(wbKey(l, r))?.current.dropIn(d.name, d.x, d.y);
  });

  // Settings' Codex sign-in: a session in the front tab's folder, if that tab is on the server;
  // else in the server's Home tab, once it's in front (its pane starts it after that render).
  const pendingKind = useRef<{ server: string; kind: string } | null>(null);
  const startKind = (l: ServerLink, kind: string) => {
    setDialog(null);
    setSettingsAt(undefined);
    pendingKind.current = { server: l.key, kind };
    if (front?.server !== l.key) open(l.key, null);
    rerender();
  };
  useEffect(() => {
    const k = pendingKind.current;
    const l = k && links.get(k.server);
    const r = l && front?.server === k.server ? rootOf(front) : null;
    const a = l && r ? actions.get(wbKey(l, r)) : undefined;
    if (!k || !a || a.current === noActions) return;
    pendingKind.current = null;
    a.current.startKind(k.kind);
  });

  // ⌘K: a session in a folder with a tab here is shown in that tab; one open in another window
  // brings that window forward; otherwise its folder opens in a new tab here.
  const pickSession = async (l: ServerLink, name: string) => {
    setDialog(null);
    const s = l.sessions?.find((x) => x.name === name);
    if (!s || !layout) return;
    const dir = tabDir(l.key, s.dir);
    if (elsewhere.has(`${l.key}/${name}`) && (await focusSession({ server: l.key, dir: s.dir, session: name }))) return;
    const here = layout.tabs.some((t) => t.server === l.key && t.dir === dir);
    if (!here && (await focusProject({ server: l.key, dir: s.dir, session: name }))) return;
    open(l.key, dir, name);
  };

  const updatePanes = (key: string, f: (p: Panes) => Panes) =>
    setLayout((l) => {
      const i = l ? l.tabs.findIndex((t) => tabKey(t) === key) : -1;
      if (!l || i < 0) return l;
      const t = l.tabs[i];
      const p = f(t);
      return p === t ? l : setPanes(l, i, p);
    });

  const toggle = (k: keyof Show) => setLayout((l) => l && { ...l, show: { ...l.show, [k]: !l.show[k] } });

  const addServer = (s: Server) => {
    setDialog(null);
    if (servers?.some((x) => serverKey(x) === serverKey(s))) return;
    const next = [...(servers ?? []), s];
    setServers(next);
    void saveServers(next);
    setLayout((l) => (l ? openTab(l, serverKey(s), null) : newLayout(serverKey(s))));
  };

  const removeServer = (l: ServerLink) => {
    const next = (servers ?? []).filter((s) => serverKey(s) !== l.key);
    setServers(next);
    void saveServers(next);
  };

  // App shortcuts. Registered once; the ref always points at this render's handler. The
  // workbench in front has its own (⌘P, ⌘S, ⌘W).
  const onKey = useRef<(e: KeyboardEvent) => void>(() => {});
  onKey.current = (e) => {
    if (!e.metaKey || e.ctrlKey) return;
    // e.code: with ⌥ held, a Mac's e.key for B is "∫".
    if (e.altKey) {
      if (e.code !== "KeyB" || e.shiftKey) return;
      toggle("sessions");
      return e.preventDefault();
    }
    const k = e.key.toLowerCase();
    // Inside Monaco, ⌘K starts its chords (⌘K ⌘C and so on), as in VS Code.
    if (k === "k" && (e.target as Element | null)?.closest?.(".monaco-editor")) return;
    if (k === "k" && !e.shiftKey) setDialog((d) => (d === "palette" ? null : "palette"));
    else if (k === "n" && e.shiftKey) newWindow();
    else if (k === "n") frontActions?.current.newClaude();
    else if (k === "b" && !e.shiftKey) toggle("files");
    else if (k === "j" && !e.shiftKey) toggle("term");
    else if (k === "," && !e.shiftKey) setDialog((d) => (d === "settings" ? null : "settings"));
    else if (k === "t" && !e.shiftKey) newBrowserTab();
    else if (k === "o" && !e.shiftKey) {
      if (connected.length) setDialog("open");
      else setNotice("No server is connected yet.");
    } else return;
    e.preventDefault();
  };
  useEffect(() => {
    // Capture phase, so the shortcuts work while the terminal or an input has focus.
    const h = (e: KeyboardEvent) => onKey.current(e);
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, []);

  const wbKey = (l: ServerLink, r: string) => `${l.id}\n${r}`;
  const newBrowserTab = () => frontKey && pageOpeners.get(frontKey)?.current();

  // ---- files dragged in from Finder ----
  // Over the tree: into the folder under the pointer (a file's own folder). Over a terminal: up
  // to ~/.blimp/uploads, and the paths typed into that session. Anywhere else in the tab: into
  // the folder new files go in. What it would land in is lit while dragging.
  const frontKey = link && root ? wbKey(link, root) : null;
  const dropAt = useRef((_x: number, _y: number, _items: Item[] | null) => {});
  dropAt.current = (x, y, items) => {
    const el = document.elementFromPoint(x, y);
    const wb = el?.closest(".wb:not([hidden])");
    let lit: Element | null = null;
    let go = () => {};
    if (el && wb && frontKey && items !== undefined) {
      const split = el.closest<HTMLElement>(".tsplit[data-split]");
      const row = el.closest<HTMLElement>(".wb-tree [data-path]");
      if (split) {
        lit = split;
        go = () => items && actions.get(frontKey)?.current.dropFiles(split.dataset.split!, items);
      } else {
        const tree = wb.querySelector(".tree");
        const dir = row ? (row.dataset.kind === "dir" ? row.dataset.path! : parentDir(row.dataset.path!)) : null;
        lit = (dir && wb.querySelector(`.wb-tree [data-kind="dir"][data-path="${CSS.escape(dir)}"]`)) || tree;
        go = () => items && fileDrops.get(frontKey)?.current(dir, items);
      }
    }
    for (const e of document.querySelectorAll(".drop-over")) if (e !== lit) e.classList.remove("drop-over");
    if (items) {
      lit?.classList.remove("drop-over");
      go();
    } else lit?.classList.add("drop-over");
  };
  useEffect(() => {
    const clear = () => document.querySelectorAll(".drop-over").forEach((e) => e.classList.remove("drop-over"));
    if (inTauri()) {
      // The Mac app: Tauri's own drag-drop event, with the files' paths (Rust may then read them).
      let off = () => {};
      void import("@tauri-apps/api/webview").then(({ getCurrentWebview }) =>
        getCurrentWebview()
          .onDragDropEvent((e) => {
            const p = e.payload;
            if (p.type === "leave") return clear();
            const x = p.position.x / devicePixelRatio;
            const y = p.position.y / devicePixelRatio;
            dropAt.current(x, y, p.type === "drop" ? p.paths.map((path) => ({ name: baseName(path), local: path })) : null);
          })
          .then((f) => (off = f)),
      );
      return () => off();
    }
    // A browser: HTML drag and drop, with File objects.
    const files = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
    const over = (e: DragEvent) => {
      if (!files(e)) return;
      e.preventDefault();
      dropAt.current(e.clientX, e.clientY, null);
    };
    const leave = (e: DragEvent) => !e.relatedTarget && clear();
    const drop = (e: DragEvent) => {
      if (!files(e)) return;
      e.preventDefault();
      dropAt.current(e.clientX, e.clientY, [...e.dataTransfer!.files].map((file) => ({ name: file.name, file })));
    };
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, []);
  const frontActions = link && root ? refFor(actions, wbKey(link, root), noActions) : null;

  if (!servers) return <div className="app" />;
  if (!servers.length)
    return (
      <div className="app">
        <AddServerDialog onAdd={addServer} />
      </div>
    );
  if (!layout || !link) return <div className="app" />;

  const home = layout.tabs[0];
  const homeLink = links.get(home.server)!;
  const welcome = (
    <Welcome
      link={homeLink}
      shown={layout.active === 0}
      links={linkList}
      onServer={(l) => open(l.key, null)}
      onOpen={(d) => void openProject(homeLink, d)}
      onOpenFolder={() => setDialog("open")}
      onNewWindow={() => newWindow()}
      onAddServer={() => setDialog("add")}
      onRemoveServer={removeServer}
      onForget={(d) => void forgetProject(homeLink.key, d)}
    />
  );
  const show = layout.show;
  const frontPages = !!root && !!link?.browserTabs.some((b) => b.folder === root);
  const globe = !frontPages ? "New browser tab (⌘T)" : show.browsers ? "Hide browser tabs" : "Show browser tabs";
  const select = (i: number) => setLayout((l) => l && { ...l, active: i });
  const close = (i: number) => setLayout((l) => l && closeTab(l, i));

  // Where a drag from another window would land here: in the front tab when it's that session's
  // folder (the pane shows which half of which split); else the whole window, as a drop does.
  const hoverHere = (t: Tab) => !!hover?.p.server && t === layout.tabs[layout.active] && hover.p.server === t.server && tabDir(hover.p.server, hover.p.dir) === t.dir;
  const hoverWindow = !!hover && !hoverHere(layout.tabs[layout.active]);

  return (
    <div className={"app" + (hoverWindow ? " drop-window" : "")}>
      <header className="topbar">
        <div className="ptabs" role="tablist" aria-label="Projects">
          {layout.tabs.map((t, i) => {
            const l = links.get(t.server);
            const r = rootOf(t);
            const name = t.dir ? baseName(t.dir) || t.dir : "Home";
            const waiting = !!r && l?.status === "connected" && !!l.sessions?.some((s) => s.dir === r && s.state === "waiting");
            const where = r && l ? tildify(r, l.home) : "";
            return (
              <div
                key={tabKey(t)}
                role="tab"
                aria-selected={i === layout.active}
                aria-label={name}
                className={"ptab" + (i === layout.active ? " active" : "") + (i === 0 ? " home" : "")}
                title={linkList.length > 1 ? `${t.server} · ${where}` : where}
                onMouseDown={(e) => e.button === 0 && select(i)}
                onPointerDown={(e) => {
                  if (i === 0) return;
                  const strip = e.currentTarget.parentElement!;
                  startReorder(e, () => [...strip.querySelectorAll<HTMLElement>(".ptab:not(.home)")], (from, to) => setLayout((l) => l && moveTab(l, from + 1, to + 1)));
                }}
                onAuxClick={(e) => e.button === 1 && close(i)}
              >
                {i === 0 && (
                  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
                    <path d="M2.5 7.5L8 2.5l5.5 5M4 6.5v7h3v-4h2v4h3v-7" fill="none" stroke="currentColor" />
                  </svg>
                )}
                {linkList.length > 1 && <span className="ptab-server">{t.server}</span>}
                {i > 0 && <span className="ptab-title">{name}</span>}
                {t.panes.length > 1 && (
                  <span className="ptab-count" title={`${t.panes.length} sessions side by side`}>
                    {t.panes.length}
                  </span>
                )}
                {waiting && <span className="dot" aria-label="A session is waiting for you" />}
                {i > 0 && (
                  <button className="tab-close" aria-label={`Close ${name}`} onMouseDown={(e) => e.stopPropagation()} onClick={() => close(i)}>
                    ×
                  </button>
                )}
              </div>
            );
          })}
          <button className="icon-button small ptabs-add" title="Open Folder… (⌘O)" aria-label="Open Folder" disabled={!connected.length} onClick={() => setDialog("open")}>
            +
          </button>
        </div>
        {link.status !== "connected" && (
          <span className={"conn conn-" + link.status} title={link.error}>
            {link.status === "offline" ? "offline" : "connecting…"}
          </span>
        )}
        <div className="layout-toggles">
          <LayoutToggle label="Files" keys="⌘B" on={show.files} onClick={() => toggle("files")} pane={<rect x="1.5" y="2.5" width="5" height="11" rx="1.5" />} />
          <LayoutToggle label="Terminal" keys="⌘J" on={show.term} onClick={() => toggle("term")} pane={<rect x="1.5" y="9.5" width="13" height="4" rx="1.5" />} />
          <LayoutToggle label="Sessions" keys="⌘⌥B" on={show.sessions} onClick={() => toggle("sessions")} pane={<rect x="9.5" y="2.5" width="5" height="11" rx="1.5" />} />
          {/* Hides and shows the browser tabs (hidden, nothing streams; the pages stay open on the
              server), or opens one if this folder has none. */}
          <button className="icon-button small" title={globe} aria-label={globe} aria-pressed={frontPages ? show.browsers : undefined} disabled={!frontKey} onClick={() => (frontPages ? toggle("browsers") : newBrowserTab())}>
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor">
              <circle cx="8" cy="8" r="5.5" />
              <path d="M2.5 8h11M8 2.5c-2 2-2 9 0 11M8 2.5c2 2 2 9 0 11" />
            </svg>
          </button>
          <button className="icon-button small" title="Settings (⌘,)" aria-label="Settings" onClick={() => setDialog("settings")}>
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor">
              <circle cx="8" cy="8" r="2.2" />
              <path d="M8 1.8v1.8M8 12.4v1.8M1.8 8h1.8M12.4 8h1.8M3.6 3.6l1.3 1.3M11.1 11.1l1.3 1.3M3.6 12.4l1.3-1.3M11.1 4.9l1.3-1.3" />
            </svg>
          </button>
        </div>
      </header>
      <UpdateBars links={linkList} onNotice={setNotice} />

      {layout.tabs.map((t, i) => {
        const l = links.get(t.server);
        const r = rootOf(t);
        const isFront = i === layout.active;
        // Home before the server has answered: there's no folder to show yet.
        if (!l || !r) return isFront ? <div key={tabKey(t)} className="wb-connecting">{welcome}</div> : null;
        const key = wbKey(l, r);
        const opener = refFor(openers, key, () => {});
        return (
          <Workbench
            key={key}
            link={l}
            root={r}
            front={isFront}
            showFiles={show.files}
            showTerm={show.term}
            showBrowsers={show.browsers}
            pageOrder={t.pageOrder}
            onPageOrder={(o) => setLayout((x) => x && setPageOrder(x, x.tabs.findIndex((y) => tabKey(y) === tabKey(t)), o))}
            onShowBrowsers={() => setLayout((l) => l && { ...l, show: { ...l.show, browsers: true } })}
            welcome={i === 0 ? welcome : undefined}
            opener={opener}
            onDrop={refFor(fileDrops, key, () => {})}
            pages={refFor(pageOpeners, key, () => {})}
            pane={refFor(actions, key, noActions)}
            onNotice={setNotice}
            terminal={
              <TerminalPane
                link={l}
                dir={r}
                panes={t}
                onPanes={(f) => updatePanes(tabKey(t), f)}
                front={isFront}
                showList={show.sessions}
                onOpenPath={(p, line, col) => opener.current(p, line, col)}
                onNotice={setNotice}
                onMoveOut={(names, at) => moveOut(t, names, at)}
                elsewhere={(n) => elsewhere.has(`${t.server}/${n}`)}
                hoverAt={hover && hoverHere(t) ? hover : null}
                onTake={(n) => takeSession(`${t.server}/${n}`)}
                onOpenPort={(p) => pageOpeners.get(key)?.current(p)}
                onOpenUrl={(u) => pageOpeners.get(key)?.current(u)}
                onModels={() => {
                  setSettingsAt("models");
                  setDialog("settings");
                }}
                actions={refFor(actions, key, noActions)}
              />
            }
          />
        );
      })}

      {dialog === "palette" && <Palette links={linkList} onPick={(l, name) => void pickSession(l, name)} onClose={() => setDialog(null)} />}
      {dialog === "open" && connected.length > 0 && (
        <OpenFolderDialog
          links={connected}
          initial={link.status === "connected" ? link : connected[0]}
          onPick={(l, d) => void openProject(l, d)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "add" && <AddServerDialog onAdd={addServer} onClose={() => setDialog(null)} />}
      {dialog === "settings" && (
        <SettingsDialog
          at={settingsAt}
          links={connected}
          onCodexSignIn={(l) => startKind(l, "codex-login")}
          onClose={() => {
            setDialog(null);
            setSettingsAt(undefined);
          }}
        />
      )}
      <TransferList />
      {hover && (
        <DragGhost s={links.get(hover.p.server ?? "")?.sessions?.find((x) => x.name === hover.p.session)} label={hover.label} x={hover.x - 24} y={hover.y - 14} w={230} />
      )}
      {notice && (
        <div className="toast" role="status" onClick={() => setNotice("")}>
          {notice}
        </div>
      )}
    </div>
  );
}

// A show/hide button at the top right, as in VS Code: a window outline with the pane drawn in
// it, filled while the pane shows.
function LayoutToggle(props: { label: string; keys: string; on: boolean; onClick: () => void; pane: ReactNode }) {
  return (
    <button className="icon-button small" title={`${props.on ? "Hide" : "Show"} ${props.label} (${props.keys})`} aria-label={props.label} aria-pressed={props.on} onClick={props.onClick}>
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor">
        <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
        <g fill={props.on ? "currentColor" : "none"}>{props.pane}</g>
      </svg>
    </button>
  );
}
