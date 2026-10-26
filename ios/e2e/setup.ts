// Stand-in Claude sessions for the iPhone end-to-end test (the app-e2e job in .github/workflows/ios.yml,
// driven by ios/BlimpUITests). Run after blimpd has started: it makes three zmx sessions that look like
// Claude to blimpd (the same way test/server.test.ts does), a past conversation, then writes the pairing link.
//   demo-chat  in blimp-demo: a conversation; every line typed into it is appended to $E2E_DIR/chat.in
//              and, with a reply, to its transcript. Its recap is the stand-in claude's (ios/e2e/bin)
//   demo-ask   in api-server: waiting on a permission prompt; every key pressed is appended to $E2E_DIR/prompt.in
//   demo-perm  in blimp-demo: waiting on a permission prompt with its command, answered from blimp-demo's inbox
//              (Needs you; api-server's doesn't list it) over POST /sessions/<name>/answer; every key is appended
//              to $E2E_DIR/perm.in
//   demo-busy  in api-server: working (Claude's status "busy"), its latest step "npm run lint"; every key pressed
//              is appended to $E2E_DIR/stop.in, and an Esc makes it idle
//   demo-quiz  in api-server: Claude's question dialog with two questions, the second multi-choice
//              (ios/e2e/fake-ask.ts draws it as Claude does); every key is appended to $E2E_DIR/quiz.in,
//              the answers go to $E2E_DIR/quiz.json. blimpd names it (the stand-in claude in ios/e2e/bin
//              answers its naming call): "Configure Integration Test Pipeline Runs" (40 characters, the most blimpd keeps)
//   demo-trust in api-server: Claude Code just started there and asks whether to trust the folder, with no
//              status file yet (ios/e2e/fake-trust.ts); every key is appended to $E2E_DIR/trust.in
//   demo-stuck in api-server: Claude Code that never says which conversation it is and shows nothing blimpd
//              reads, as when it's stuck on a screen only the Mac can answer (no status file)
//   a conversation in blimp-demo with no session running, for the project screen's Earlier list
//   a server browser tab in blimp-demo on $E2E_DIR/site/index.html (the job serves it on 127.0.0.1:$E2E_SITE_PORT): a
//              button and a field that put what reached them in the page's title, which the drawer's row shows
//   the feed: on, three cards ready ("Demo card one" to "three", ids 1111…, 2222…, 3333…), Reddit's last run failed
//              for want of a key, and lastRun now, so blimpd fetches nothing while the tests run;
//              testFeed restores this fixture at its start ($E2E_DIR/feed-fixture.json to the path in $E2E_DIR/feed-path)
// The folders are under the home folder ($E2E_WORK, else ~/e2e-work): blimpd starts sessions only there. Sessions
// the app starts run the stand-in claude in ios/e2e/bin. The texts here are what BlimpUITests looks for. The ports
// ($E2E_PORT for the app's link, $E2E_SITE_PORT for the page) are each shard's own when shards share a Mac.

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { projectFolderName } from "../../src/folders";
import { promptFromHook } from "../../src/prompt";
import { parseZmxList, zmxPath } from "../../src/sessions";

const root = process.env.E2E_DIR!;
const sock = process.env.BLIMPD_SOCKET!;
const claude = process.env.CLAUDE_CONFIG_DIR!;
const work = process.env.E2E_WORK || join(process.env.HOME!, "e2e-work");
const port = process.env.E2E_PORT || "7425";
const sitePort = process.env.E2E_SITE_PORT || "7431";
const env: Record<string, string | undefined> = { ...process.env };
delete env.ZMX_SESSION;

const T = new Date().toISOString();
const line = (o: object) => JSON.stringify({ timestamp: T, ...o }) + "\n";
const user = (uuid: string, text: string) => line({ type: "user", uuid, message: { role: "user", content: text } });
const said = (uuid: string, text: string) => line({ type: "assistant", uuid, message: { role: "assistant", content: [{ type: "text", text }] } });

