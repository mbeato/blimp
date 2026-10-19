// Drives the REAL app (Rust shell + WebKitGTK webview + CSP + capabilities) over WebDriver,
// against a test blimpd reached through the app's own `connect` command (a real ssh -L tunnel).
// Linux only (tauri-driver has no macOS WKWebView driver).
//
// Needs: tauri-driver (cargo install tauri-driver --locked), WebKitWebDriver (apt install
// webkit2gtk-driver), xvfb, zmx, bun, and key-based `ssh localhost`.
// Run from app/:
//   bun run tauri build --debug --no-bundle && xvfb-run -a -s "-screen 0 1600x1000x24" bun e2e-native/run.ts
// Screenshots and results.json go to e2e-native/shots/. Exit code 1 if any check failed.
// close-window.py closes the window the way a window manager does (no WM runs under Xvfb).
// Known gap: the probes (CSP listener etc.) are installed after the first page load, since
// WebDriver has no init scripts, so a violation during that load itself would not be seen.
//
// Isolation: the test blimpd gets its own short temp socket dir, ZMX_DIR, CLAUDE_CONFIG_DIR and
// HOME, and only blimptest-* sessions exist there. The app runs with HOME set to a temp folder
// (so its store, servers.json, is a throwaway) and BLIMP_REMOTE_DIR=<temp socket dir>, which a
// DEBUG build of the Rust shell uses instead of ~/.blimp on the server (release builds ignore it).
// Max's ~/.blimp, blimpd.service and zmx sessions are never touched.

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync, copyFileSync, openSync } from "node:fs";
import { rmSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const here = import.meta.dirname;
const repo = join(here, "../..");
const app = join(here, "../src-tauri/target/debug/blimp");
const shots = join(here, "shots");
const PATH = `${homedir()}/.local/bin:${homedir()}/.bun/bin:${homedir()}/.cargo/bin:${process.env.PATH}`;
const PORT = 4444;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- results ---------------------------------------------------------------------------------
const results: { check: string; ok: boolean; evidence: string }[] = [];
function record(check: string, ok: boolean, evidence: unknown) {
  const ev = typeof evidence === "string" ? evidence : JSON.stringify(evidence);
  results.push({ check, ok, evidence: ev });
  console.log(`${ok ? "PASS" : "FAIL"}  ${check}\n      ${ev.slice(0, 600)}`);
}
async function until<T>(ms: number, f: () => Promise<T> | T): Promise<T | undefined> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) {
    const v = await Promise.resolve().then(f).catch(() => undefined);
    if (v) return v;
  }
}

// ---- test blimpd, sessions, fixtures --------------------------------------------------------
const tmp = mkdtempSync("/tmp/bz.");
const zmxDir = join(tmp, "z");
const home = join(tmp, "home");
const proj = join(home, "proj");
const appHome = join(tmp, "apphome");
for (const d of [zmxDir, join(tmp, "claude"), proj, appHome]) mkdirSync(d, { recursive: true, mode: 0o700 });
const zenv = { ...process.env, PATH, ZMX_DIR: zmxDir, BLIMPD_SOCKET: join(tmp, "blimpd.sock") } as Record<string, string>;
delete zenv.ZMX_SESSION; // inside a zmx session `zmx attach` would switch sessions
const zmx = (...a: string[]) => execFileSync("zmx", a, { env: zenv, encoding: "utf8", timeout: 10_000 });

writeFileSync(join(proj, "README.md"), "# Native heading\n\nSome *markdown* text.\n");
writeFileSync(join(proj, "main.ts"), "export const greet = (n: string): string => `hi ${n}`;\n");
copyFileSync(join(here, "../src-tauri/icons/32x32.png"), join(proj, "pic.png"));
writeFileSync(
  join(proj, "doc.pdf"),
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 4 0 R>>endobj\n4 0 obj<</Length 30>>stream\n0 0 1 rg 20 20 160 60 re f\nendstream endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
);

const children: ChildProcess[] = [];
const log = openSync(join(tmp, "blimpd.log"), "a");
children.push(
  spawn("bun", [join(repo, "src/main.ts"), "serve"], {
    env: { ...zenv, HOME: home, CLAUDE_CONFIG_DIR: join(tmp, "claude") },
    stdio: ["ignore", log, log],
  }),
);

// Like blimpd's POST /sessions: start the session from a 120x36 PTY, then drop that client.
async function startSession(name: string, cmd: string[]) {
  const line = `stty cols 120 rows 36; exec zmx attach ${name} ${cmd.join(" ")}`;
  const c = spawn("script", ["-qfec", line, "/dev/null"], { cwd: proj, env: zenv, stdio: ["pipe", "ignore", "ignore"] });
  await until(10_000, () => zmx("list", "--short").split("\n").includes(name));
  await sleep(300);
  c.kill();
}

