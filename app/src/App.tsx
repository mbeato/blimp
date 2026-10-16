import { useEffect, useReducer, useRef, useState, type CSSProperties } from "react";
import { AddServerDialog } from "./components/AddServerDialog";
import { FilesPane } from "./components/FilesPane";
import { NewSessionDialog } from "./components/NewSessionDialog";
import { Palette } from "./components/Palette";
import { Sidebar } from "./components/Sidebar";
import { Splitter } from "./components/Splitter";
import { TerminalView } from "./components/TerminalView";
import { errorText, loadServers, saveServers, serverKey, ServerLink, type Server } from "./lib/connection";
import { tildify } from "./lib/sidebar";
import { notify, setBadge, WaitWatcher } from "./lib/waiting";

// key is "<server key>/<session name>". dir is known when the tab opens, before the session
// shows up in the server's list.
type Tab = { key: string; linkKey: string; name: string; dir: string };
type DialogKind = "palette" | "new" | "add" | null;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function App() {
  const [servers, setServers] = useState<Server[] | null>(null);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [filesOpen, setFilesOpen] = useState(true);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [notice, setNotice] = useState("");
  const [sideWidth, setSideWidth] = useState(280);
  const [filesShare, setFilesShare] = useState(0.45);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const main = useRef<HTMLElement>(null);

  // Links live outside React state: they are long-lived objects that mutate and call back.
  const links = useRef(new Map<string, ServerLink>()).current;
  const activeRef = useRef(active);
  activeRef.current = active;
  const watcher = useRef<WaitWatcher | null>(null);
  watcher.current ??= new WaitWatcher(notify, () => ({ focused: document.hasFocus(), activeTab: activeRef.current }));
  const onLinkChange = useRef((l: ServerLink) => {
    if (l.status === "connected" && l.sessions) watcher.current!.update(l.key, l.home, l.sessions);
    rerender();
  }).current;

  useEffect(() => {
    loadServers().then(setServers, (e) => (setServers([]), setNotice(errorText(e))));
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
    rerender();
  }, [servers]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  const linkList = (servers ?? []).map((s) => links.get(serverKey(s))).filter((l): l is ServerLink => !!l);
  const connected = linkList.filter((l) => l.status === "connected");
  // Only servers blimp can see right now: an offline server's last list may be long out of date.
  const waitingCount = connected.reduce((n, l) => n + (l.sessions?.filter((s) => s.state === "waiting").length ?? 0), 0);
  useEffect(() => void setBadge(waitingCount), [waitingCount]);

  const activeTab = tabs.find((t) => t.key === active) ?? null;
  const activeLink = activeTab ? (links.get(activeTab.linkKey) ?? null) : null;
  const sessionOf = (t: Tab) => links.get(t.linkKey)?.sessions?.find((s) => s.name === t.name);

  const openTab = (link: ServerLink, name: string, dir?: string) => {
    const key = `${link.key}/${name}`;
    dir ??= link.sessions?.find((s) => s.name === name)?.dir ?? "";
    setTabs((ts) => (ts.some((t) => t.key === key) ? ts : [...ts, { key, linkKey: link.key, name, dir }]));
    setActive(key);
    setDialog(null);
  };

  // Closing a tab only detaches; the session keeps running on the server.
  const closeTab = (key: string) => {
    const i = tabs.findIndex((t) => t.key === key);
    const rest = tabs.filter((t) => t.key !== key);
    setTabs(rest);
    if (active === key) setActive(rest[Math.min(i, rest.length - 1)]?.key ?? null);
  };

  const startSession = async (link: ServerLink, dir: string, resume?: string) => {
    const { name } = await link.api!.createSession({ dir, ...(resume && { resume }) });
    openTab(link, name, dir);
  };

  const startHere = (link: ServerLink, dir: string) =>
    startSession(link, dir).catch((e) => setNotice(`Couldn't start a session in ${tildify(dir, link.home)}: ${errorText(e)}`));

  const openNewDialog = () => {
    if (connected.length) setDialog("new");
    else setNotice("No server is connected yet.");
  };

  const addServer = (s: Server) => {
    setDialog(null);
    if (servers?.some((x) => serverKey(x) === serverKey(s))) return;
    const next = [...(servers ?? []), s];
    setServers(next);
    void saveServers(next);
  };

  const removeServer = (link: ServerLink) => {
    const next = (servers ?? []).filter((s) => serverKey(s) !== link.key);
    setServers(next);
    void saveServers(next);
    const rest = tabs.filter((t) => t.linkKey !== link.key);
    setTabs(rest);
    if (!rest.some((t) => t.key === active)) setActive(rest[0]?.key ?? null);
  };

  // App shortcuts. Registered once; the ref always points at this render's handler.
  const onKey = useRef<(e: KeyboardEvent) => void>(() => {});
  onKey.current = (e) => {
    if (!e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === "k") setDialog((d) => (d === "palette" ? null : "palette"));
    else if (k === "n" && e.shiftKey) openNewDialog();
    else if (k === "n") {
      if (activeLink?.status === "connected" && activeTab?.dir) void startHere(activeLink, activeTab.dir);
      else openNewDialog();
    } else if (k === "w" && !e.shiftKey) {
      if (active) closeTab(active);
    } else if (k === "b" && !e.shiftKey) setFilesOpen((o) => !o);
    else if (/^[1-9]$/.test(e.key) && !e.shiftKey) {
      const t = tabs[Number(e.key) - 1];
      if (t) setActive(t.key);
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

  return (
    <div className="app" style={{ "--sidebar-width": `${sideWidth}px` } as CSSProperties}>
      <Sidebar
        links={linkList}
        activeTab={active}
        onOpen={(l, name) => openTab(l, name)}
        onNewIn={startHere}
        onAddServer={() => setDialog("add")}
        onRemoveServer={removeServer}
      />
      <Splitter label="Resize sidebar" onDrag={(x) => setSideWidth(clamp(x, 200, 480))} />
      <main className="main" ref={main}>
        <div className="center">
          <div className="tabbar" role="tablist">
            {tabs.map((t, i) => {
              const s = sessionOf(t);
              const link = links.get(t.linkKey);
              return (
                <div
                  key={t.key}
                  role="tab"
                  aria-selected={t.key === active}
                  className={"tab" + (t.key === active ? " active" : "")}
                  title={`${s?.title ?? t.name}\n${link ? tildify(t.dir, link.home) : t.dir}${i < 9 ? `\n⌘${i + 1}` : ""}`}
                  onMouseDown={(e) => e.button === 0 && setActive(t.key)}
                  onAuxClick={(e) => e.button === 1 && closeTab(t.key)}
                >
                  {s?.state === "waiting" && <span className="dot" />}
                  <span className="tab-title">{s?.title ?? t.name}</span>
                  <button
                    className="tab-close"
                    aria-label="Close tab"
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={() => closeTab(t.key)}
                  >
                    ×
                  </button>
                </div>
              );
            })}
            <div className="tabbar-fill" />
            <button
              className="icon-button"
              title={filesOpen ? "Hide files (⌘B)" : "Show files (⌘B)"}
              aria-label="Toggle files"
              aria-pressed={filesOpen}
              onClick={() => setFilesOpen((o) => !o)}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
                <rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" />
                <path d="M9.5 3v10" stroke="currentColor" />
                {filesOpen && <rect x="10" y="3" width="4" height="10" rx="1" fill="currentColor" opacity="0.35" />}
              </svg>
            </button>
          </div>
          <div className="terms">
            {tabs.map((t) => {
              const link = links.get(t.linkKey);
              return (
                link && (
                  <TerminalView key={t.key} link={link} name={t.name} active={t.key === active} onClose={() => closeTab(t.key)} />
                )
              );
            })}
            {!tabs.length && <EmptyCenter />}
          </div>
        </div>
        {filesOpen && (
          <Splitter
            label="Resize files"
            onDrag={(x) => {
              const r = main.current!.getBoundingClientRect();
              setFilesShare(clamp((r.right - x) / r.width, 0.2, 0.75));
            }}
          />
        )}
        <div className="files-wrap" hidden={!filesOpen} style={{ width: `${filesShare * 100}%` }}>
          <FilesPane
            link={activeLink}
            dir={activeTab?.dir || null}
            collapsed={!filesOpen}
            onReveal={() => setFilesOpen(true)}
          />
        </div>
      </main>

      {dialog === "palette" && <Palette links={linkList} onPick={(l, name) => openTab(l, name)} onClose={() => setDialog(null)} />}
      {dialog === "new" && connected.length > 0 && (
        <NewSessionDialog
          links={connected}
          initial={activeLink?.status === "connected" ? activeLink : connected[0]}
          onStart={startSession}
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

function EmptyCenter() {
  return (
    <div className="empty-center">
      <p>Open a session from the list, or start a new one.</p>
      <dl className="keys">
        <dt>⌘K</dt>
        <dd>Jump to a session</dd>
        <dt>⌘N</dt>
        <dd>New session in the current folder</dd>
        <dt>⌘⇧N</dt>
        <dd>New session in another folder</dd>
        <dt>⌘B</dt>
        <dd>Show or hide files</dd>
      </dl>
    </div>
  );
}