async function until<T>(f: () => T, what: string, ms = 10000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

// A zmx session running `script` in dir, with Claude's status file and transcript for its pid.
async function standIn(name: string, dir: string, script: string, sessionId: string, lines: string[], status = "idle") {
  mkdirSync(dir, { recursive: true });
  Bun.spawnSync([zmxPath(), "attach", name, "sh", "-c", script], { env, cwd: dir, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const z = await until(() => parseZmxList(Bun.spawnSync([zmxPath(), "list"], { env }).stdout.toString()).find((s) => s.name === name && s.pid > 0), `zmx session ${name}`);
  mkdirSync(join(claude, "sessions"), { recursive: true });
  mkdirSync(join(claude, "projects", "e2e"), { recursive: true });
  writeFileSync(join(claude, "projects", "e2e", `${sessionId}.jsonl`), lines.join(""));
  writeFileSync(join(claude, "sessions", `${z.pid}.json`), JSON.stringify({ sessionId, cwd: dir, status }));
  console.log(`${name}: pid ${z.pid} in ${dir}`);
}

const chatIn = join(root, "chat.in");
const promptIn = join(root, "prompt.in");
const stopIn = join(root, "stop.in");
const permIn = join(root, "perm.in");
for (const f of [chatIn, promptIn, stopIn, permIn]) writeFileSync(f, "");

// Like Claude, it writes what it read (paste markers off) and a reply to its transcript, so the phone sees both arrive.
const chatSid = "e2e00000-0000-0000-0000-000000000001";
const chatLog = join(claude, "projects", "e2e", `${chatSid}.jsonl`);
const echo = String.raw`n=0; while IFS= read -r l; do printf '%s\n' "$l" >> '${chatIn}'; n=$((n+1)); t=$(printf %s "$l" | tr -d '\033' | sed 's/\[20[01]~//g'); ts=$(date -u +%Y-%m-%dT%H:%M:%SZ); printf '{"type":"user","uuid":"in%s","timestamp":"%s","message":{"role":"user","content":"%s"}}\n{"type":"assistant","uuid":"out%s","timestamp":"%s","message":{"role":"assistant","content":[{"type":"text","text":"Shipped: %s"}]}}\n' "$n" "$ts" "$t" "$n" "$ts" "$t" >> '${chatLog}'; done`;
await standIn("demo-chat", join(work, "blimp-demo"), echo, chatSid, [
  user("u1", "Add a dark mode toggle to settings"),
  line({ type: "assistant", uuid: "a1", message: { role: "assistant", content: [
    { type: "text", text: "I'll add the toggle, then run the tests." },
    { type: "tool_use", id: "t1", name: "Bash", input: { command: "swift test" } },
  ] } }),
  line({ type: "user", uuid: "u2", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "Test Suite 'All tests' passed" }] } }),
  said("a2", "Done. The toggle is in **Settings**, under Appearance.\n\n- `SettingsView.swift`: the new toggle\n- `Theme.swift`: reads it at launch"),
]);

// Raw keys, as Claude reads them: a digit arrives without Enter.
await standIn("demo-ask", join(work, "api-server"), `stty -icanon -echo; exec cat >> '${promptIn}'`,
  "e2e00000-0000-0000-0000-000000000002", [user("u1", "Run the test suite"), said("a1", "I'll run the tests.")]);

// Another, in blimp-demo, for the inbox's Needs you row: answered without opening its chat.
await standIn("demo-perm", join(work, "blimp-demo"), `stty -icanon -echo; exec cat >> '${permIn}'`,
  "e2e00000-0000-0000-0000-000000000007", [user("u1", "Build it"), said("a1", "I'll build it.")]);