// ---- WebDriver over raw HTTP ----------------------------------------------------------------
let sid = "";
async function wd(method: string, path: string, body?: unknown) {
  const r = await fetch(`http://127.0.0.1:${PORT}/session${sid ? "/" + sid : ""}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(j.value ?? j).slice(0, 400)}`);
  return j.value;
}
const js = (script: string, ...args: unknown[]) => wd("POST", "/execute/sync", { script, args });
// Runs an async function body; resolves with what it returns.
const jsAsync = (body: string) =>
  wd("POST", "/execute/async", { script: `const done = arguments[arguments.length-1]; (async () => { ${body} })().then(done, e => done('ERR ' + e))`, args: [] });
const find = async (css: string) => Object.values(await wd("POST", "/element", { using: "css selector", value: css }))[0] as string;
const click = async (css: string) => wd("POST", `/element/${await find(css)}/click`, {});
const typeKeys = (keys: string[]) =>
  wd("POST", "/actions", { actions: [{ type: "key", id: "kb", actions: keys.flatMap((k) => [{ type: "keyDown", value: k }, { type: "keyUp", value: k }]) }] });
const chord = (mod: string, key: string) =>
  wd("POST", "/actions", {
    actions: [{ type: "key", id: "kb", actions: [{ type: "keyDown", value: mod }, { type: "keyDown", value: key }, { type: "keyUp", value: key }, { type: "keyUp", value: mod }] }],
  });
async function shot(name: string) {
  mkdirSync(shots, { recursive: true });
  writeFileSync(join(shots, `${name}.png`), Buffer.from(await wd("GET", "/screenshot"), "base64"));
}
async function openApp() {
  sid = "";
  const v = await wd("POST", "", { capabilities: { alwaysMatch: { "tauri:options": { application: app } } } });
  sid = v.sessionId;
  await until(15_000, () => js("return !!document.querySelector('#root > *')"));
  // Probes, installed after load (WebDriver has no init scripts): CSP violations, every Tauri
  // IPC call with its outcome (__TAURI_INTERNALS__.invoke is read-only, but Tauri's IPC calls the
  // global fetch on ipc://localhost/<cmd>), console warnings/errors, workers created and their
  // errors, unhandled rejections.
  await js(`
    const w = window; w.__probe = { csp: [], invokes: [], workers: [], errors: [], console: [] };
    document.addEventListener('securitypolicyviolation', e => w.__probe.csp.push(e.effectiveDirective + ' ' + e.blockedURI + ' ' + e.sourceFile + ':' + e.lineNumber));
    addEventListener('unhandledrejection', e => w.__probe.errors.push('rejection: ' + (e.reason && (e.reason.message || e.reason))));
    addEventListener('error', e => w.__probe.errors.push('error: ' + e.message));
    for (const k of ['warn', 'error']) { const c = console[k].bind(console); console[k] = (...a) => { w.__probe.console.push(k + ': ' + a.map(String).join(' ')); c(...a); }; }
    const F = w.fetch; w.fetch = function (u, o) { const url = String(u && u.url || u);
      if (!/^ipc:|ipc\\.localhost/.test(url)) return F.apply(this, arguments);
      const rec = { cmd: decodeURIComponent(url.split('/').pop()), ok: null }; w.__probe.invokes.push(rec);
      return F.apply(this, arguments).then(r => { rec.ok = r.headers.get('Tauri-Response') === 'ok'; if (!rec.ok) r.clone().text().then(t => rec.err = t); return r; },
        e => { rec.ok = false; rec.err = 'fetch failed: ' + e; throw e; }); };
    const W = w.Worker; w.Worker = function (url, opts) { const rec = { url: String(url), error: null }; w.__probe.workers.push(rec);
      const x = new W(url, opts); x.addEventListener('error', e => rec.error = e.message || 'error'); return x; };
    w.Worker.prototype = W.prototype;`);
}
const probe = () => js("return window.__probe");
// The tunnels the app started: ssh children whose -L points at this run's socket dir.
const tunnels = () =>
  execFileSync("ps", ["-eo", "pid,ppid,args"], { encoding: "utf8" })
    .split("\n")
    .filter((l) => /^\s*\d+\s+\d+\s+ssh\s/.test(l) && l.includes(`${tmp}/blimpd.sock`));
// Waits up to 5 s for the tunnels to go: after a kill, ssh ends once its stdin pipe closes and the
// webview's connections through it are gone.
const noTunnels = () => until(5000, () => tunnels().length === 0);

