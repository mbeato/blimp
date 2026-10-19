import { useEffect, useReducer, useRef, useState } from "react";
import { AddServerDialog } from "./components/AddServerDialog";
import { OpenFolderDialog } from "./components/OpenFolderDialog";
import { Palette } from "./components/Palette";
import { TerminalPane, type PaneActions } from "./components/TerminalPane";
import { Welcome } from "./components/Welcome";
import { Workbench, type Opener } from "./components/Workbench";
import { errorText, loadServers, saveServers, serverKey, ServerLink, type Server } from "./lib/connection";
import { baseName } from "./lib/files";
import {
  onSelectSession,
  openWindow,
  placeQuery,
  projectKey,
  readPlace,
  setViewing,
  setWindowProject,
  setWindowTitle,
  writePlace,
  type Place,
} from "./lib/place";
import { forgetProject, lastServer, rememberProject } from "./lib/recent";
import { tildify } from "./lib/sessions";
import { notify, setBadge, WaitWatcher } from "./lib/waiting";

type DialogKind = "palette" | "open" | "add" | null;

// One window: one server and one folder on it (Home is the server's home folder), laid out by
// Workbench. Several windows each run their own App; Rust shares the SSH tunnels between them.
export function App() {
  const [servers, setServers] = useState<Server[] | null>(null);
  const initial = useRef(readPlace()).current;
  const [server, setServer] = useState<string | null>(initial.server ?? null);
  const [dir, setDir] = useState<string | null>(initial.dir ?? null); // null: Home
  const [session, setSession] = useState<string | null>(initial.session ?? null);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [notice, setNotice] = useState("");
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const opener = useRef<Opener>(() => {});
  const pane = useRef<PaneActions>({ newClaude: () => {} });

  // Links live outside React state: they are long-lived objects that mutate and call back.
  const links = useRef(new Map<string, ServerLink>()).current;
  const viewingRef = useRef<string | null>(null);
  const watcher = useRef<WaitWatcher | null>(null);
  watcher.current ??= new WaitWatcher(notify, () => ({ focused: document.hasFocus(), activeTab: viewingRef.current }));
  const onLinkChange = useRef((l: ServerLink) => {
    if (l.status === "connected" && l.sessions) watcher.current!.update(l.key, l.home, l.sessions);
    rerender();
  }).current;

  useEffect(() => {
    loadServers().then(
      async (list) => {
        // A window with no server named opens on the one Home used last.
        if (!initial.server) {
          const last = await lastServer();
          setServer(list.some((s) => serverKey(s) === last) ? last! : list[0] ? serverKey(list[0]) : null);
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
    const want = new Set(servers.map(serverKey));
    for (const [k, l] of links) if (!want.has(k)) (l.stop(), links.delete(k));
    for (const s of servers) {
      if (links.has(serverKey(s))) continue;
      const l = new ServerLink(s, onLinkChange);
      links.set(l.key, l);
      l.start();
    }
    if (servers.length && !want.has(server ?? "")) (setServer(serverKey(servers[0])), setDir(null), setSession(null));
    rerender();
  }, [servers]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  const linkList = (servers ?? []).map((s) => links.get(serverKey(s))).filter((l): l is ServerLink => !!l);
  const connected = linkList.filter((l) => l.status === "connected");
  const link = server ? (links.get(server) ?? null) : null;
  // Home's folder is only known once the server has answered.
  const root = dir ?? (link?.home || null);
  const isHome = !!link && (!dir || dir === link.home);

  // Only servers blimp can see right now: an offline server's last list may be long out of date.
  const waitingCount = connected.reduce((n, l) => n + (l.sessions?.filter((s) => s.state === "waiting").length ?? 0), 0);
  useEffect(() => void setBadge(waitingCount), [waitingCount]);

  // The URL keeps the place, so a reload stays put; Rust learns it for ⌘K's focus-or-open.
  useEffect(() => writePlace({ server: server ?? undefined, dir: dir ?? undefined, session: session ?? undefined }), [server, dir, session]);
  useEffect(() => setWindowProject(server && root ? projectKey(server, root) : null), [server, root]);
  useEffect(() => void setWindowTitle(root && !isHome ? `${baseName(root)} — blimp` : "blimp"), [root, isHome]);

  // What this window shows, while it has focus: no notification for that session from any window.
  const viewing = server && session ? `${server}/${session}` : null;
  viewingRef.current = viewing;
  useEffect(() => {
    const sync = () => setViewing(document.hasFocus() ? viewingRef.current : null);
    sync();
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    return () => {
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
    };
  }, [viewing]);

  // ⌘K in another window picked a session in this window's folder.
  useEffect(() => {
    let off = () => {};
    void onSelectSession((p) => p.session && setSession(p.session)).then((f) => (off = f));
    return () => off();
  }, []);

  const go = (p: { server: string; dir: string | null; session?: string | null }) => {
    setServer(p.server);
    setDir(p.dir);
    setSession(p.session ?? null);
    setDialog(null);
    void rememberProject(p.server, p.dir);
  };

  // Opens a folder in this window, as VS Code's Open Folder does.
  const openProject = async (l: ServerLink, d: string) => {
    setDialog(null);
    try {
      await l.api!.fsList(d);
    } catch (e) {
      return setNotice(`Couldn't open ${tildify(d, l.home)}: ${errorText(e)}`);
    }
    go({ server: l.key, dir: d === l.home ? null : d });
  };

  const newWindow = async (p: Place = { server: server ?? undefined }) => {
    if (await openWindow(p)) return;
    window.open(`${location.pathname}?${placeQuery(p, location.search)}`, "_blank");
  };

  // ⌘K: a session here is shown here; one in another folder opens (or focuses) its window.
  const pickSession = async (l: ServerLink, name: string) => {
    setDialog(null);
    const s = l.sessions?.find((x) => x.name === name);
    if (!s) return;
    if (l.key === server && s.dir === root) return setSession(name);
    const d = s.dir === l.home ? null : s.dir;
    // The browser build has one window, so it moves there instead.
    if (!(await openWindow({ server: l.key, dir: s.dir, session: name }))) go({ server: l.key, dir: d, session: name });
  };

  const addServer = (s: Server) => {
    setDialog(null);
    if (servers?.some((x) => serverKey(x) === serverKey(s))) return;
    const next = [...(servers ?? []), s];
    setServers(next);
    void saveServers(next);
    go({ server: serverKey(s), dir: null });
  };

  const removeServer = (l: ServerLink) => {
    const next = (servers ?? []).filter((s) => serverKey(s) !== l.key);
    setServers(next);
    void saveServers(next);
  };

  // App shortcuts. Registered once; the ref always points at this render's handler. The
  // workbench has its own (⌘P, ⌘S, ⌘W, ⌘B, ⌘J).
  const onKey = useRef<(e: KeyboardEvent) => void>(() => {});
  onKey.current = (e) => {
    if (!e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    // Inside Monaco, ⌘K starts its chords (⌘K ⌘C and so on), as in VS Code.
    if (k === "k" && (e.target as Element | null)?.closest?.(".monaco-editor")) return;
    if (k === "k" && !e.shiftKey) setDialog((d) => (d === "palette" ? null : "palette"));
    else if (k === "n" && e.shiftKey) void newWindow();
    else if (k === "n") pane.current.newClaude();
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

  if (!servers) return <div className="app" />;
  if (!servers.length)
    return (
      <div className="app">
        <AddServerDialog onAdd={addServer} />
      </div>
    );
  if (!link) return <div className="app" />;

  const welcome = (
    <Welcome
      link={link}
      links={linkList}
      onServer={(l) => go({ server: l.key, dir: null })}
      onOpen={(d) => void openProject(link, d)}
      onOpenFolder={() => setDialog("open")}
      onNewWindow={() => void newWindow()}
      onAddServer={() => setDialog("add")}
      onRemoveServer={removeServer}
      onForget={(d) => void forgetProject(link.key, d)}
    />
  );

  return (
    <div className="app">
      <header className="topbar">
        <button className="icon-button small" title="Home" aria-label="Home" disabled={isHome && !dir} onClick={() => go({ server: link.key, dir: null })}>
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
            <path d="M2.5 7.5L8 2.5l5.5 5M4 6.5v7h3v-4h2v4h3v-7" fill="none" stroke="currentColor" />
          </svg>
        </button>
        <span className="topbar-place" title={root ?? ""}>
          {linkList.length > 1 && <span className="topbar-server">{link.key}</span>}
          {root ? tildify(root, link.home) : link.server.host}
        </span>
        <span className="topbar-fill" />
        {link.status !== "connected" && (
          <span className={"conn conn-" + link.status} title={link.error}>
            {link.status === "offline" ? "offline" : "connecting…"}
          </span>
        )}
        <button className="link-button" disabled={!connected.length} onClick={() => setDialog("open")}>
          Open Folder…
        </button>
      </header>

      {root ? (
        <Workbench
          key={`${link.id}\n${root}`}
          link={link}
          root={root}
          welcome={isHome ? welcome : undefined}
          opener={opener}
          terminal={
            <TerminalPane
              link={link}
              dir={root}
              selected={session}
              onSelect={setSession}
              onOpenPath={(p, line, col) => opener.current(p, line, col)}
              onNotice={setNotice}
              actions={pane}
            />
          }
        />
      ) : (
        // Home before the server has answered: there's no folder to show yet.
        <div className="wb-connecting">{welcome}</div>
      )}

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
      {notice && (
        <div className="toast" role="status" onClick={() => setNotice("")}>
          {notice}
        </div>
      )}
    </div>
  );
}
