import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import type * as Monaco from "monaco-editor/editor/editor.api";
import { ApiError, type BrowserTab, type DirEntry, type FileBody, type Port } from "../lib/api";
import { errorText, type ServerLink } from "../lib/connection";
import {
  baseName,
  collapse,
  decodeText,
  formatSize,
  hasPreview,
  initialSync,
  joinPath,
  nextSync,
  parentDir,
  viewerFor,
  watchPaths,
  type Sync,
  type SyncEffect,
  type SyncEvent,
  type Viewer,
} from "../lib/files";
import { HOME, hostOf, serverTabTarget } from "../lib/browser";
import { galleryDir, galleryKey } from "../lib/gallery";
import { byOrder, moved, startReorder } from "../lib/reorder";
import { tildify } from "../lib/sessions";
import { getSettings, onSettings } from "../lib/settings";
import { download, freeName, pickFiles, upload, type Item } from "../lib/transfers";
import { Dialog } from "./Dialog";
import { HtmlView, ImageView, MarkdownView, PdfView, ViewerBoundary } from "./FileViews";
import { Gallery } from "./Gallery";
import { PageView } from "./PageView";
import type { PaneActions } from "./TerminalPane";
import { QuickOpen } from "./QuickOpen";
import { Splitter } from "./Splitter";

const galleryIcon = (
  <svg className="page-icon" width="14" height="14" viewBox="0 0 16 16" aria-hidden>
    <path d="M2.5 2.5h4.5v4.5h-4.5zM9 2.5h4.5v4.5h-4.5zM2.5 9h4.5v4.5h-4.5zM9 9h4.5v4.5h-4.5z" fill="none" stroke="currentColor" />
  </svg>
);

const pageIcon = (
  <svg className="page-icon" width="14" height="14" viewBox="0 0 16 16" aria-hidden>
    <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" />
    <path d="M2.5 8h11M8 2.5c-2 2-2 9 0 11M8 2.5c2 2 2 9 0 11" fill="none" stroke="currentColor" />
  </svg>
);

// Monaco is big, so it loads the first time a text file opens.
let monaco: typeof Monaco | null = null;
let monacoLoad: Promise<typeof Monaco> | null = null;
const loadMonaco = () => (monacoLoad ??= import("../lib/monaco").then((m) => (monaco = m.monaco)));

// Edits save on their own this long after the last keystroke (and at once when focus leaves).
export const AUTOSAVE_MS = 1000;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

// Opens a file in a tab, at a line (and column) if given. Set by the workbench for the
// terminal's ⌘-click.
export type Opener = (path: string, line?: number, col?: number) => void;

// Opens a server port in a browser tab (or brings its tab forward); with none, a new browser tab;
// with a server browser tab's address, that address (lib/browser.ts serverTabTarget).
export type PageOpener = (p?: Pick<Port, "port" | "host"> | string) => void;

// Files dropped on the window (from Finder): into this folder, or null for the folder new files
// go in (the one last clicked in the tree).
export type FileDrop = (dir: string | null, items: Item[]) => void;

// Right-click on a tree row or a file tab.
type Menu = { x: number; y: number; path: string; kind: "file" | "dir" };
// Names an upload would take that are already there: what to do with them.
type Ask = { dir: string; names: string[]; resolve: (choice: "replace" | "keep" | "skip" | null) => void };

// An open file. Text, Markdown and HTML live in a Monaco model; images and PDFs keep their bytes.
type Doc = {
  path: string;
  name: string;
  phase: "loading" | "ready" | "error";
  error: string;
  viewer: Viewer;
  size: number;
  bytes: Uint8Array<ArrayBuffer>;
  text: string; // the server's text, which the Markdown or HTML preview shows until Monaco has loaded
  model: Monaco.editor.ITextModel | null;
  saved: number; // the model's alternative version id when it matched the server
  sync: Sync;
  viewState: Monaco.editor.ICodeEditorViewState | null;
  editing: boolean; // Markdown or HTML shown in Monaco instead of rendered
  deleted: boolean; // gone on the server; still open, and only an explicit Save writes it back
  notice: string; // why the last save failed
  reveal: { line: number; col?: number } | null; // where to put the cursor once it's in the editor
  timer: ReturnType<typeof setTimeout> | undefined; // the pending autosave
  inflight: Promise<void> | null; // the save being sent
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
  reveal: null,
  timer: undefined,
  inflight: null,
  unsub: () => {},
});

const inEditor = (d: Doc | undefined) => !!d?.model && (d.viewer === "text" || d.editing);
const sameSync = (a: Sync, b: Sync) =>
  a.mtime === b.mtime && a.dirty === b.dirty && a.saving === b.saving && a.conflict === b.conflict;

type Creating = { kind: "file" | "dir"; dir: string; error: string };

// Tells apart the workbenches sharing a server link: each tab has its own watch set.
let workbenches = 0;