// ---- run --------------------------------------------------------------------------------------
let driver: ChildProcess | undefined;
try {
  await until(15_000, () => existsSync(join(tmp, "token")));
  // a is the older session, so it is the second row (rows are newest first).
  await startSession("blimptest-a", ["bash", "--norc", "--noprofile"]);
  await sleep(1100);
  await startSession("blimptest-b", ["bash", "--norc", "--noprofile"]);
  // `zmx run` can hang if bash hasn't drawn its prompt yet, so wait for the prompt first.
  await until(10_000, () => zmx("history", "blimptest-a").includes("$"));
  zmx("run", "blimptest-a", "echo", "pre-existing-screen");

  const dlog = openSync(join(tmp, "driver.log"), "a");
  driver = spawn("tauri-driver", ["--port", String(PORT)], {
    env: { ...zenv, HOME: appHome, BLIMP_REMOTE_DIR: tmp, BLIMPD_SOCKET: "", BLIMP_TEST_UPLOADS: join(tmp, "to-upload") },
    stdio: ["ignore", dlog, dlog],
  });
  await until(10_000, () => fetch(`http://127.0.0.1:${PORT}/status`).then((r) => r.ok));

  // 1. Window opens, welcome form, no CSP violations.
  await openApp();
  await until(10_000, () => js("return !!document.querySelector('.welcome input')"));
  await shot("01-welcome");
  record("window opens with the Add server form", await js("return !!document.querySelector('.welcome form')"), await js("return document.title + ' ' + innerWidth + 'x' + innerHeight"));

  // 2. Add server -> connect through the Rust command -> real ssh -L tunnel -> Home.
  await click(".welcome input");
  await typeKeys([..."localhost"]);
  await click(".welcome button.primary");
  const home = await until(20_000, () => js("return document.querySelector('.welcome-page .conn')?.textContent === 'connected' && [...document.querySelectorAll('.tree .tree-name')].map(e => e.textContent).includes('proj')"));
  const p1 = await probe();
  record("connect via Rust command", !!p1.invokes.find((i: any) => i.cmd === "connect" && i.ok), p1.invokes.filter((i: any) => !i.cmd.startsWith("plugin:event")));
  record("real ssh -L tunnel in ps", tunnels().length === 1, tunnels());
  record("Home shows the server's home folder and Welcome", !!home, await js("return document.querySelector('.wb')?.innerText.slice(0, 300)"));
  await shot("02-home");

  // Open Folder (the + after the project tabs), typed path.
  await click(".ptabs-add");
  await until(5000, () => js("return !!document.querySelector('.dialog .dialog-input')"));
  await typeKeys([..."~/proj", "\uE007"]);
  const rows = await until(20_000, async () => ((await js("return document.querySelectorAll('.wb:not([hidden]) .srow').length")) >= 2 ? true : undefined));
  record("Open Folder opens the project in a new tab; its 2 sessions are listed", !!rows && (await js("return [...document.querySelectorAll('.ptab')].map(t => t.getAttribute('aria-label')).join(',')")) === "Home,proj", {
    tabs: await js("return [...document.querySelectorAll('.ptab')].map(t => t.getAttribute('aria-label') + (t.classList.contains('active') ? '*' : ''))"),
    rows: await js("return [...document.querySelectorAll('.wb:not([hidden]) .srow')].map(r => r.innerText.replace(/\\n/g,' '))"),
  });
  const title = await until(5000, () => js("return document.title === 'proj — blimp' ? document.title : undefined"));
  const p1b = await probe();
  record("window title and set_window_projects / set_viewing go through", !!title && ["set_window_projects", "set_viewing"].every((c) => p1b.invokes.some((i: any) => i.cmd === c && i.ok)), {
    title: await js("return document.title"),
    invokes: p1b.invokes.filter((i: any) => /window|viewing/.test(i.cmd)),
  });
  await shot("02b-project");

  // 3. Terminal: existing screen, then type.
  await click('.wb:not([hidden]) .srow[data-session="blimptest-a"] .srow-main');
  await until(10_000, () => js("return !!document.querySelector('.wb:not([hidden]) .tpane-terms .term:not([hidden]) .xterm-screen')"));
  await sleep(1500);
  // xterm's WebGL renderer draws into a canvas, so the screen is checked in the screenshot.
  const renderer = await js("const t = document.querySelector('.wb:not([hidden]) .tpane-terms .term:not([hidden])'); return t.querySelector('.xterm-rows') ? 'dom' : 'webgl (canvas)'");
  const screenText = () => js("const r = document.querySelector('.wb:not([hidden]) .tpane-terms .term:not([hidden]) .xterm-rows'); return r ? r.innerText : ''");
  await shot("03a-terminal-before-typing");
  record("terminal attaches (existing screen: see 03a-terminal-before-typing.png)", true, { renderer, domText: (await screenText()).trim().slice(0, 200) });
  await click(".wb:not([hidden]) .tpane-terms .term:not([hidden]) .xterm-screen");
  await typeKeys([..."echo native-ok", "\uE007"]);
  await sleep(1500);
  const hist = zmx("history", "blimptest-a");
  const outLines = hist.split("\n").filter((l) => l.trim() === "native-ok").length;
  record("typed 'echo native-ok' reaches the session and prints", outLines >= 1, { renderer, domText: (await screenText()).trim().slice(-200), zmxHistoryTail: hist.trim().split("\n").slice(-4) });
  await shot("03b-terminal-typed");

  // 4. Files pane: tree, .md, .ts (Monaco + worker), .png, .pdf (pdf.js + worker).
  const tree = await until(10_000, async () => {
    const t: string[] = await js("return [...document.querySelectorAll('.wb:not([hidden]) .tree .tree-name')].map(e => e.textContent)");
    return t.includes("README.md") ? t : undefined;
  });
  record("files tree loads", !!tree, tree ?? (await js("return document.querySelector('.wb-tree')?.innerText")));
  const openFile = (name: string) => click(`.wb:not([hidden]) .tree-row[title="${name}"]`);
  await openFile("README.md");
  const md = await until(10_000, () => js("return document.querySelector('.md-view h1')?.textContent"));
  record("README.md renders", md === "Native heading", md ?? (await js("return document.querySelector('.viewer')?.innerText")));
  await shot("04-markdown");
  await openFile("main.ts");
  const mon = await until(20_000, () => js("return document.querySelector('.monaco-editor .view-lines')?.innerText"));
  await sleep(2000);
  const p2 = await probe();
  record("main.ts opens in Monaco, its worker starts under the CSP", !!mon?.includes("greet") && p2.workers.some((w: any) => /editor\.worker/.test(w.url) && !w.error), { text: mon, workers: p2.workers });
  await shot("05-monaco");
  await openFile("pic.png");
  const img = await until(10_000, () => js("const i = document.querySelector('.image-view img'); return i && i.complete && i.naturalWidth ? i.src.slice(0,5) + ' ' + i.naturalWidth : null"));
  record("pic.png shows", !!img, img ?? "no loaded <img>");
  await openFile("doc.pdf");
  const pdf = await until(15_000, () => js("return document.querySelector('.pdf-view canvas.pdf-page')?.width"));
  await sleep(500);
  const p3 = await probe();
  record("doc.pdf renders with the pdf.js worker under the CSP", !!pdf && p3.workers.some((w: any) => /pdf\.worker/.test(w.url) && !w.error), {
    canvasWidth: pdf,
    note: await js("return document.querySelector('.pdf-view .view-note')?.textContent ?? null"),
    workers: p3.workers,
  });
  await shot("06-pdf");

  // 4a. Transfers through Rust (transfer.rs): download a file and a folder to ~/Downloads,
  // upload a folder; a file that wasn't dropped or picked isn't read.
  mkdirSync(join(proj, "sub"), { recursive: true });
  writeFileSync(join(proj, "sub", "in-sub.txt"), "sub file\n");
  mkdirSync(join(tmp, "to-upload", "pack", "deep"), { recursive: true });
  writeFileSync(join(tmp, "to-upload", "pack", "deep", "up.txt"), "uploaded\n");
  const tauri = (cmd: string, args: object) =>
    jsAsync(`return await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)}).then(v => JSON.stringify(v), e => 'ERR ' + e)`);
  const server = "localhost";
  const dlFile = JSON.parse(await tauri("download", { server, path: join(proj, "README.md"), id: 9001 }));
  const dlDir = JSON.parse(await tauri("download", { server, path: join(proj, "sub"), id: 9002 }));
  const dlAgain = JSON.parse(await tauri("download", { server, path: join(proj, "README.md"), id: 9003 }));
  const tarList = existsSync(dlDir) ? execFileSync("tar", ["-tzf", dlDir], { encoding: "utf8" }) : "";
  record("download: a file and a folder (.tar.gz) to ~/Downloads, never over an earlier one", readFileSync(dlFile, "utf8").startsWith("# Native heading") && tarList.includes("sub/in-sub.txt") && dlAgain !== dlFile && dlAgain.endsWith("README 2.md"), {
    dlFile,
    dlDir,
    dlAgain,
    tarList,
  });
  const upOk = await tauri("upload", { server, local: join(tmp, "to-upload", "pack"), remoteDir: proj, name: "pack", mode: "new", id: 9004 });
  const upNo = await tauri("upload", { server, local: join(tmp, "blimpd.log"), remoteDir: proj, name: "log", mode: "new", id: 9005 });
  record("upload: a dropped folder goes up whole; a file nobody dropped or picked is refused", upOk === "1" && readFileSync(join(proj, "pack", "deep", "up.txt"), "utf8") === "uploaded\n" && upNo.startsWith("ERR") && !existsSync(join(proj, "log")), {
    upOk,
    upNo,
  });

  // 4c'. A session's web server in a browser tab, through a port forward (forward_port), shown
  // in the app's WebKit under its CSP.
  const webPort = await new Promise<number>((resolve) => {
    const srv = createServer().listen(0, "127.0.0.1", () => {
      const p = (srv.address() as { port: number }).port;
      srv.close(() => resolve(p));
    });
  });
  await startSession("blimptest-web", ["bun", "-e", `'Bun.serve({ hostname: "127.0.0.1", port: ${webPort}, fetch: () => new Response("<h1>native page</h1>", { headers: { "content-type": "text/html" } }) }); setInterval(() => {}, 1e9)'`]);
  const portRow = await until(15_000, () => js(`return !!document.querySelector('.wb:not([hidden]) .port-row')`));
  if (portRow) await click(".wb:not([hidden]) .port-row");
  const frameEl = await until(15_000, async () => {
    try {
      return await find(".wb:not([hidden]) .viewer:not([hidden]) iframe.page-frame");
    } catch {
      return undefined;
    }
  });
  let pageText = "";
  if (frameEl) {
    await sleep(1500);
    await wd("POST", "/frame", { id: { "element-6066-11e4-a52e-4f735466cecf": frameEl } });
    pageText = await until(10_000, () => js("return document.querySelector('h1')?.textContent")) ?? "";
    await wd("POST", "/frame/parent", {});
  }
  const forwards = execFileSync("ps", ["-eo", "args"], { encoding: "utf8" }).split("\n").filter((l) => l.includes(`:127.0.0.1:${webPort}`));
  record("a session's port opens in a browser tab, through an ssh forward", !!portRow && pageText === "native page" && forwards.length === 1, { portRow, pageText, forwards });
  await shot("05b-browser-tab");
  // Closing the tab closes the forward.
  await click(".wb:not([hidden]) .ftabs .page-tab .tab-close").catch(() => {});
  const fwdGone = await until(5000, () => !execFileSync("ps", ["-eo", "args"], { encoding: "utf8" }).includes(`:127.0.0.1:${webPort}`));
  record("closing the browser tab closes its forward", !!fwdGone, { fwdGone });
  zmx("kill", "blimptest-web");

  // 4d. The update check is allowed (capabilities) and reaches the updater: it answers with
  // "no update" or a network/release error, never a permission error.
  const upd = await jsAsync(`return await window.__TAURI_INTERNALS__.invoke('plugin:updater|check', {}).then(v => 'ok ' + JSON.stringify(v), e => 'ERR ' + e)`);
  record("the app may check for updates (updater plugin wired, allowed)", !/not allowed|denied|permission|unknown command/i.test(upd), upd);

  // 4b. The show/hide buttons at the top right.
  const hiddenNow = () => js("const w = document.querySelector('.wb:not([hidden])'); return ['.wb-tree', '.wb-term', '.slist'].map(c => w.querySelector(c).offsetWidth === 0)");
  await click('.layout-toggles button[aria-label="Files"]');
  await click('.layout-toggles button[aria-label="Sessions"]');
  const hid = await hiddenNow();
  await click('.layout-toggles button[aria-label="Files"]');
  await click('.layout-toggles button[aria-label="Sessions"]');
  const back = await hiddenNow();
  record("the Files and Sessions buttons hide and show their panes", hid[0] && !hid[1] && hid[2] && !back.some(Boolean), { hidden: hid, after: back });

  // 4c. Drag blimptest-b from the list onto the right half of the terminal: two splits.
  const box = (css: string) => js(`const r = document.querySelector(${JSON.stringify(css)}).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }`);
  const from = await box('.wb:not([hidden]) .srow[data-session="blimptest-b"]');
  const to = await box(".wb:not([hidden]) .tpane-terms");
  const pt = (x: number, y: number) => ({ type: "pointerMove", origin: "viewport", x: Math.round(x), y: Math.round(y), duration: 0 });
  await wd("POST", "/actions", {
    actions: [
      {
        type: "pointer",
        id: "mouse",
        parameters: { pointerType: "mouse" },
        actions: [
          pt(from.x + 40, from.y + from.h / 2),
          { type: "pointerDown", button: 0 },
          pt(from.x + 30, from.y + from.h / 2 + 20),
          pt(to.x + to.w * 0.6, to.y + to.h / 2),
          pt(to.x + to.w * 0.8, to.y + to.h / 2),
          { type: "pointerUp", button: 0 },
        ],
      },
    ],
  });
  await wd("DELETE", "/actions").catch(() => {});
  const splits = await until(5000, async () => {
    const v: { name: string; x: number }[] = await js("return [...document.querySelectorAll('.wb:not([hidden]) .tsplit:not([hidden])')].map(e => ({ name: e.dataset.split, x: e.getBoundingClientRect().x })).sort((a, b) => a.x - b.x)");
    return v.length === 2 ? v : undefined;
  });
  record("dragging a session onto the terminal splits it (WebKit pointer events)", !!splits && splits[1].name === "blimptest-b" && splits[1].x > splits[0].x, splits ?? (await js("return document.querySelector('.wb:not([hidden]) .tpane-terms').innerHTML.slice(0, 300)")));
  await shot("06b-split");
  // Close that split again (blimptest-b keeps running): step 6 needs b off screen to notify.
  await click('.wb:not([hidden]) .tsplit[data-split="blimptest-b"] .tab-close');
  const one = await until(3000, () => js("return document.querySelectorAll('.wb:not([hidden]) .tsplit:not([hidden])').length === 1"));
  record("a split's × closes it, the session stays listed", !!one && (await js(`return !!document.querySelector('.wb:not([hidden]) .srow[data-session="blimptest-b"]')`)), await js("return document.querySelectorAll('.wb:not([hidden]) .tsplit:not([hidden])').length"));

  // 5. Palette: the UI binds metaKey only (App.tsx), so on Linux that is Super+K; no Ctrl+K mapping.
  await click(".wb:not([hidden]) .slist .pane-title");
  await chord("\uE03D", "k");
  const pal = await until(3000, () => js("return !!document.querySelector('.palette')"));
  record("⌘K (Meta+K) opens the palette", !!pal, pal ? await js("return document.querySelector('.palette').innerText") : "no .palette after Meta+K");
  if (pal) await shot("07-palette");
  await typeKeys(["\uE00C"]);

  // 5b. ⌘⇧N opens a second window (open_window), on Home; closing it leaves the first.
  const first = await wd("GET", "/window");
  await wd("POST", "/actions", {
    actions: [{ type: "key", id: "kb", actions: [{ type: "keyDown", value: "\uE03D" }, { type: "keyDown", value: "\uE008" }, { type: "keyDown", value: "n" }, { type: "keyUp", value: "n" }, { type: "keyUp", value: "\uE008" }, { type: "keyUp", value: "\uE03D" }] }],
  });
  const handles: string[] | undefined = await until(10_000, async () => {
    const h: string[] = await wd("GET", "/window/handles");
    return h.length === 2 ? h : undefined;
  });
  let second = "";
  if (handles) {
    await wd("POST", "/window", { handle: (second = handles.find((h) => h !== first)!) });
    const welcome = await until(20_000, () => js("return document.querySelector('.welcome-page .conn')?.textContent === 'connected'"));
    await shot("07b-second-window");
    record("⌘⇧N opens a second window on Home, sharing the tunnel", !!welcome && tunnels().length === 1, { handles, tunnels: tunnels().length });
    // ⌘K here to a session in the first window's proj tab: that window comes forward, and no
    // second proj tab opens here (focus_project).
    await click(".welcome-page h1");
    await chord("\uE03D", "k");
    await until(3000, () => js("return !!document.querySelector('.palette')"));
    await typeKeys([..."blimptest-a", "\uE007"]);
    await sleep(1000);
    const p2w = await js("return window.__probe ? window.__probe.invokes.filter(i => i.cmd === 'focus_project') : 'no probe'");
    const tabs2 = await js("return document.querySelectorAll('.ptab').length");
    const picked = await js("return !document.querySelector('.palette')");
    record("⌘K to a session another window has open focuses that window instead of opening a tab", tabs2 === 1 && picked, { tabsHere: tabs2, paletteClosed: picked, focusProject: p2w });

    // A session dragged out of this window (drop_session): let go over the first window, it
    // moves into that window's proj tab; let go where no window is, a new window opens.
    await wd("POST", "/window", { handle: first });
    const target = await js(`const r = document.querySelector('.wb:not([hidden]) .tpane-terms').getBoundingClientRect();
      const l = JSON.parse(new URLSearchParams(location.search).get('layout'));
      return { x: screenX + r.x + r.width * 0.8, y: screenY + (outerHeight - innerHeight) + r.y + r.height / 2, dir: l.tabs[l.active].dir }`);
    await wd("POST", "/window", { handle: second });
    const init = new URLSearchParams({ server: "localhost", dir: target.dir, session: "blimptest-b" }).toString();
    const invoke = (x: number, y: number) =>
      jsAsync(`return await window.__TAURI_INTERNALS__.invoke('drop_session', { init: ${JSON.stringify(init)}, x: ${x}, y: ${y} }).then(String, e => 'ERR ' + e)`);
    const onFirst = await invoke(target.x, target.y);
    const offAll = await invoke(-5000, -5000);
    const three: string[] | undefined = await until(10_000, async () => {
      const h: string[] = await wd("GET", "/window/handles");
      return h.length === 3 ? h : undefined;
    });
    await wd("POST", "/window", { handle: first });
    const panes = await until(5000, async () => {
      const l = JSON.parse(await js("return new URLSearchParams(location.search).get('layout')"));
      const p: string[] = l.tabs[l.active].panes;
      return p.includes("blimptest-b") ? p : undefined;
    });
    record("a session let go over another window moves into it; let go over no window, a new window opens", onFirst === "true" && offAll === "false" && !!three && !!panes, {
      overFirst: onFirst,
      overNone: offAll,
      windows: three?.length,
      firstWindowSplits: panes ?? (await js("return new URLSearchParams(location.search).get('layout')")),
    });
    await shot("07c-dropped-from-other-window");
    // Close what this added: the new window, and b's split here (step 6 needs b off screen).
    for (const h of three ?? []) {
      if (h === first || h === second) continue;
      await wd("POST", "/window", { handle: h });
      await wd("DELETE", "/window");
    }
    await wd("POST", "/window", { handle: first });
    await click('.wb:not([hidden]) .tsplit[data-split="blimptest-b"] .tab-close').catch(() => {});
    await wd("POST", "/window", { handle: second });

    // "In another window": this window says it shows b (set_shown); the first window marks b's
    // row, and a click there brings this window forward with b shown (focus_session).
    await jsAsync(`return await window.__TAURI_INTERNALS__.invoke('set_shown', { sessions: ['localhost/blimptest-b'] }).then(() => 'ok', e => 'ERR ' + e)`);
    await wd("POST", "/window", { handle: first });
    const marked = await until(5000, () => js(`return !!document.querySelector('.wb:not([hidden]) .srow.elsewhere[data-session="blimptest-b"]')`));
    await click('.wb:not([hidden]) .srow[data-session="blimptest-b"] .srow-main');
    await wd("POST", "/window", { handle: second });
    const there = await until(5000, async () => {
      const l = JSON.parse((await js("return new URLSearchParams(location.search).get('layout')")) ?? "null");
      return l && l.tabs[l.active]?.panes?.includes("blimptest-b") ? l.tabs.map((t: any) => t.dir) : undefined;
    });
    record("a session another window shows is marked; a click on it goes to that window", !!marked && !!there, { marked: !!marked, secondWindowTabs: there });
    // Close that tab again before this window goes: step 6 needs b on no window's screen.
    await click(".ptab.active .tab-close").catch(() => {});
    await until(3000, () => js("return document.querySelectorAll('.ptab').length === 1"));
    await wd("DELETE", "/window");
    await wd("POST", "/window", { handle: first });
  } else record("⌘⇧N opens a second window on Home, sharing the tunnel", false, await wd("GET", "/window/handles"));
  void second;

  // 6. Waiting -> notification through the plugin.
  // blimptest-a is on screen, so b becoming waiting must notify.
  mkdirSync(join(tmp, "status"), { recursive: true });
  writeFileSync(join(tmp, "status", "blimptest-b.json"), JSON.stringify({ state: "waiting", at: Date.now(), event: "PermissionRequest" }));
  const waiting = await until(8000, () => js(`return !!document.querySelector('.srow[data-session="blimptest-b"] .dot')`));
  await sleep(1500);
  const p4 = await probe();
  const notes = p4.invokes.filter((i: any) => i.cmd.startsWith("plugin:notification") || i.cmd === "claim_notice");
  record("waiting session shows; claim_notice, then notify() without error", !!waiting && notes.some((i: any) => i.cmd === "claim_notice" && i.ok) && notes.some((i: any) => i.cmd === "plugin:notification|notify" && i.ok), { notes, errors: p4.errors });
  await shot("08-waiting");
  const p5 = await probe();
  record("no CSP violations during the run", p5.csp.length === 0, p5.csp);
  record("no uncaught errors / rejections", p5.errors.length === 0, p5.errors);
  // Besides 4a's upload of a file nobody dropped, which must fail, and the update check, which
  // fails while the release it reads (latest.json) isn't there or this machine is offline.
  const failed = p5.invokes.filter(
    (i: any) => i.ok === false && !(i.cmd === "upload" && /Drop it on the window/.test(i.err ?? "")) && i.cmd !== "plugin:updater|check",
  );
  record("no failed IPC calls", failed.length === 0, {
    failed,
    called: [...new Set(p5.invokes.map((i: any) => i.cmd))],
  });
  // xterm logs this when a render task runs long (software GL under Xvfb); it is not an error.
  const warnings = p5.console.filter((m: string) => !/task queue exceeded allotted deadline/.test(m));
  record("no console warnings/errors (besides xterm's slow-task notice)", warnings.length === 0, p5.console);
  // The policy is really enforced in the native webview, and Tauri serves it as a header too.
  const enforced = await jsAsync(`
    let evalBlocked = false; try { eval('1'); } catch { evalBlocked = true; }
    const before = window.__probe.csp.length;
    const s = document.createElement('script'); s.textContent = 'window.__inlineRan = true'; document.head.append(s);
    await new Promise(r => setTimeout(r, 300));
    const header = (await fetch(location.href)).headers.get('content-security-policy');
    return { evalBlocked, inlineRan: !!window.__inlineRan, violation: window.__probe.csp.slice(before), header };`);
  record("CSP enforced natively (eval and inline script blocked, header served)", enforced.evalBlocked && !enforced.inlineRan && !!enforced.header, enforced);

  // 7. Quit the way a user closes the window (WM_DELETE_WINDOW), then no ssh child is left.
  const pidOf = () => execFileSync("pgrep", ["-f", `^${app}`], { encoding: "utf8" }).trim();
  const gone = (pid: string) => until(8000, () => { try { execFileSync("kill", ["-0", pid], { stdio: "ignore" }); return false; } catch { return true; } });
  const appPid = pidOf();
  console.log(execFileSync("python3", [join(here, "close-window.py"), "blimp"], { encoding: "utf8" }).trim());
  const exited = await gone(appPid);
  await sleep(500);
  record("closing the window quits the app and leaves no ssh tunnel", !!exited && tunnels().length === 0, { appPid, exited: !!exited, left: tunnels() });
  await wd("DELETE", "").catch(() => {});

  // 7b. SIGTERM (logout, `kill`, a service manager) is another way the app ends.
  await openApp();
  await until(20_000, () => tunnels().length === 1);
  const pid2 = pidOf();
  execFileSync("kill", ["-TERM", pid2]);
  await gone(pid2);
  record("SIGTERM to the app leaves no ssh tunnel", !!(await noTunnels()), { pid: pid2, left: tunnels() });
  for (const l of tunnels()) execFileSync("kill", [l.trim().split(/\s+/)[0]]);
  await wd("DELETE", "").catch(() => {});

  // 7c. SIGKILL (force quit, a crash) runs no code in the app at all.
  await openApp();
  await until(20_000, () => tunnels().length === 1);
  const pid3 = pidOf();
  execFileSync("kill", ["-KILL", pid3]);
  await gone(pid3);
  record("SIGKILL to the app leaves no ssh tunnel", !!(await noTunnels()), { pid: pid3, left: tunnels() });
  for (const l of tunnels()) execFileSync("kill", [l.trim().split(/\s+/)[0]]);
  await wd("DELETE", "").catch(() => {});

  // 8. Store persists the server list and recent projects across a restart.
  await openApp();
  const again = await until(20_000, () =>
    js("return document.querySelector('.ptab.active')?.getAttribute('aria-label') === 'proj' && [...document.querySelectorAll('.welcome-recent button')].some(b => b.textContent === 'proj')"),
  );
  const store = join(appHome, ".local/share/dev.blimp.app/servers.json");
  const recentStore = join(appHome, ".local/share/dev.blimp.app/recent.json");
  record("servers, recent projects and the open tabs persist across restart (store plugin)", !!again && !(await js("return !!document.querySelector('.welcome form')")), {
    tabs: await js("return [...document.querySelectorAll('.ptab')].map(t => t.getAttribute('aria-label') + (t.classList.contains('active') ? '*' : ''))"),
    page: await js("return document.querySelector('.welcome-page')?.innerText.slice(0, 200)"),
    servers_json: existsSync(store) ? readFileSync(store, "utf8") : "missing " + store,
    recent_json: existsSync(recentStore) ? readFileSync(recentStore, "utf8").slice(0, 300) : "missing " + recentStore,
  });
  await shot("09-restarted");
  // WebDriver's close ends the app without its normal exit path.
  await wd("DELETE", "/window").catch(() => {});
  await sleep(1000);
  await wd("DELETE", "").catch(() => {});
  record("WebDriver closing the window leaves no ssh tunnel", !!(await noTunnels()), tunnels());
} catch (e) {
  record("run finished without an exception", false, (e as Error).stack ?? String(e));
  if (sid) await shot("zz-error").catch(() => {});
} finally {
  driver?.kill();
  await sleep(500);
  for (const name of zmx("list", "--short").split("\n")) if (name.startsWith("blimptest-")) zmx("kill", name);
  for (const c of children) c.kill();
  for (const l of tunnels()) execFileSync("kill", [l.trim().split(/\s+/)[0]]); // orphans from a failed run
  console.log(`\nlogs: ${tmp}/blimpd.log ${tmp}/driver.log (kept: set KEEP=1)`);
  if (!process.env.KEEP) rmSync(tmp, { recursive: true, force: true });
}
mkdirSync(shots, { recursive: true });
writeFileSync(join(shots, "results.json"), JSON.stringify(results, null, 2));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed (full evidence: e2e-native/shots/results.json)`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
