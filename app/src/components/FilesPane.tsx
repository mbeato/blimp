import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import type * as Monaco from "monaco-editor/editor/editor.api";
import { ApiError, type DirEntry, type FileBody } from "../lib/api";
import { errorText, type LinkStatus, type ServerLink } from "../lib/connection";
import {
  baseName,
  collapse,
  decodeText,
  formatSize,
  initialSync,
  joinPath,
  mergeWatch,
  nextSync,
  parentDir,
  viewerFor,
  watchPaths,
  type Sync,
  type SyncEffect,
  type SyncEvent,
  type Viewer,
} from "../lib/files";
import { tildify } from "../lib/sidebar";
import { ImageView, MarkdownView, PdfView, ViewerBoundary } from "./FileViews";
import { QuickOpen } from "./QuickOpen";

// Monaco is big, so it loads the first time a text file opens.
let monaco: typeof Monaco | null = null;
let monacoLoad: Promise<typeof Monaco> | null = null;
const loadMonaco = () => (monacoLoad ??= import("../lib/monaco").then((m) => (monaco = m.monaco)));

// The files pane keeps one workspace per (server, session folder) it has shown. Switching session
// tabs hides one and shows another, so unsaved edits and open folders survive the switch; a hidden
// workspace with no open files is dropped.
// link: the active tab's server. dir: the active tab's session folder. collapsed: hidden with ⌘B
// (the pane stays mounted so edits survive). onReveal: show the pane (⌘P while it's hidden).
export function FilesPane(props: { link: ServerLink | null; dir: string | null; collapsed: boolean; onReveal: () => void }) {
  type Space = { key: string; link: ServerLink; dir: string };
  const [spaces, setSpaces] = useState<Space[]>([]);
  const openCounts = useRef(new Map<string, number>()).current;
  const activeKey = props.link && props.dir ? `${props.link.key}\n${props.dir}` : null;

  useEffect(() => {
    setSpaces((list) => {
      // A server removed and added again is a new link object with the same key. React keeps the
      // workspace (same key) and it switches to the new link: see its [link] effects.
      const kept = list.filter((s) =>
        s.key === activeKey ? s.link === props.link : (openCounts.get(s.key) ?? 0) > 0,
      );
      if (activeKey && !kept.some((s) => s.key === activeKey)) kept.push({ key: activeKey, link: props.link!, dir: props.dir! });
      return kept;
    });
  }, [activeKey, props.link]);

  // blimpd keeps one watch set per events socket, so merge every workspace's set per server.
  const watches = useRef(new Map<string, { link: ServerLink; paths: string[] }>()).current;
  const sent = useRef(new Map<ServerLink, string>()).current;
  const syncWatches = () => {
    const byLink = new Map<ServerLink, string[][]>();
    for (const l of sent.keys()) byLink.set(l, []);
    for (const w of watches.values()) byLink.set(w.link, [...(byLink.get(w.link) ?? []), w.paths]);
    for (const [link, sets] of byLink) {
      const paths = mergeWatch(sets);
      const k = paths.join("\n");
      if (sent.get(link) === k) continue;
      link.watch(paths);
      if (paths.length) sent.set(link, k);
      else sent.delete(link);
    }
  };
  const onWatch = (key: string, link: ServerLink, paths: string[] | null) => {
    if (paths) watches.set(key, { link, paths });
    else watches.delete(key);
    syncWatches();
  };

  return (
    <div className="files">
      {spaces.map((s) => (
        <Workspace
          key={s.key}
          link={s.link}
          status={s.link.status}
          root={s.dir}
          current={s.key === activeKey}
          shown={s.key === activeKey && !props.collapsed}
          onReveal={props.onReveal}
          onCount={(n) => void openCounts.set(s.key, n)}
          onWatch={(paths) => onWatch(s.key, s.link, paths)}
          onRewatch={() => {
            sent.delete(s.link);
            syncWatches();
          }}
        />
      ))}
      {!activeKey && (
        <>
          <div className="files-head">Files</div>
          <div className="empty">Open a session to see its files.</div>
        </>
      )}
    </div>
  );
}

