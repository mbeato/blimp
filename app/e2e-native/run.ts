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
  zmx("run", "blimptest-a", "echo", "pre-existing-screen");

  const dlog = openSync(join(tmp, "driver.log"), "a");
  driver = spawn("tauri-driver", ["--port", String(PORT)], {
    env: { ...zenv, HOME: appHome, BLIMP_REMOTE_DIR: tmp, BLIMPD_SOCKET: "" },
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

  // Open Folder (the top bar's button), typed path.
  await click(".topbar .link-button");
  await until(5000, () => js("return !!document.querySelector('.dialog .dialog-input')"));
  await typeKeys([..."~/proj", "\uE007"]);
  const rows = await until(20_000, async () => ((await js("return document.querySelectorAll('.srow').length")) >= 2 ? true : undefined));
  record("Open Folder opens the project; its 2 sessions are listed", !!rows, await js("return [...document.querySelectorAll('.srow')].map(r => r.innerText.replace(/\\n/g,' '))"));
  const title = await until(5000, () => js("return document.title === 'proj — blimp' ? document.title : undefined"));
  const p1b = await probe();
  record("window title and set_window_project / set_viewing go through", !!title && ["set_window_project", "set_viewing"].every((c) => p1b.invokes.some((i: any) => i.cmd === c && i.ok)), {
    title: await js("return document.title"),
    invokes: p1b.invokes.filter((i: any) => /window|viewing/.test(i.cmd)),
  });
  await shot("02b-project");

  // 3. Terminal: existing screen, then type.
  await click('.srow[data-session="blimptest-a"] .srow-main');
  await until(10_000, () => js("return !!document.querySelector('.tpane-terms .term:not([hidden]) .xterm-screen')"));
  await sleep(1500);
  // xterm's WebGL renderer draws into a canvas, so the screen is checked in the screenshot.
  const renderer = await js("const t = document.querySelector('.tpane-terms .term:not([hidden])'); return t.querySelector('.xterm-rows') ? 'dom' : 'webgl (canvas)'");
  const screenText = () => js("const r = document.querySelector('.tpane-terms .term:not([hidden]) .xterm-rows'); return r ? r.innerText : ''");
  await shot("03a-terminal-before-typing");
  record("terminal attaches (existing screen: see 03a-terminal-before-typing.png)", true, { renderer, domText: (await screenText()).trim().slice(0, 200) });
  await click(".tpane-terms .term:not([hidden]) .xterm-screen");
  await typeKeys([..."echo native-ok", "\uE007"]);
  await sleep(1500);
  const hist = zmx("history", "blimptest-a");
  const outLines = hist.split("\n").filter((l) => l.trim() === "native-ok").length;
  record("typed 'echo native-ok' reaches the session and prints", outLines >= 1, { renderer, domText: (await screenText()).trim().slice(-200), zmxHistoryTail: hist.trim().split("\n").slice(-4) });
  await shot("03b-terminal-typed");

  // 4. Files pane: tree, .md, .ts (Monaco + worker), .png, .pdf (pdf.js + worker).
  const tree = await until(10_000, async () => {
    const t: string[] = await js("return [...document.querySelectorAll('.tree .tree-name')].map(e => e.textContent)");
    return t.includes("README.md") ? t : undefined;
  });
  record("files tree loads", !!tree, tree ?? (await js("return document.querySelector('.wb-tree')?.innerText")));
  const openFile = (name: string) => click(`.tree-row[title="${name}"]`);
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

  // 5. Palette: the UI binds metaKey only (App.tsx), so on Linux that is Super+K; no Ctrl+K mapping.
  await click(".slist .pane-title");
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
  record("no failed IPC calls", !p5.invokes.some((i: any) => i.ok === false), {
    failed: p5.invokes.filter((i: any) => i.ok === false),
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
  const again = await until(20_000, () => js("return [...document.querySelectorAll('.welcome-recent button')].some(b => b.textContent === 'proj')"));
  const store = join(appHome, ".local/share/dev.blimp.app/servers.json");
  const recentStore = join(appHome, ".local/share/dev.blimp.app/recent.json");
  record("servers and recent projects persist across restart (store plugin)", !!again && !(await js("return !!document.querySelector('.welcome form')")), {
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