// One project tab, laid out like VS Code: the file tree on the left, open files in tabs at the
// top right, and the terminal pane (props.terminal) below them. With no file open the terminal
// takes the whole right side, except on Home, where props.welcome fills the top.
// front: this tab is the one shown (the others stay mounted, hidden, so nothing is lost).
// showFiles, showTerm: the window's show/hide buttons for the tree and the terminal.
export function Workbench(props: {
  link: ServerLink;
  root: string;
  front: boolean;
  showFiles: boolean;
  showTerm: boolean;
  // false: browser tabs are hidden (the globe at the top right); opening one shows them again (onShowBrowsers).
  showBrowsers: boolean;
  onShowBrowsers: () => void;
  // The browser tabs' order, once dragged (their ids); onPageOrder: dragged into a new one.
  pageOrder?: string[];
  onPageOrder: (ids: string[]) => void;
  welcome?: ReactNode;
  terminal: ReactNode;
  opener: { current: Opener };
  onDrop: { current: FileDrop };
  pages: { current: PageOpener };
  // The terminal pane's, for a browser tab's Send to session.
  pane: { current: PaneActions };
  onNotice: (text: string) => void;
}) {
  const { link, root } = props;
  const id = useRef(++workbenches).current;
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  // The tree and the open files are long-lived mutable objects that async work and fs events
  // update; React state only holds what's on screen.
  const expanded = useRef(new Set([root]));
  const listings = useRef(new Map<string, DirEntry[]>()).current;
  const docs = useRef(new Map<string, Doc>()).current;
  // Folders shown as a gallery ("gallery:<dir>", lib/gallery.ts), after the file tabs. ticks: bumped
  // per folder when it changes on the server, so its gallery lists it again.
  const galleries = useRef(new Set<string>()).current;
  const ticks = useRef(new Map<string, number>()).current;
  // Saves not finished yet (sent, or waiting for the one before). Models are disposed only after
  // these finish, so leaving a project mid-save still sends what was typed meanwhile.
  const pending = useRef(new Set<Promise<void>>()).current;
  const [rootError, setRootError] = useState("");
  const [active, setActiveState] = useState<string | null>(null);
  const [closing, setClosing] = useState<string | null>(null);
  const [quick, setQuick] = useState(false);
  const [treeWidth, setTreeWidth] = useState(240);
  const [editorShare, setEditorShare] = useState(0.6);
  // The folder new files and folders go in: the last folder clicked, or the clicked file's folder.
  const [target, setTarget] = useState(root);
  const [creating, setCreating] = useState<Creating | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const right = useRef<HTMLDivElement>(null);
  const editorBox = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
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

  const expand = (dir: string) => {
    if (expanded.current.has(dir)) return;
    expanded.current = new Set(expanded.current).add(dir);
    void refreshDir(dir);
  };

  const toggleDir = (dir: string) => {
    setTarget(dir);
    if (expanded.current.has(dir)) expanded.current = collapse(expanded.current, dir);
    else expand(dir);
    rerender();
  };

  const startCreate = (kind: Creating["kind"]) => {
    const dir = listings.has(target) || target === root ? target : root;
    expand(dir);
    setCreating({ kind, dir, error: "" });
  };

  const finishCreate = async (name: string) => {
    const c = creating;
    if (!c) return;
    name = name.trim();
    if (!name) return setCreating(null);
    if (name.includes("/") || name === "." || name === "..") return setCreating({ ...c, error: "A name can't contain / or be . or .." });
    const path = joinPath(c.dir, name);
    try {
      if (!link.api) throw new Error("Not connected.");
      await (c.kind === "dir" ? link.api.fsMkdir(path) : link.api.fsCreate(path));
    } catch (e) {
      return setCreating({ ...c, error: e instanceof ApiError && e.status === 409 ? `${name} already exists.` : errorText(e) });
    }
    setCreating(null);
    await refreshDir(c.dir);
    if (c.kind === "dir") {
      expand(path);
      setTarget(path);
    } else openFile(path);
  };

  // ---- uploads ----

  // Into dir (else the folder new files go in). Names already there: one question for all of
  // them (Replace, Keep both, Skip); the rest go up as new.
  const uploadInto: FileDrop = async (dir, items) => {
    const api = link.api;
    if (!api || !items.length) return;
    const into = dir ?? (listings.has(target) || target === root ? target : root);
    let taken: Set<string>;
    try {
      taken = new Set((await api.fsList(into)).entries.map((e) => e.name));
    } catch {
      return;
    }
    const clash = items.filter((i) => taken.has(i.name)).map((i) => i.name);
    const choice = clash.length ? await new Promise<"replace" | "keep" | "skip" | null>((resolve) => setAsk({ dir: into, names: clash, resolve })) : null;
    setAsk(null);
    if (clash.length && !choice) return;
    for (const item of items) {
      let as = item.name;
      let mode: "new" | "replace" = "new";
      if (taken.has(item.name)) {
        if (choice === "skip") continue;
        if (choice === "replace") mode = "replace";
        else as = freeName(item.name, taken);
      }
      taken.add(as);
      await upload(link, into, item, mode, as);
    }
    expand(into);
    await refreshDir(into);
  };
  props.onDrop.current = uploadInto;

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
      // Monaco picks the language from the path's extension. The query keeps models unique if
      // the same file is open in two windows' workbenches.
      doc.model = m.editor.createModel(text, undefined, m.Uri.from({ scheme: "blimp", path: doc.path, query: String(Math.random()) }));
      const sub = doc.model.onDidChangeContent(() => {
        dispatch(doc, { type: "edit", dirty: doc.model!.getAlternativeVersionId() !== doc.saved });
        if (doc.sync.dirty) schedule(doc);
      });
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
    const isText = viewer === "text" || hasPreview(viewer);
    const text = isText ? decodeText(body.bytes) : null;
    if (isText && text === null) viewer = "binary"; // not UTF-8: see decodeText
    // Opened at a line (⌘-click in the terminal): show Markdown or HTML as source, where lines are.
    if (hasPreview(viewer) && doc.reveal) doc.editing = true;
    if (text !== null) {
      doc.text = text;
      if (hasPreview(viewer) && !monaco && !doc.editing) {
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

  // Switching files saves the one you leave (with autosave on).
  const setActive = (path: string | null) => {
    const prev = active ? docs.get(active) : undefined;
    if (prev && prev.path !== path && getSettings().autosave) flush(prev);
    setActiveState(path);
  };

  const openFile: Opener = (path, line, col) => {
    let doc = docs.get(path);
    if (!doc) {
      doc = newDoc(path);
      docs.set(path, doc);
      if (line) doc.reveal = { line, col };
      void loadDoc(doc);
    } else if (line) {
      doc.reveal = { line, col };
      if (hasPreview(doc.viewer)) doc.editing = true;
    }
    setActive(path);
    setClosing(null);
    rerender();
  };
  props.opener.current = openFile;

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
      link.watch(id, watching());
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

  // Saves send the mtime the editor's text started from, so a file Claude changed meanwhile gets
  // a 409 and the "Changed on the server" bar instead of being overwritten. Keep mine sends none.
  // explicit: ⌘S, Save or Keep mine. Autosave leaves a deleted file deleted and a conflict alone.
  const save = (doc: Doc, opts: { keepMine?: boolean; explicit?: boolean } = {}) => {
    const p = saveNow(doc, opts);
    pending.add(p);
    void p.finally(() => pending.delete(p));
    return p;
  };
  const saveNow = async (doc: Doc, opts: { keepMine?: boolean; explicit?: boolean }) => {
    clearTimeout(doc.timer);
    doc.timer = undefined;
    // One save at a time per file: two sent with the same baseMtime would 409 each other.
    while (doc.inflight) await doc.inflight;
    const model = doc.model;
    if (!model || model.isDisposed() || docs.get(doc.path) !== doc) return;
    if (!opts.explicit && (doc.deleted || doc.sync.conflict)) return;
    // A deleted file saves even without edits: that's how it comes back.
    if (!doc.sync.dirty && !opts.keepMine && !doc.deleted) return;
    const version = model.getAlternativeVersionId();
    dispatch(doc, { type: "save" });
    const send = async () => {
      try {
        if (!link.api) throw new Error("Not connected.");
        // preserveBOM: a file that had a BOM keeps it.
        const text = model.getValue(undefined, true);
        const { mtime } = await link.api.fsWrite(doc.path, text, opts.keepMine ? undefined : doc.sync.mtime);
        if (docs.get(doc.path) !== doc) return;
        doc.saved = version;
        doc.notice = "";
        if (doc.deleted) {
          doc.deleted = false;
          link.watch(id, watching());
        }
        dispatch(doc, { type: "saved", mtime });
        // Typing while the save was in flight leaves the file dirty: save that too, later.
        if (model.isDisposed()) return;
        dispatch(doc, { type: "edit", dirty: model.getAlternativeVersionId() !== version });
        if (doc.sync.dirty) schedule(doc);
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) return void dispatch(doc, { type: "rejected" });
        doc.notice = `Couldn't save: ${errorText(e)}`;
        dispatch(doc, { type: "failed" });
        rerender();
      }
    };
    const p = send();
    doc.inflight = p;
    await p;
    if (doc.inflight === p) doc.inflight = null;
  };

  // Settings > Autosave off: edits wait for ⌘S (closing a tab or the window still saves first).
  const schedule = (doc: Doc) => {
    if (!getSettings().autosave) return;
    clearTimeout(doc.timer);
    doc.timer = setTimeout(() => void save(doc), AUTOSAVE_MS);
  };
  const flush = (doc: Doc) => {
    if (doc.timer || doc.sync.dirty) void save(doc);
  };
  const flushAll = () => docs.forEach(flush);

  // Closing saves first; the prompt only comes up when that save doesn't go through.
  const closeDoc = async (path: string, discard = false) => {
    const doc = docs.get(path);
    if (!doc) return;
    if (!discard && (doc.sync.dirty || doc.timer)) {
      await save(doc);
      if (doc.sync.dirty) return setClosing(path);
    }
    clearTimeout(doc.timer);
    const order = [...docs.keys(), ...galleries];
    if (editor.current && editor.current.getModel() === doc.model) editor.current.setModel(null);
    if (editorDoc.current === doc) editorDoc.current = null;
    doc.unsub();
    doc.model?.dispose();
    docs.delete(path);
    setClosing(null);
    // Functional: the save above may have taken a while, and another tab picked meanwhile stays.
    const i = order.indexOf(path);
    const rest = order.filter((p) => p !== path);
    setActiveState((a) => (a === path ? (rest[Math.min(i, rest.length - 1)] ?? null) : a));
    rerender();
  };

  // ---- browser tabs ----

  // This folder's tabs in the server's browser ("tab:<id>"), after the file tabs. Their keys share
  // `active` with file paths, which are absolute and so never look like one. A tab opened here is
  // in `opening` until the server lists it; one closed here is in `gone` until it stops listing it.
  const opening = useRef(new Set<string>()).current;
  const gone = useRef(new Set<string>()).current;
  const pages = new Map(
    byOrder(link.browserTabs.filter((t) => t.folder === root), (t) => t.id, props.pageOrder)
      .map((t): [string, BrowserTab] => [`tab:${t.id}`, t])
      .filter(([k]) => !gone.has(k)),
  );
  const openTab = (url: string) => {
    const api = link.api;
    if (!api) return;
    api.openBrowserTab(root, url).then(
      ({ id }) => {
        opening.add(`tab:${id}`);
        setActive(`tab:${id}`);
      },
      (e) => props.onNotice(`Couldn't open a browser tab: ${errorText(e)}`),
    );
  };
  // A server port (its tab, if one is open on it), an address, or (none) a new tab at Google.
  const openPage: PageOpener = (p) => {
    if (!props.showBrowsers) (lastPage.current = null), props.onShowBrowsers();
    if (!p) return openTab(HOME);
    if (typeof p === "string") return openTab(p);
    const have = [...pages].find(([, t]) => {
      const to = serverTabTarget(t.url);
      return "port" in to && to.port === p.port;
    });
    if (have) return setActive(have[0]);
    openTab(`http://${p.host === "::1" ? "[::1]" : "localhost"}:${p.port}/`);
  };
  props.pages.current = openPage;

  const closePage = (key: string) => {
    const tab = pages.get(key);
    if (tab)
      void link.api?.closeBrowserTab(tab.id).catch((e) => {
        // Still open on the server: back in the strip.
        gone.delete(key);
        props.onNotice(`Couldn't close the tab: ${errorText(e)}`);
        rerender();
      });
    gone.add(key);
    opening.delete(key);
    const order = [...docs.keys(), ...galleries, ...pages.keys()];
    const rest = order.filter((k) => k !== key);
    const i = order.indexOf(key);
    setActiveState((a) => (a === key ? (rest[Math.min(i, rest.length - 1)] ?? null) : a));
    rerender();
  };

  // ---- galleries ----

  const openGallery = (dir: string) => {
    galleries.add(galleryKey(dir));
    setActive(galleryKey(dir));
    rerender();
  };
  const closeGallery = (key: string) => {
    const order = [...docs.keys(), ...galleries, ...pages.keys()];
    galleries.delete(key);
    const rest = order.filter((k) => k !== key);
    const i = order.indexOf(key);
    setActiveState((a) => (a === key ? (rest[Math.min(i, rest.length - 1)] ?? null) : a));
    rerender();
  };
  const bump = (dir: string) => ticks.set(dir, (ticks.get(dir) ?? 0) + 1);

  // A file tab, a gallery or a browser tab.
  const closeTab = (key: string) => (key.startsWith("tab:") ? closePage(key) : galleryDir(key) !== null ? closeGallery(key) : void closeDoc(key));
  // Hidden: the browser tab in front gives way to the last file (none: the terminal fills the
  // window), and comes back in front when they're shown. Hidden, their views aren't mounted.
  const lastPage = useRef<string | null>(null);
  const shownPages = props.showBrowsers ? pages : new Map<string, BrowserTab>();
  useEffect(() => {
    if (!props.showBrowsers && active?.startsWith("tab:")) {
      lastPage.current = active;
      setActiveState([...docs.keys(), ...galleries].at(-1) ?? null);
    } else if (props.showBrowsers && lastPage.current) {
      if (pages.has(lastPage.current)) setActiveState(lastPage.current);
      lastPage.current = null;
    }
  }, [props.showBrowsers]);
  // A tab closed elsewhere (another Mac, a session) takes this one off it, if it was in front.
  const pageKeys = [...pages.keys()].join(",");
  const listed = link.browserTabs.map((t) => t.id).join(",");
  useEffect(() => {
    for (const k of opening) if (pages.has(k)) opening.delete(k);
    for (const k of gone) if (!link.browserTabs.some((t) => `tab:${t.id}` === k)) gone.delete(k);
    if (active?.startsWith("tab:") && !pages.has(active) && !opening.has(active)) setActiveState([...docs.keys(), ...galleries, ...pages.keys()].at(-1) ?? null);
  }, [pageKeys, listed]);

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
      if (galleries.has(galleryKey(p))) (bump(p), rerender());
    }
  };
  useEffect(() => link.onFs((paths) => onFs.current(paths)), [link]);

  // On first connect and after every reconnect (events may have been missed while offline).
  useEffect(() => {
    if (link.status !== "connected") return;
    for (const dir of expanded.current) void refreshDir(dir);
    for (const doc of docs.values()) void (doc.phase === "error" ? loadDoc(doc) : checkRemote(doc));
    if (galleries.size) {
      for (const key of galleries) bump(galleryDir(key)!);
      rerender();
    }
  }, [link.status]);

  // blimpd watches the expanded folders, the galleries' folders and the open files for this
  // window's events socket.
  function watching() {
    return watchPaths([...expanded.current, ...[...galleries].map((k) => galleryDir(k)!)], docs.keys());
  }
  const watchKey = watching().join("\n");
  useEffect(() => link.watch(id, watchKey ? watchKey.split("\n") : []), [watchKey, link]);
  useEffect(() => () => link.watch(id, []), [link]);

  // Leaving the window, or the project, saves what's pending.
  const flushRef = useRef(flushAll);
  flushRef.current = flushAll;
  useEffect(() => {
    const flush = () => flushRef.current();
    const blur = () => getSettings().autosave && flush();
    // pagehide: the window is closing (a blur doesn't always come first).
    window.addEventListener("blur", blur);
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("blur", blur);
      window.removeEventListener("pagehide", flush);
      flushRef.current();
    };
  }, []);

  // ---- editor ----

  // One Monaco editor; switching tabs swaps its model and keeps each file's view.
  useEffect(() => {
    if (!inEditor(activeDoc) || !monaco) return;
    const doc = activeDoc!;
    if (!editor.current) {
      editor.current = monaco.editor.create(editorBox.current!, {
        model: null,
        automaticLayout: true,
        fontSize: getSettings().editorFontSize,
        wordWrap: getSettings().wordWrap ? "on" : "off",
        fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
        minimap: { enabled: getSettings().minimap },
        scrollBeyondLastLine: false,
        renderLineHighlight: "line",
        fixedOverflowWidgets: true,
      });
      editor.current.onDidBlurEditorText(() => editorDoc.current && getSettings().autosave && flush(editorDoc.current));
    }
    const ed = editor.current;
    if (ed.getModel() !== doc.model) {
      if (editorDoc.current) editorDoc.current.viewState = ed.saveViewState();
      ed.setModel(doc.model);
      if (doc.viewState) ed.restoreViewState(doc.viewState);
      editorDoc.current = doc;
      if (!doc.reveal) ed.focus();
    }
    if (doc.reveal) {
      const { line, col } = doc.reveal;
      doc.reveal = null;
      ed.setPosition({ lineNumber: line, column: col ?? 1 });
      ed.revealLineInCenter(line);
      ed.focus();
    }
  });

  useEffect(
    () =>
      onSettings(() => {
        const s = getSettings();
        editor.current?.updateOptions({ fontSize: s.editorFontSize, wordWrap: s.wordWrap ? "on" : "off", minimap: { enabled: s.minimap } });
      }),
    [],
  );

  useEffect(
    () => () => {
      editor.current?.dispose();
      // After the flush above (cleanups run in order), once its saves have gone out.
      const dispose = () => {
        for (const d of docs.values()) (clearTimeout(d.timer), d.unsub(), d.model?.dispose());
      };
      if (pending.size) void Promise.allSettled([...pending]).then(dispose);
      else dispose();
    },
    [],
  );

  // ⌘P quick open, ⌘S save now, ⌘W close the open file. Only in the tab in front. (⌘B and ⌘J,
  // files and terminal, are the window's.)
  const onKey = useRef<(e: KeyboardEvent) => void>(() => {});
  onKey.current = (e) => {
    if (!props.front || !e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    const k = e.key.toLowerCase();
    if (k === "p") setQuick(true);
    else if (k === "s") {
      if (activeDoc) void save(activeDoc, { explicit: true });
    } else if (k === "w") {
      if (quick) setQuick(false);
      else if (active) closeTab(active);
    } else return;
    e.preventDefault();
  };
  useEffect(() => {
    // Capture phase, so the keys work while the terminal or Monaco has focus.
    const h = (e: KeyboardEvent) => onKey.current(e);
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, []);

  // ---- view ----

  // The tab strip scrolls sideways with no scrollbar, so keep the active file's tab in sight,
  // also when the Markdown or HTML Edit toggle appears beside it and narrows the strip.
  const toggleShown = !!activeDoc && hasPreview(activeDoc.viewer) && !!activeDoc.model;
  useEffect(() => {
    const tab = strip.current?.querySelector(".tab.active");
    if (!strip.current || !tab) return;
    const s = strip.current.getBoundingClientRect();
    const t = tab.getBoundingClientRect();
    if (t.left < s.left) strip.current.scrollLeft -= Math.ceil(s.left - t.left);
    else if (t.right > s.right) strip.current.scrollLeft += Math.ceil(t.right - s.right);
  }, [active, docs.size, galleries.size, toggleShown]);

  const createRow = (depth: number) =>
    creating && (
      <div className="tree-create" style={{ paddingLeft: 8 + depth * 12 }}>
        <span className="tree-twisty">{creating.kind === "dir" ? "›" : ""}</span>
        <input
          autoFocus
          aria-label={creating.kind === "dir" ? "New folder name" : "New file name"}
          placeholder={creating.kind === "dir" ? "folder name" : "file name"}
          onKeyDown={(e) => {
            if (e.key === "Enter") void finishCreate(e.currentTarget.value);
            else if (e.key === "Escape") setCreating(null);
            else return;
            e.preventDefault();
          }}
          onBlur={(e) => !creating.error && !e.currentTarget.value.trim() && setCreating(null)}
        />
        {creating.error && <div className="tree-create-error">{creating.error}</div>}
      </div>
    );

  const renderDir = (dir: string, depth: number): ReactNode => (
    <>
      {creating?.dir === dir && createRow(depth)}
      {listings.get(dir)?.map((e) => {
        const path = joinPath(dir, e.name);
        const open = e.kind === "dir" && expanded.current.has(path);
        return (
          <div key={path} role="none">
            <button
              className={"tree-row" + (path === active ? " selected" : "") + (e.kind === "dir" && path === target ? " target" : "")}
              style={{ paddingLeft: 8 + depth * 12 }}
              role="treeitem"
              aria-expanded={e.kind === "dir" ? open : undefined}
              title={e.name}
              data-path={path}
              data-kind={e.kind === "dir" ? "dir" : "file"}
              onContextMenu={(ev) => {
                ev.preventDefault();
                setMenu({ x: ev.clientX, y: ev.clientY, path, kind: e.kind === "dir" ? "dir" : "file" });
              }}
              onClick={() => {
                if (e.kind === "dir") toggleDir(path);
                else {
                  setTarget(dir);
                  openFile(path);
                }
              }}
            >
              <span className={"tree-twisty" + (open ? " open" : "")}>{e.kind === "dir" ? "›" : ""}</span>
              <span className="tree-name">{e.name}</span>
            </button>
            {open && renderDir(path, depth + 1)}
          </div>
        );
      })}
    </>
  );

  const doc = activeDoc;
  const closingDoc = closing ? docs.get(closing) : undefined;
  const showTerm = props.showTerm;
  // File tabs, galleries and browser tabs shown.
  const tabCount = docs.size + galleries.size + shownPages.size;
  // With the terminal hidden and no file open, the editor area shows how to open one.
  const showEditor = tabCount > 0 || !!props.welcome || !showTerm;
  const treeOpen = props.showFiles;

  return (
    <div className="wb" ref={box} hidden={!props.front}>
      <aside className="wb-tree" hidden={!treeOpen} style={{ width: treeWidth }}>
        <div className="pane-head">
          <span className="pane-title" title={root}>
            {baseName(root) || root}
          </span>
          <button className="icon-button small" title="New file" aria-label="New file" onClick={() => startCreate("file")}>
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
              <path d="M4 1.5h5l3 3v10H4z M9 1.5v3h3" fill="none" stroke="currentColor" />
              <path d="M8 7.5v5M5.5 10h5" stroke="currentColor" />
            </svg>
          </button>
          <button className="icon-button small" title="New folder" aria-label="New folder" onClick={() => startCreate("dir")}>
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
              <path d="M1.5 3.5h5l1.5 1.5h6.5v8.5h-13z" fill="none" stroke="currentColor" />
              <path d="M8 7v5M5.5 9.5h5" stroke="currentColor" />
            </svg>
          </button>
          <button
            className="icon-button small"
            title="Collapse folders"
            aria-label="Collapse folders"
            onClick={() => {
              expanded.current = new Set([root]);
              setTarget(root);
              rerender();
            }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
              <path d="M4.5 5.5l3.5-3 3.5 3M4.5 10.5l3.5 3 3.5-3" fill="none" stroke="currentColor" />
            </svg>
          </button>
        </div>
        <div
          className="tree"
          role="tree"
          data-path={root}
          data-kind="dir"
          onClick={(e) => e.target === e.currentTarget && setTarget(root)}
          onContextMenu={(e) => {
            if (e.target !== e.currentTarget) return;
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY, path: root, kind: "dir" });
          }}
        >
          {rootError ? <p className="view-note error">{rootError}</p> : renderDir(root, 0)}
        </div>
      </aside>
      {treeOpen && <Splitter label="Resize files" onDrag={(x) => setTreeWidth(clamp(x - box.current!.getBoundingClientRect().left, 160, 520))} />}
      <div className="wb-right" ref={right}>
        <div className="wb-editor" hidden={!showEditor} style={showTerm ? { height: `${editorShare * 100}%` } : { flex: 1 }}>
          {tabCount > 0 && (
            <div className="ftabs-bar">
              <div className="ftabs" role="tablist" ref={strip}>
                {[...docs.values()].map((d) => (
                  <div
                    key={d.path}
                    role="tab"
                    aria-selected={d.path === active}
                    className={"tab" + (d.path === active ? " active" : "")}
                    title={tildify(d.path, link.home)}
                    onMouseDown={(e) => e.button === 0 && setActive(d.path)}
                    onAuxClick={(e) => e.button === 1 && void closeDoc(d.path)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setMenu({ x: e.clientX, y: e.clientY, path: d.path, kind: "file" });
                    }}
                  >
                    <span className="tab-title">{d.name}</span>
                    <button
                      className={"tab-close" + (d.sync.dirty ? " dirty" : "")}
                      aria-label={d.sync.dirty ? "Close file (not saved yet)" : "Close file"}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={() => void closeDoc(d.path)}
                    >
                      {d.sync.dirty ? "●" : "×"}
                    </button>
                  </div>
                ))}
                {[...galleries].map((key) => {
                  const dir = galleryDir(key)!;
                  const title = baseName(dir) || dir;
                  return (
                    <div
                      key={key}
                      role="tab"
                      aria-selected={key === active}
                      className={"tab gallery-tab" + (key === active ? " active" : "")}
                      title={tildify(dir, link.home)}
                      onMouseDown={(e) => e.button === 0 && setActive(key)}
                      onAuxClick={(e) => e.button === 1 && closeGallery(key)}
                    >
                      {galleryIcon}
                      <span className="tab-title">{title}</span>
                      <button className="tab-close" aria-label={`Close gallery ${title}`} onMouseDown={(e) => e.stopPropagation()} onClick={() => closeGallery(key)}>
                        ×
                      </button>
                    </div>
                  );
                })}
                {[...shownPages].map(([key, t]) => {
                  const title = t.title || hostOf(t.url) || "New tab";
                  return (
                    <div
                      key={key}
                      role="tab"
                      aria-selected={key === active}
                      className={"tab page-tab" + (key === active ? " active" : "")}
                      title={`${t.url}${t.openedBy ? "\nOpened by a session" : ""}`}
                      onMouseDown={(e) => e.button === 0 && setActive(key)}
                      onPointerDown={(e) =>
                        startReorder(e, () => [...strip.current!.querySelectorAll<HTMLElement>(".page-tab")], (from, to) => props.onPageOrder(moved([...shownPages.values()], from, to).map((t) => t.id)))
                      }
                      onAuxClick={(e) => e.button === 1 && closePage(key)}
                    >
                      {pageIcon}
                      {t.openedBy && <span className="page-tab-mark" aria-label="Opened by a session" />}
                      <span className="tab-title">{title}</span>
                      <button className="tab-close" aria-label={`Close ${title}`} onMouseDown={(e) => e.stopPropagation()} onClick={() => closePage(key)}>
                        ×
                      </button>
                    </div>
                  );
                })}
                <button className="icon-button small ftabs-new" title="New browser tab" aria-label="New browser tab" onClick={() => openPage()}>
                  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
                    <path d="M6 1.5v9M1.5 6h9" stroke="currentColor" />
                  </svg>
                </button>
              </div>
              {/* Outside the scrolling strip, so many open files never push it out of sight. */}
              {doc && hasPreview(doc.viewer) && doc.model && (
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
          )}
          {tabCount === 0 && props.welcome}
          {tabCount === 0 && !props.welcome && (
            <div className="empty">
              No file open
              <div className="empty-sub">⌘P to open one, or pick it in the files on the left</div>
              <button className="link-button" onClick={() => openPage()}>
                New browser tab
              </button>
            </div>
          )}
          {[...shownPages].map(([key, t]) => (
            <div key={key} className="viewer" hidden={key !== active}>
              <PageView
                tab={t}
                link={link}
                shown={key === active && props.front && showEditor}
                targets={() => props.pane.current.targets()}
                onSend={(to, text) => props.pane.current.send(to, text)}
                onNotice={props.onNotice}
              />
            </div>
          ))}
          {[...galleries].map((key) => (
            <div key={key} className="viewer" hidden={key !== active}>
              <Gallery
                dir={galleryDir(key)!}
                tick={ticks.get(galleryDir(key)!) ?? 0}
                list={(d) => (link.api ? link.api.fsList(d) : Promise.reject(new Error("Not connected.")))}
                load={(p) => (link.api ? link.api.fsRead(p) : Promise.reject(new Error("Not connected.")))}
                onOpen={(p) => openFile(p)}
              />
            </div>
          ))}
          <div className="viewer" hidden={docs.size === 0 || !!active?.startsWith("tab:") || galleryDir(active) !== null}>
            {closingDoc && (
              <div className="fbar" role="alert">
                <span>{closingDoc.name} isn't saved.</span>
                <button onClick={() => void save(closingDoc, { explicit: true }).then(() => void (!closingDoc.sync.dirty && closeDoc(closingDoc.path)))}>
                  Try again
                </button>
                <button onClick={() => void closeDoc(closingDoc.path, true)}>Close without saving</button>
                <button onClick={() => setClosing(null)}>Cancel</button>
              </div>
            )}
            {doc?.deleted && (
              <div className="fbar" role="alert">
                <span>Deleted on the server</span>
                {doc.model && <button onClick={() => void save(doc, { explicit: true })}>Save</button>}
                <button onClick={() => void closeDoc(doc.path, true)}>Close</button>
              </div>
            )}
            {doc?.sync.conflict && !doc.deleted && (
              <div className="fbar" role="alert">
                <span>Changed on the server</span>
                <button onClick={() => void reloadDoc(doc)}>Reload</button>
                <button onClick={() => void save(doc, { keepMine: true, explicit: true })}>Keep mine</button>
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
                      onOpen={(p) => openFile(p)}
                      load={(p) => (link.api ? link.api.fsRead(p) : Promise.reject(new Error("Not connected.")))}
                    />
                  )}
                  {doc.viewer === "html" && (
                    <HtmlView
                      path={doc.path}
                      text={doc.model ? doc.model.getValue() : doc.text}
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
        {showEditor && showTerm && (
          <Splitter
            axis="y"
            label="Resize terminal"
            onDrag={(y) => {
              const r = right.current!.getBoundingClientRect();
              // Up to the top: the terminal may cover the editor entirely.
              setEditorShare(clamp((y - r.top) / r.height, 0, 0.85));
            }}
          />
        )}
        <div className="wb-term" hidden={!showTerm}>
          {props.terminal}
        </div>
      </div>
      {menu && (
        <>
          <div
            className="menu-scrim"
            onClick={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu(null);
            }}
          />
          <div className="menu context-menu" role="menu" style={{ left: Math.min(menu.x, innerWidth - 240), top: Math.min(menu.y, innerHeight - 120) }} onKeyDown={(e) => e.key === "Escape" && setMenu(null)}>
            <button
              role="menuitem"
              autoFocus
              onClick={() => {
                setMenu(null);
                void download(link, menu.path, menu.kind === "dir");
              }}
            >
              {menu.kind === "dir" ? "Download as .tar.gz" : "Download"}
            </button>
            {menu.kind === "dir" && (
              <button
                role="menuitem"
                onClick={async () => {
                  setMenu(null);
                  setTarget(menu.path);
                  void uploadInto(menu.path, await pickFiles());
                }}
              >
                Upload…
              </button>
            )}
            {menu.kind === "dir" && (
              <button
                role="menuitem"
                onClick={() => {
                  setMenu(null);
                  openGallery(menu.path);
                }}
              >
                Show as Gallery
              </button>
            )}
          </div>
        </>
      )}
      {ask && (
        <Dialog className="ask" onClose={() => ask.resolve(null)}>
          <p className="ask-text">
            {ask.names.length === 1 ? (
              <>
                <b>{ask.names[0]}</b> is already in {baseName(ask.dir) || ask.dir}.
              </>
            ) : (
              <>
                {ask.names.length} of these are already in {baseName(ask.dir) || ask.dir}: {ask.names.join(", ")}.
              </>
            )}
          </p>
          <div className="dialog-actions">
            <button onClick={() => ask.resolve(null)}>Cancel</button>
            <button onClick={() => ask.resolve("skip")}>Skip</button>
            <button onClick={() => ask.resolve("keep")}>Keep both</button>
            <button className="primary" autoFocus onClick={() => ask.resolve("replace")}>
              Replace
            </button>
          </div>
        </Dialog>
      )}
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