// An open file. Text and Markdown live in a Monaco model; images and PDFs keep their bytes.
type Doc = {
  path: string;
  name: string;
  phase: "loading" | "ready" | "error";
  error: string;
  viewer: Viewer;
  size: number;
  bytes: Uint8Array<ArrayBuffer>;
  text: string; // the server's text, which the Markdown preview shows until Monaco has loaded
  model: Monaco.editor.ITextModel | null;
  saved: number; // the model's alternative version id when it matched the server
  sync: Sync;
  viewState: Monaco.editor.ICodeEditorViewState | null;
  editing: boolean; // Markdown shown in Monaco instead of rendered
  deleted: boolean; // gone on the server; still open, and only an explicit Save writes it back
  notice: string; // why the last save failed
  unsub: () => void;
};

const newDoc = (path: string): Doc => ({
  path,
  name: baseName(path),
  phase: "loading",
  error: "",
  viewer: "text",
  size: 0,
  bytes: new Uint8Array(0),
  text: "",
  model: null,
  saved: 0,
  sync: initialSync(0),
  viewState: null,
  editing: false,
  deleted: false,
  notice: "",
  unsub: () => {},
});

const inEditor = (d: Doc | undefined) => !!d?.model && (d.viewer === "text" || d.editing);
const sameSync = (a: Sync, b: Sync) =>
  a.mtime === b.mtime && a.dirty === b.dirty && a.saving === b.saving && a.conflict === b.conflict;

