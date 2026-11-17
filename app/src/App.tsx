import { Fragment, useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { AddServerDialog } from "./components/AddServerDialog";
import { ManageServersDialog } from "./components/ManageServersDialog";
import { OpenFolderDialog } from "./components/OpenFolderDialog";
import { Palette } from "./components/Palette";
import { ServerDot, ServerSwitcher } from "./components/ServerSwitcher";
import { DragGhost, noActions, TerminalPane, type PaneActions } from "./components/TerminalPane";
import { SettingsDialog } from "./components/SettingsDialog";
import { ShortcutsDialog } from "./components/ShortcutsDialog";
import { TransferList } from "./components/TransferList";
import { UpdateBars } from "./components/UpdateBars";
import { Welcome } from "./components/Welcome";
import { Workbench, type FileDrop, type Opener, type PageOpener } from "./components/Workbench";
import { commandForKey, inChord, REPO, runner, type Action } from "./lib/commands";
import { menuSpec, onMenu, setMenu } from "./lib/menu";
import { errorText, inTauri, loadServers, onServersChanged, saveServers, serverKey, ServerLink, serverName, type Server } from "./lib/connection";
import { baseName, parentDir } from "./lib/files";
import { dropPoint, type Item } from "./lib/transfers";
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
import { openWebLink } from "./lib/links";
import { forgetProject, lastLayout, lastServer, recentProjects, rememberLayout, rememberProject } from "./lib/recent";
import { tildify } from "./lib/sessions";
import { closeTab, dropHomeTabs, homeTab, keepServers, moveTab, newLayout, openTab, releaseSession, setPageOrder, setPanes, stepTab, tabKey, type Layout, type Show, type Tab } from "./lib/tabs";
import { startReorder } from "./lib/reorder";
import { changeSettings, getSettings, startSettings, textSize, useSettings } from "./lib/settings";
import { blimpdBehind, canUpdate, updateLink } from "./lib/updates";
import { notify, setBadge, toMarkSeen, WaitWatcher } from "./lib/waiting";
import { jobsOpen, JobWatcher, viewingList } from "./lib/jobs";
import blimpSilver from "./assets/blimp-silver.svg";
import blimpInk from "./assets/blimp-ink.svg";

type DialogKind = "palette" | "open" | "add" | "manage" | "settings" | "shortcuts" | null;

// One window: project tabs along the top (Home, the server's home folder, first), each laid out
// by its own Workbench. Every tab stays mounted while open, so its files and terminals survive
// switching. Several windows each run their own App; Rust shares the SSH tunnels between them.
export function App() {
  const [servers, setServers] = useState<Server[] | null>(null);
  // The list as it is now, for a change that lands late (an Add server try that took a while, a
  // name field's blur): its closure's servers may be from before another window changed them.
  const serversNow = useRef(servers);
  serversNow.current = servers;
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
  // Per tab: what its own commands do (Quick Open, Save, Close Tab), run while it's in front.
  const wbCommands = useRef(new Map<string, { current: Record<string, Action> }>()).current;
  // UpdateBars' Check for Updates….
  const checkUpdates = useRef(() => {});
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
    // With several servers saved, a notification says which one.
    const named = links.size > 1 ? l.name : undefined;
    if (l.status === "connected" && l.sessions) watcher.current!.update(l.key, l.home, l.sessions, named);
    if (l.status === "connected" && l.sessions) jobWatcher.current!.update(l.key, l.home, l.sessions, named);
    markSeen(l);
    rerender();
  }).current;

  useEffect(() => void startSettings(), []);

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

  // A server added, renamed or removed in another window.
  useEffect(() => {
    let off = () => {};
    void onServersChanged(() =>
      loadServers().then(
        (list) => {
          if (JSON.stringify(serversNow.current) === JSON.stringify(list)) return;
          // serversNow first: a change made here before the next render builds on this list.
          serversNow.current = list;
          setServers(list);
        },
        () => {},
      ),
    ).then((f) => (off = f));
    return () => off();
  }, []);

  // Start a link for every saved server, stop links for removed ones.
  useEffect(() => {
    if (!servers) return;
    const want = servers.map(serverKey);
    for (const [k, l] of links) if (!want.includes(k)) (l.stop(), links.delete(k));
    for (const s of servers) {
      const had = links.get(serverKey(s));
      // A rename keeps the link (and its tunnel): only the name changes.
      const l = had ?? new ServerLink(s, onLinkChange);
      l.server = s;
      l.name = serverName(s, servers);
      if (had) continue;
      links.set(l.key, l);
      l.start();
    }
    setLayout((l) => (l ? keepServers(l, want) : want.length ? newLayout(want[0]) : null));
    rerender();
  }, [servers]);

  // No server saved: the window shows only the Add server form, Settings and Shortcuts. Another
  // dialog left set (Manage servers, when its last server is removed) would pop up later, once
  // a server is added.
  useEffect(() => {
    if (servers?.length === 0 && dialog !== "settings" && dialog !== "shortcuts") setDialog(null);
  }, [servers, dialog]);

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
  // those sessions from any window, nor for the jobs of a session whose jobs popover is open.
  const viewing = front ? front.panes.map((n) => `${front.server}/${n}`) : [];
  viewingRef.current = viewing;
  const viewingKey = viewing.join("\n");
  useEffect(() => {
    const sync = () => {
      setViewing(document.hasFocus() ? viewingList(viewingRef.current, jobsOpen.current) : []);
      links.forEach(markSeen);
    };
    sync();
    jobsOpen.changed = sync;
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    return () => {
      jobsOpen.changed = () => {};
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
    // The assistant's folder isn't a project: opening the assistant (its pinned row, a notification, ⌘K) gives it a
    // tab but never makes it a recent project. blimpd always names it exactly "assistant", so the name alone is enough
    // (the session list may not have arrived yet).
    const assistant = session === "assistant" || (!!session && links.get(server)?.sessions?.find((s) => s.name === session)?.assistant === true);
    if (dir && !assistant) void rememberProject(server, dir);
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

  // Kept and saved; serversNow too, so a second change before the next render builds on this one.
  const keep = (next: Server[]) => {
    serversNow.current = next;
    setServers(next);
    void saveServers(next);
  };

  const addServer = (s: Server) => {
    setDialog(null);
    const cur = serversNow.current;
    if (cur?.some((x) => serverKey(x) === serverKey(s))) return;
    keep([...(cur ?? []), s]);
    setLayout((l) => (l ? openTab(l, serverKey(s), null) : newLayout(serverKey(s))));
  };

  // The name only: the key, the tunnel, the tabs and the recent folders stay as they are.
  const renameServer = (l: ServerLink, name: string) =>
    keep(
      (serversNow.current ?? []).map((s) => {
        if (serverKey(s) !== l.key) return s;
        const renamed: Server = { ...s, name };
        if (!name) delete renamed.name;
        return renamed;
      }),
    );

  const removeServer = (l: ServerLink) => keep((serversNow.current ?? []).filter((s) => serverKey(s) !== l.key));

  // Every command (lib/commands.ts) runs here, from its key or (on the Mac) its menu item. The
  // actions are this render's; the runner and its memory of the last run stay.
  const actionFor = useRef<(id: string) => Action | undefined>(() => undefined);
  const run = useRef(runner((id) => actionFor.current(id))).current;

  // The keys. Registered once; the ref always points at this render's handler.
  const onKey = useRef<(e: KeyboardEvent) => void>(() => {});
  // When ⌘K was the last key pressed in the editor: the next one, while Monaco still waits for it
  // (inChord), finishes Monaco's chord.
  const chordAt = useRef<number | null>(null);
  onKey.current = (e) => {
    // ⌘ or ⇧ going down between the chord's two keys doesn't end it.
    if (["Meta", "Shift", "Alt", "Control"].includes(e.key)) return;
    const chord = inChord(Date.now(), chordAt.current);
    chordAt.current = null;
    const inEditor = !!(e.target as Element | null)?.closest?.(".monaco-editor");
    const id = commandForKey(e);
    // Inside Monaco, ⌘K starts its chords (⌘K ⌘0 folds all, as in VS Code), and the chord's
    // second key is Monaco's too, even one that is also an app command.
    if (inEditor && chord) return;
    if (!id) return;
    if (inEditor && id === "palette") return void (chordAt.current = Date.now());
    if (run(id, "key")) e.preventDefault();
  };
  useEffect(() => {
    // Capture phase, so the shortcuts work while the terminal or an input has focus.
    const h = (e: KeyboardEvent) => onKey.current(e);
    // Monaco leaves the chord when the window loses focus, so the app does too.
    const blur = () => (chordAt.current = null);
    window.addEventListener("keydown", h, true);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", h, true);
      window.removeEventListener("blur", blur);
    };
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
      // A picture dragged from a web page or Photos hands over no file, only its data, which Tauri
      // doesn't pass on: nothing is lit for it, and letting go says how to get it in instead. So
      // does any other drag that isn't files (text, a link), so the words don't assume a picture.
      let files = true;
      const mac = /Mac/.test(navigator.userAgent);
      // The web view's frame height in points, for dropPoint (lib/transfers.ts): it reaches up under
      // the title bar, by more than innerHeight. Asked when the window opens and after each resize
      // (full screen drops the title bar), so a drag's events need no call of their own; one call at
      // a time, then one more if the size changed meanwhile. Until it's known: innerHeight.
      let frameH = 0;
      let asking = false;
      let again = false;
      let measure = () => {};
      void import("@tauri-apps/api/webview").then(({ getCurrentWebview }) => {
        const view = getCurrentWebview();
        measure = () => {
          if (asking) return void (again = true);
          asking = true;
          view
            .size()
            .then((s) => (frameH = s.height / devicePixelRatio))
            .catch(() => {})
            .finally(() => {
              asking = false;
              if (!again) return;
              again = false;
              measure();
            });
        };
        if (mac) measure();
        return view
          .onDragDropEvent((e) => {
            const p = e.payload;
            if (p.type === "leave") return clear();
            if (p.type === "enter") files = p.paths.length > 0;
            if (p.type === "drop" && !p.paths.length) {
              clear();
              return setNotice("Only files can be dropped here. A picture from a web page or Photos: save it as a file first.");
            }
            if (!files) return;
            const viewH = innerHeight;
            const { x, y } = dropPoint(p.position, { mac, dpr: devicePixelRatio, frameH: frameH || viewH, viewH });
            dropAt.current(x, y, p.type === "drop" ? p.paths.map((path) => ({ name: baseName(path), local: path })) : null);
          })
          .then((f) => (off = f));
      });
      const resized = () => mac && measure();
      window.addEventListener("resize", resized);
      return () => {
        off();
        window.removeEventListener("resize", resized);
      };
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
  const frontPages = !!root && !!link?.browserTabs.some((b) => b.folder === root);

  // What each command does in this window now, whether it's on, and (for the panels) whether it's
  // checked. A command missing here isn't offered in this window.
  actionFor.current = (id) => {
    const each = /^(server|recent):(\d+)$/.exec(id);
    if (each) {
      const n = Number(each[2]);
      const s = each[1] === "server" ? servers?.[n] : undefined;
      if (s) return { run: () => open(serverKey(s), null) };
      // The front tab's server's recent folders, as Welcome lists them (it keeps ten at most). A
      // click opens the folder the menu showed, not the n-th in the list now. On while the server
      // reconnects (the menu isn't redrawn for that), and says so then.
      if (each[1] === "recent" && link && n < 10)
        return {
          run: () => {
            const m = menuRecent.current;
            const l = links.get(m.server);
            const dir = m.dirs[n];
            if (!l || !dir) return;
            if (l.status !== "connected") return setNotice(`${l.name} isn't connected yet.`);
            void openProject(l, dir);
          },
        };
      return undefined;
    }
    const show = layout?.show;
    const tabs = layout?.tabs.length ?? 0;
    const all: Record<string, Action | undefined> = {
      settings: { run: (from) => setDialog((d) => (from === "key" && d === "settings" ? null : "settings")) },
      "check-updates": canUpdate() ? { run: () => checkUpdates.current() } : undefined,
      // No server saved: nothing to jump to, and the Add server form has no room for it.
      palette: { run: () => setDialog((d) => (d === "palette" ? null : "palette")), enabled: !!servers?.length },
      "new-claude": { run: () => frontActions?.current.newClaude(), enabled: !!frontActions },
      "new-shell": { run: () => frontActions?.current.startKind("shell"), enabled: !!frontActions },
      "new-browser-tab": { run: () => newBrowserTab(), enabled: !!frontKey },
      "new-window": { run: () => newWindow() },
      "open-folder": { run: () => setDialog("open"), enabled: connected.length > 0, off: () => setNotice("No server is connected yet.") },
      "close-project": { run: () => setLayout((l) => l && closeTab(l, l.active)), enabled: !!layout && layout.active > 0 },
      "toggle-files": { run: () => toggle("files"), checked: show?.files },
      "toggle-terminal": { run: () => toggle("term"), checked: show?.term },
      "toggle-sessions": { run: () => toggle("sessions"), checked: show?.sessions },
      "toggle-browsers": { run: () => toggle("browsers"), enabled: frontPages, checked: show?.browsers },
      "text-bigger": { run: () => void changeSettings(textSize(getSettings(), 1)) },
      "text-smaller": { run: () => void changeSettings(textSize(getSettings(), -1)) },
      "text-reset": { run: () => void changeSettings(textSize(getSettings(), 0)) },
      // No server saved yet: the window is the Add server form already.
      "add-server": { run: () => (servers?.length ? setDialog("add") : document.querySelector<HTMLInputElement>(".welcome .addserver input")?.focus()) },
      "manage-servers": { run: () => setDialog("manage"), enabled: !!servers?.length },
      reconnect: link ? { run: () => link.retryNow() } : undefined,
      "update-server": canUpdate() && link ? { run: () => void updateLink(link, setNotice), enabled: blimpdBehind(link) } : undefined,
      "prev-tab": { run: () => setLayout((l) => l && stepTab(l, -1)), enabled: tabs > 1 },
      "next-tab": { run: () => setLayout((l) => l && stepTab(l, 1)), enabled: tabs > 1 },
      home: { run: () => setLayout((l) => l && { ...l, active: 0 }) },
      shortcuts: { run: () => setDialog("shortcuts") },
      help: { run: () => openWebLink(`${REPO}#readme`) },
      report: { run: () => openWebLink(`${REPO}/issues/new`) },
      // close-window: Rust closes the window (the menu); not in a browser.
    };
    return all[id] ?? (frontKey ? wbCommands.get(frontKey)?.current[id] : undefined);
  };

  // The Mac menu bar (lib/menu.ts). This window describes it while it has focus: about 100 ms
  // after a change, so a burst of changes is one call, and only when it differs from the last
  // one sent. Again on focus (another window had the menu) and after a click (a check item
  // ticks or unticks itself when clicked, whatever the page says).
  const menuSent = useRef("");
  const menuTimer = useRef(0);
  // The recent folders the menu was last sent with, and their server: what recent:<n> opens.
  const menuRecent = useRef<{ server: string; dirs: string[] }>({ server: "", dirs: [] });
  const describeMenu = useRef(async () => {});
  describeMenu.current = async () => {
    const list = servers ?? [];
    const dirs = link ? (await recentProjects(link.key)).map((r) => r.dir) : [];
    const spec = menuSpec({
      action: (id) => actionFor.current(id),
      servers: list.map((s) => ({ name: serverName(s, list), status: links.get(serverKey(s))?.status ?? "connecting" })),
      front: link ? list.findIndex((s) => serverKey(s) === link.key) : -1,
      recent: dirs.map((d) => tildify(d, link!.home)),
    });
    const json = JSON.stringify(spec);
    if (json === menuSent.current) return;
    menuSent.current = json;
    menuRecent.current = { server: link?.key ?? "", dirs };
    setMenu(spec);
  };
  const menuSoon = useRef((fresh: boolean) => {
    if (!inTauri() || !document.hasFocus()) return;
    if (fresh) menuSent.current = "";
    if (menuTimer.current) return;
    menuTimer.current = window.setTimeout(() => {
      menuTimer.current = 0;
      void describeMenu.current();
    }, 100);
  }).current;
  useEffect(() => menuSoon(false));
  useEffect(() => {
    const focus = () => menuSoon(true);
    window.addEventListener("focus", focus);
    let off = () => {};
    void onMenu((id) => {
      run(id, "menu");
      menuSoon(true);
    }).then((f) => (off = f));
    return () => {
      window.removeEventListener("focus", focus);
      clearTimeout(menuTimer.current);
      menuTimer.current = 0;
      off();
    };
  }, []);

  if (!servers) return <div className="app" />;
  if (!servers.length)
    return (
      <div className="app">
        <AddServerDialog known={[]} onAdd={addServer} />
        {dialog === "shortcuts" && <ShortcutsDialog onClose={() => setDialog(null)} />}
        {/* With no server, its Models and Assistant sections say to connect one first. */}
        {dialog === "settings" && (
          <SettingsDialog
            links={[]}
            onCodexSignIn={() => {}}
            onClose={() => {
              setDialog(null);
              setSettingsAt(undefined);
            }}
          />
        )}
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
      onForget={(d) => void forgetProject(homeLink.key, d).then(() => menuSoon(false))}
      onShortcuts={() => setDialog("shortcuts")}
    />
  );
  const show = layout.show;
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
            // The tooltip has the address too, when the name isn't it.
            const server = !l ? t.server : l.name === l.key ? l.key : `${l.name} (${l.key})`;
            return (
              <Fragment key={tabKey(t)}>
                <div
                  role="tab"
                  aria-selected={i === layout.active}
                  aria-label={name}
                  className={"ptab" + (i === layout.active ? " active" : "") + (i === 0 ? " home" : "")}
                  title={i === 0 ? server : linkList.length > 1 ? `${server} · ${where}` : where}
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
                  {/* Home names its server, also when there is one: the server list hangs off it. */}
                  {i === 0 && <ServerDot status={homeLink.status} />}
                  {i === 0 && <span className="ptab-home-server">{homeLink.name}</span>}
                  {i > 0 && linkList.length > 1 && <span className="ptab-server">{l?.name ?? t.server}</span>}
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
                {/* Home's server list: a button of its own beside the tab, so it never selects or drags it. */}
                {i === 0 && <ServerSwitcher links={linkList} current={homeLink} onPick={(l) => open(l.key, null)} onAdd={() => setDialog("add")} onManage={() => setDialog("manage")} />}
              </Fragment>
            );
          })}
          <button className="icon-button small ptabs-add" title="Open Folder… (⌘O)" aria-label="Open Folder" disabled={!connected.length} onClick={() => setDialog("open")}>
            +
          </button>
        </div>
        {link.status !== "connected" && (
          <span className={"conn conn-" + link.status} title={link.error}>
            {link.status !== "offline" && (
              <>
                <img className="conn-mark brand-mark brand-mark-dark" src={blimpSilver} alt="" />
                <img className="conn-mark brand-mark brand-mark-light" src={blimpInk} alt="" />
              </>
            )}
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
      <UpdateBars links={linkList} onNotice={setNotice} check={checkUpdates} />

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
            commands={refFor(wbCommands, key, {})}
            onCommands={() => menuSoon(false)}
            pane={refFor(actions, key, noActions)}
            onShowFiles={() => setLayout((l) => l && { ...l, show: { ...l.show, files: true } })}
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
                onPick={(n) => void pickSession(l, n)}
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
      {dialog === "add" && <AddServerDialog known={servers.map(serverKey)} onAdd={addServer} onClose={() => setDialog(null)} />}
      {dialog === "manage" && (
        <ManageServersDialog links={linkList} onRename={renameServer} onRemove={removeServer} onAdd={() => setDialog("add")} onNotice={setNotice} onClose={() => setDialog(null)} />
      )}
      {dialog === "shortcuts" && <ShortcutsDialog onClose={() => setDialog(null)} />}
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