// Working on something: the phone shows Stop on the working row, which presses Esc (raw keys again). Like
// Claude, it stops working on Esc: its status file says idle, and the phone's Stop goes away.
const busySid = "e2e00000-0000-0000-0000-000000000003";
const busyDir = join(work, "api-server");
const idle = JSON.stringify({ sessionId: busySid, cwd: busyDir, status: "idle" });
const stopped = String.raw`stty -icanon -echo; (while sleep 0.2; do case "$(tr '\033' E < '${stopIn}')" in *E) printf '%s' '${idle}' > '${join(claude, "sessions")}'/$$.json; break;; esac; done) & exec cat >> '${stopIn}'`;
await standIn("demo-busy", busyDir, stopped, busySid,
  // Longer than the screen, so the test sees the chat open at its end, not its start; and one long
  // reply near the end, which the phone folds (Show more).
  [user("u1", "Refactor the auth middleware"),
   ...Array.from({ length: 20 }, (_, i) => [said(`p${i}`, `Step ${i + 1}: looked at route ${i + 1} and its tests.`), user(`q${i}`, `Keep going with route ${i + 2}`)]).flat(),
   said("long", [
     "Here's the plan for the rest of the routes, so you can stop me before I touch anything you'd rather keep.",
     "Every route today checks the session cookie itself, in slightly different ways: some read it before parsing the body, some after, and two of them skip the expiry check entirely. The new middleware does that check once, in one place, and hands each route the signed-in user.",
     "- `auth.ts`: one `requireUser` middleware that reads the cookie, checks the signature and the expiry, and returns 401 with the same body everywhere\n- `routes/*.ts`: each route drops its own check and reads `req.user`\n- `admin.ts`: keeps its extra role check, now after `requireUser`\n- `auth.test.ts`: tests for a missing cookie, a bad signature, an expired session, and a good one",
     "The two routes that skipped the expiry check will start refusing old sessions. That's the point, but anyone signed in for more than a week will be asked to sign in again once this ships.",
     "I'll run the whole test suite after each route, not just at the end, so a break shows up next to the change that caused it.",
   ].join("\n\n")),
   user("q20", "Sounds good, go"),
   said("a1", "Working through the routes now."),
   // the latest step, which the working row says
   line({ type: "assistant", uuid: "a2", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm run lint" } }] } })], "busy");

// A conversation in blimp-demo with nothing running it: the project screen lists it under Earlier.
// Claude keeps it in a folder named after the real path of where it ran.
const demoDir = join(work, "blimp-demo");
const past = join(claude, "projects", projectFolderName(realpathSync(demoDir)));
mkdirSync(past, { recursive: true });
writeFileSync(join(past, "e2e00000-0000-0000-0000-000000000004.jsonl"), [
  line({ type: "user", uuid: "p1", cwd: realpathSync(demoDir), message: { role: "user", content: "Fix the login redirect" } }),
  said("p2", "Fixed: after signing in you land on the page you came from."),
].join(""));

// What Claude's PermissionRequest hook would write: after the session started, or blimpd takes it for an older one's.
const status = join(dirname(sock), "status");
mkdirSync(status, { recursive: true });
writeFileSync(
  join(status, "demo-ask.json"),
  JSON.stringify({ state: "waiting", at: Date.now(), sessionId: "e2e00000-0000-0000-0000-000000000002", event: "PermissionRequest",
    prompt: { kind: "permission", tool: "Bash", summary: "Ran `npm test`", options: ["Yes", "No"], keys: ["1", "\u001b"], answerable: true } }),
);

writeFileSync(
  join(status, "demo-perm.json"),
  JSON.stringify({ state: "waiting", at: Date.now(), sessionId: "e2e00000-0000-0000-0000-000000000007", event: "PermissionRequest",
    prompt: { kind: "permission", tool: "Bash", summary: "Ran `npm run build`", options: ["Yes", "No"], keys: ["1", "\u001b"], answerable: true, input: "npm run build" } }),
);

// Two questions at once, as Claude asks them: a pick, then ticks and a typed answer. The stand-in sets its
// status file to done once they're submitted, as Claude's Stop hook would.
const quizSid = "e2e00000-0000-0000-0000-000000000005";
const quizStatus = join(status, "demo-quiz.json");
const questions = [
  { question: "Which database should the tests use?", header: "Database", multiSelect: false,
    options: [{ label: "Postgres", description: "The real server, in Docker" }, { label: "SQLite", description: "A file, fastest" }] },
  { question: "Which checks should run first?", header: "Checks", multiSelect: true,
    options: [{ label: "Lint" }, { label: "Unit tests" }, { label: "E2E" }] },
];
const quizCfg = join(root, "quiz-cfg.json");
writeFileSync(join(root, "quiz.in"), "");
// testOpenFolder's browser goes from home to the work folder one folder at a time, by these steps.
writeFileSync(join(root, "work-under-home"), relative(realpathSync(process.env.HOME!), realpathSync(work)));
writeFileSync(quizCfg, JSON.stringify({ questions, keys: join(root, "quiz.in"), answers: join(root, "quiz.json"), status: quizStatus, sessionId: quizSid }));
await standIn("demo-quiz", join(work, "api-server"), `exec '${process.execPath}' '${join(import.meta.dir, "fake-ask.ts")}' '${quizCfg}'`,
  quizSid, [user("u1", "Set up the test pipeline"), said("a1", "A couple of questions first.")]);
writeFileSync(quizStatus, JSON.stringify({ state: "waiting", at: Date.now(), sessionId: quizSid, event: "PermissionRequest",
  prompt: promptFromHook({ hook_event_name: "PermissionRequest", tool_name: "AskUserQuestion", tool_input: { questions } }) }));

// Claude Code asking whether to trust its folder: no status file and no hook until it's answered. blimpd
// reads the question off the screen for a session started as Claude Code (its record of kinds says so, and
// of demo-stuck below).
const trustDir = join(work, "api-server");
const trustCfg = join(root, "trust-cfg.json");
writeFileSync(join(root, "trust.in"), "");
writeFileSync(trustCfg, JSON.stringify({ folder: trustDir, keys: join(root, "trust.in"), claudeDir: claude, sessionId: "e2e00000-0000-0000-0000-000000000006" }));
writeFileSync(join(dirname(sock), "session-kinds.json"), JSON.stringify({ "demo-trust": "claude", "demo-stuck": "claude" }));
Bun.spawnSync([zmxPath(), "attach", "demo-trust", "sh", "-c", `exec '${process.execPath}' '${join(import.meta.dir, "fake-trust.ts")}' '${trustCfg}'`],
  { env, cwd: trustDir, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
await until(() => parseZmxList(Bun.spawnSync([zmxPath(), "list"], { env }).stdout.toString()).some((s) => s.name === "demo-trust" && s.pid > 0), "zmx session demo-trust");
console.log("demo-trust: asking to trust " + trustDir);

// Claude Code by the kind blimpd remembers it was started as, with no status file and a blank screen: starting, for good.
Bun.spawnSync([zmxPath(), "attach", "demo-stuck", "sh", "-c", "exec cat > /dev/null"], { env, cwd: join(work, "api-server"), stdin: "ignore", stdout: "ignore", stderr: "ignore" });
await until(() => parseZmxList(Bun.spawnSync([zmxPath(), "list"], { env }).stdout.toString()).some((s) => s.name === "demo-stuck" && s.pid > 0), "zmx session demo-stuck");

const token = readFileSync(join(dirname(sock), "token"), "utf8").trim();

// The browser tab: its page is laid out for the phone once the phone opens it. A tap on the button, then
// typing in the field, make the title "tapped typed:<what was typed>".
mkdirSync(join(root, "site"), { recursive: true });
writeFileSync(join(root, "site", "index.html"), `<!doctype html><meta name="viewport" content="width=device-width"><title>e2e page</title>
<body style="margin:0;font:20px sans-serif">
<button style="display:block;width:100%;height:150px" onclick="window.tapped=1;document.title='e2e page tapped'">Tap me</button>
<input style="position:absolute;top:200px;left:0;width:100%;height:50px" oninput="document.title=(window.tapped?'tapped ':'')+'typed:'+this.value">`);
const opened = await fetch("http://localhost/browser/tabs", {
  unix: sock, method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ dir: join(work, "blimp-demo"), url: `http://127.0.0.1:${sitePort}/` }),
});
if (!opened.ok) throw new Error(`couldn't open the browser tab: ${opened.status} ${await opened.text()}`);
console.log(`browser tab ${(await opened.json()).id} in blimp-demo`);
// The feed (testFeed): feed.json before the switch, so blimpd's job never sees it on with no lastRun.
const feedAt = Date.now();
const feedCard = (n: number, word: string) => {
  const id = String(n).repeat(16);
  return [id, { id, url: `https://example.com/${n}`, title: `Demo card ${word}`, summary: `The ${word} demo card.`, sources: [{ kind: "hn", name: "Hacker News", score: 100 * n, comments: 10 * n, thread: `https://news.ycombinator.com/item?id=${n}` }], at: feedAt, rank: n, tries: 0 }];
};
const feedFixture = JSON.stringify({
  cards: Object.fromEntries([feedCard(1, "one"), feedCard(2, "two"), feedCard(3, "three")]),
  seen: {}, saved: [], lastRun: feedAt, calls: [],
  runs: { "Hacker News": { at: feedAt, ok: true }, Reddit: { at: feedAt, ok: false, reason: "no key" } },
});
// testFeed puts the fixture back at its start (seen marks persist, so a retried run needs it again).
writeFileSync(join(dirname(sock), "feed.json"), feedFixture);
writeFileSync(join(root, "feed-fixture.json"), feedFixture);
writeFileSync(join(root, "feed-path"), join(dirname(sock), "feed.json"));
writeFileSync(join(dirname(sock), "config.json"), JSON.stringify({ feed: { on: true } }));
console.log("feed: on, three cards");

writeFileSync(join(root, "link"), `blimp://pair?url=${encodeURIComponent(`http://127.0.0.1:${port}`)}&token=${token}`);
console.log("stand-ins ready");