function Workspace(props: {
  link: ServerLink;
  status: LinkStatus;
  root: string;
  current: boolean; // the active tab's folder
  shown: boolean; // current and the pane is open
  onReveal: () => void;
  onCount: (n: number) => void;
  onWatch: (paths: string[] | null) => void;
  onRewatch: () => void; // send the watch set again (blimpd drops the watch on a deleted file)
}) {
  const { link, root } = props;
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  // Like the server links in App, the tree and the open files are long-lived mutable objects
  // that async work and fs events update; React state only holds what's on screen.
  const expanded = useRef(new Set([root]));
  const listings = useRef(new Map<string, DirEntry[]>()).current;
  const docs = useRef(new Map<string, Doc>()).current;
  const [rootError, setRootError] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const [closing, setClosing] = useState<string | null>(null);
  const [quick, setQuick] = useState(false);
  const editorBox = useRef<HTMLDivElement>(null);
  const editor = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const editorDoc = useRef<Doc | null>(null);
  const activeDoc = active ? docs.get(active) : undefined;

  // ---- tree ----

  const refreshDir = async (dir: string) => {
    const api = link.api;
    if (!api) return;
    try {
      const l = await api.fsList(dir);
      listings.set(dir, l.entries.filter((e) => e.name !== ".git"));
      if (dir === root) setRootError("");
    } catch (e) {
      if (dir === root) setRootError(errorText(e));
      else if (e instanceof ApiError && (e.status === 404 || e.status === 403)) {
        listings.delete(dir);
        expanded.current = collapse(expanded.current, dir);
      }
    }
    rerender();
  };

  const toggleDir = (dir: string) => {
    if (expanded.current.has(dir)) expanded.current = collapse(expanded.current, dir);
    else {
      expanded.current = new Set(expanded.current).add(dir);
      void refreshDir(dir);
    }
    rerender();
  };

  // ---- open files ----

  const dispatch = (doc: Doc, e: SyncEvent): SyncEffect => {
    const r = nextSync(doc.sync, e);
    const changed = !sameSync(doc.sync, r.state);
    doc.sync = r.state;
    if (changed) rerender();
    return r.effect;
  };

  // Puts text into the doc's Monaco model, creating it the first time.
  const setModelText = (doc: Doc, m: typeof Monaco, text: string) => {
    if (!doc.model) {
      // Monaco picks the language from the path's extension. The query keeps models unique when
      // two workspaces open the same file.
      doc.model = m.editor.createModel(text, undefined, m.Uri.from({ scheme: "blimp", path: doc.path, query: String(Math.random()) }));
      const sub = doc.model.onDidChangeContent(() =>
        dispatch(doc, { type: "edit", dirty: doc.model!.getAlternativeVersionId() !== doc.saved }),
      );
      doc.unsub = () => sub.dispose();
    } else if (doc.model.getValue(undefined, true) !== text) {
      // Keep the cursor and scroll position when Claude edits the file you're looking at.
      const ed = editor.current?.getModel() === doc.model ? editor.current : null;
      const view = ed?.saveViewState();
      doc.model.setValue(text);
      if (view) ed!.restoreViewState(view);
    }
    doc.saved = doc.model.getAlternativeVersionId();
  };

  // Puts the server's copy in the doc: into its Monaco model for text, as bytes otherwise.
  const applyBody = async (doc: Doc, body: FileBody) => {
    let viewer = viewerFor(doc.name, body.bytes);
    const isText = viewer === "text" || viewer === "markdown";
    const text = isText ? decodeText(body.bytes) : null;
    if (isText && text === null) viewer = "binary"; // not UTF-8: see decodeText
    if (text !== null) {
      doc.text = text;
      if (viewer === "markdown" && !monaco) {
        // The preview doesn't need Monaco, so it shows now instead of waiting for Monaco's first
        // load (seconds on a cold start). The model, for Edit and saving, follows with the latest text.
        void loadMonaco().then(
          (m) => {
            if (docs.get(doc.path) !== doc || doc.model) return;
            setModelText(doc, m, doc.text);
            rerender();
          },
          () => {},
        );
      } else {
        const m = await loadMonaco();
        if (docs.get(doc.path) !== doc) return;
        setModelText(doc, m, text);
      }
    } else {
      doc.bytes = body.bytes;
    }
    doc.viewer = viewer;
    doc.size = body.bytes.length;
    doc.phase = "ready";
    doc.error = "";
    dispatch(doc, { type: "reloaded", mtime: body.mtime });
    rerender();
  };

  const loadDoc = async (doc: Doc) => {
    try {
      if (!link.api) throw new Error("Not connected.");
      await applyBody(doc, await link.api.fsRead(doc.path));
    } catch (e) {
      doc.phase = "error";
      doc.error = e instanceof ApiError && e.status === 413 ? "This file is over 50 MB." : errorText(e);
      rerender();
    }
  };

  const openFile = (path: string) => {
    if (!docs.has(path)) {
      const doc = newDoc(path);
      docs.set(path, doc);
      void loadDoc(doc);
    }
    setActive(path);
    setClosing(null);
  };

  // An fs event for an open file: read it, then reload silently or show the bar.
  const checkRemote = async (doc: Doc) => {
    if (doc.phase !== "ready" || !link.api) return;
    let body: FileBody;
    try {
      body = await link.api.fsRead(doc.path);
    } catch (e) {
      // Deleted: keep what's open and say so. Unreadable for another reason: keep it quietly.
      if (e instanceof ApiError && e.status === 404 && docs.get(doc.path) === doc && !doc.deleted) {
        doc.deleted = true;
        rerender();
      }
      return;
    }
    if (docs.get(doc.path) !== doc) return;
    if (doc.deleted) {
      doc.deleted = false; // it came back
      props.onRewatch();
      rerender();
    }
    if (dispatch(doc, { type: "remote", mtime: body.mtime }) === "reload") await applyBody(doc, body);
  };

  const reloadDoc = async (doc: Doc) => {
    try {
      await applyBody(doc, await link.api!.fsRead(doc.path));
    } catch (e) {
      doc.notice = `Couldn't reload: ${errorText(e)}`;
      rerender();
    }
  };

  // ⌘S sends baseMtime, so a file changed on the server meanwhile gets a 409 and the bar.
  // Keep mine sends none and overwrites.
  const save = async (doc: Doc, keepMine = false) => {
    const model = doc.model;
    // A deleted file saves even without edits: that's how it comes back.
    if (!model || doc.sync.saving || (!doc.sync.dirty && !keepMine && !doc.deleted)) return;
    const version = model.getAlternativeVersionId();
    dispatch(doc, { type: "save" });
    try {
      if (!link.api) throw new Error("Not connected.");
      // preserveBOM: a file that had a BOM keeps it.
      const { mtime } = await link.api.fsWrite(doc.path, model.getValue(undefined, true), keepMine ? undefined : doc.sync.mtime);
      if (docs.get(doc.path) !== doc) return;
      doc.saved = version;
      doc.notice = "";
      if (doc.deleted) {
        doc.deleted = false;
        props.onRewatch();
      }
      dispatch(doc, { type: "saved", mtime });
      // Typing while the save was in flight leaves the file dirty.
      dispatch(doc, { type: "edit", dirty: model.getAlternativeVersionId() !== version });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) return void dispatch(doc, { type: "rejected" });
      doc.notice = `Couldn't save: ${errorText(e)}`;
      dispatch(doc, { type: "failed" });
      rerender();
    }
  };

  const closeDoc = (path: string, discard = false) => {
    const doc = docs.get(path);
    if (!doc) return;
    if (doc.sync.dirty && !discard) return setClosing(path);
    const order = [...docs.keys()];
    if (editor.current && editor.current.getModel() === doc.model) editor.current.setModel(null);
    if (editorDoc.current === doc) editorDoc.current = null;
    doc.unsub();
    doc.model?.dispose();
    docs.delete(path);
    setClosing(null);
    if (active === path) {
      const i = order.indexOf(path);
      const rest = order.filter((p) => p !== path);
      setActive(rest[Math.min(i, rest.length - 1)] ?? null);
    }
    rerender();
  };

  // ---- live updates ----

  const onFs = useRef((_: string[]) => {});
  onFs.current = (paths) => {
    for (const p of paths) {
      if (expanded.current.has(p)) {
        void refreshDir(p);
        // A deleted file's own watch ended with it, so its folder says when it comes back.
        for (const d of docs.values()) if (d.deleted && parentDir(d.path) === p) void checkRemote(d);
      }
      const doc = docs.get(p);
      if (doc) void checkRemote(doc);
    }
  };
  useEffect(() => link.onFs((paths) => onFs.current(paths)), [link]);

  // On first connect and after every reconnect (events may have been missed while offline).
  useEffect(() => {
    if (props.status !== "connected") return;
    for (const dir of expanded.current) void refreshDir(dir);
    for (const doc of docs.values()) void (doc.phase === "error" ? loadDoc(doc) : checkRemote(doc));
  }, [props.status]);

  const watchKey = watchPaths(expanded.current, docs.keys()).join("\n");
  // Also on a new link (the server was removed and added again), so the new link gets the set.
  useEffect(() => void props.onWatch(watchKey ? watchKey.split("\n") : []), [watchKey, link]);
  useEffect(() => () => void props.onWatch(null), []);
  useEffect(() => void props.onCount(docs.size), [docs.size]);

  // ---- editor ----

  // One Monaco editor per workspace; switching tabs swaps its model and keeps each file's view.
  useEffect(() => {
    if (!inEditor(activeDoc) || !monaco) return;
    const doc = activeDoc!;
    if (!editor.current) {
      editor.current = monaco.editor.create(editorBox.current!, {
        model: null,
        automaticLayout: true,
        fontSize: 13,
        fontFamily: '"SF Mono", Menlo, monospace',
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        renderLineHighlight: "line",
        fixedOverflowWidgets: true,
      });
    }
    const ed = editor.current;
    if (ed.getModel() === doc.model) return;
    if (editorDoc.current) editorDoc.current.viewState = ed.saveViewState();
    ed.setModel(doc.model);
    if (doc.viewState) ed.restoreViewState(doc.viewState);
    editorDoc.current = doc;
    if (props.shown) ed.focus();
  });

  useEffect(
    () => () => {
      editor.current?.dispose();
      for (const d of docs.values()) (d.unsub(), d.model?.dispose());
    },
    [],
  );

  // ⌘P works while the pane is hidden (it shows it); ⌘S only while it's on screen.
  const onKey = useRef<(e: KeyboardEvent) => void>(() => {});
  onKey.current = (e) => {
    if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    const k = e.key.toLowerCase();
    if (k === "p") {
      props.onReveal();
      setQuick(true);
    } else if (k === "s" && props.shown) {
      if (activeDoc) void save(activeDoc);
    } else return;
    e.preventDefault();
  };
  useEffect(() => {
    if (!props.current) return;
    const h = (e: KeyboardEvent) => onKey.current(e);
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [props.current]);

  // ---- view ----

  const renderDir = (dir: string, depth: number): ReactNode =>
    listings.get(dir)?.map((e) => {
      const path = joinPath(dir, e.name);
      const open = e.kind === "dir" && expanded.current.has(path);
      return (
        <div key={path} role="none">
          <button
            className={"tree-row" + (path === active ? " selected" : "")}
            style={{ paddingLeft: 8 + depth * 12 }}
            role="treeitem"
            aria-expanded={e.kind === "dir" ? open : undefined}
            title={e.name}
            onClick={() => (e.kind === "dir" ? toggleDir(path) : openFile(path))}
          >
            <span className={"tree-twisty" + (open ? " open" : "")}>{e.kind === "dir" ? "›" : ""}</span>
            <span className="tree-name">{e.name}</span>
          </button>
          {open && renderDir(path, depth + 1)}
        </div>
      );
    });

  const doc = activeDoc;
  const closingDoc = closing ? docs.get(closing) : undefined;

  return (
    <div className="workspace" hidden={!props.current}>
      <div className="files-top">
        <div className="files-head files-root" title={root}>
          {tildify(root, link.home)}
        </div>
        <div className="ftabs" role="tablist">
          {[...docs.values()].map((d) => (
            <div
              key={d.path}
              role="tab"
              aria-selected={d.path === active}
              className={"tab" + (d.path === active ? " active" : "")}
              title={tildify(d.path, link.home)}
              onMouseDown={(e) => e.button === 0 && setActive(d.path)}
              onAuxClick={(e) => e.button === 1 && closeDoc(d.path)}
            >
              <span className="tab-title">{d.name}</span>
              <button
                className={"tab-close" + (d.sync.dirty ? " dirty" : "")}
                aria-label={d.sync.dirty ? "Close file (unsaved changes)" : "Close file"}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => closeDoc(d.path)}
              >
                {d.sync.dirty ? "●" : "×"}
              </button>
            </div>
          ))}
          <div className="tabbar-fill" />
          {doc?.viewer === "markdown" && doc.model && (
            <button
              className="ftabs-toggle"
              aria-pressed={doc.editing}
              onClick={() => {
                doc.editing = !doc.editing;
                rerender();
              }}
            >
              {doc.editing ? "Preview" : "Edit"}
            </button>
          )}
        </div>
      </div>
      <div className="files-body">
        <div className="tree" role="tree">
          {rootError ? <p className="view-note error">{rootError}</p> : renderDir(root, 0)}
        </div>
        <div className="viewer">
          {closingDoc && (
            <div className="fbar" role="alert">
              <span>{closingDoc.name} has unsaved changes.</span>
              <button onClick={() => void save(closingDoc).then(() => !closingDoc.sync.dirty && closeDoc(closingDoc.path))}>
                Save
              </button>
              <button onClick={() => closeDoc(closingDoc.path, true)}>Don't save</button>
              <button onClick={() => setClosing(null)}>Cancel</button>
            </div>
          )}
          {doc?.deleted && (
            <div className="fbar" role="alert">
              <span>Deleted on the server</span>
              {doc.model && <button onClick={() => void save(doc)}>Save</button>}
              <button onClick={() => closeDoc(doc.path)}>Close</button>
            </div>
          )}
          {doc?.sync.conflict && !doc.deleted && (
            <div className="fbar" role="alert">
              <span>Changed on the server</span>
              <button onClick={() => void reloadDoc(doc)}>Reload</button>
              <button onClick={() => void save(doc, true)}>Keep mine</button>
            </div>
          )}
          {doc?.notice && (
            <div className="fbar error" role="alert">
              <span>{doc.notice}</span>
              <button
                onClick={() => {
                  doc.notice = "";
                  rerender();
                }}
              >
                OK
              </button>
            </div>
          )}
          <div className="fview">
            <div className="editor-box" ref={editorBox} hidden={!inEditor(doc)} />
            {!doc && <div className="empty">{docs.size ? "" : "Pick a file, or press ⌘P to open one by name."}</div>}
            {doc?.phase === "loading" && <div className="empty">Loading…</div>}
            {doc?.phase === "error" && <div className="empty error">{doc.error}</div>}
            {doc?.phase === "ready" && !inEditor(doc) && (
              // Keyed by file, so a failed viewer resets on the next file and a Markdown view
              // never shows one file's HTML under another's path.
              <ViewerBoundary key={doc.path}>
                {doc.viewer === "markdown" && (
                  <MarkdownView
                    path={doc.path}
                    text={doc.model ? doc.model.getValue() : doc.text}
                    onOpen={openFile}
                    load={(p) => (link.api ? link.api.fsRead(p) : Promise.reject(new Error("Not connected.")))}
                  />
                )}
                {doc.viewer === "image" && <ImageView name={doc.name} bytes={doc.bytes} />}
                {doc.viewer === "pdf" && <PdfView bytes={doc.bytes} />}
                {doc.viewer === "binary" && (
                  <div className="empty">
                    Can't show this file
                    <div className="empty-sub">{formatSize(doc.size)}</div>
                  </div>
                )}
              </ViewerBoundary>
            )}
          </div>
        </div>
      </div>
      {quick && (
        <QuickOpen
          api={link.api}
          root={root}
          onPick={(rel) => {
            setQuick(false);
            openFile(joinPath(root, rel));
          }}
          onClose={() => setQuick(false)}
        />
      )}
    </div>
  );
}
