// blimp-relay (docs/superpowers/specs/2026-10-26-messages-design.md): carries texts between Messages on a Mac and
// blimpd. It runs as a LaunchAgent in the Mac user whose Messages is signed in to the assistant's Apple ID. Its
// folder (the binary's, or $BLIMP_RELAY_DIR) holds relay.json ({"server", "key", "allow"}; no server means echo
// mode) and state.json. Its log is ~/Library/Logs/blimp-relay.log.

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { newTexts, openChatDb, watermark } from "./chatdb";
import { inLoop, outLoop, parseConfig, parseState, type RelayDeps, type State } from "./relay";
import { pokeMessages, sendText } from "./send";

const dir = process.env.BLIMP_RELAY_DIR || dirname(process.execPath);
const logs = join(homedir(), "Library", "Logs");
let lastLine = "";
// A line repeated right after itself is written once, so a relay that keeps failing doesn't fill the disk.
function log(m: string) {
  if (m === lastLine) return;
  lastLine = m;
  mkdirSync(logs, { recursive: true });
  appendFileSync(join(logs, "blimp-relay.log"), `${new Date().toISOString()} ${m}\n`);
}

const read = (file: string) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
};
const stateFile = join(dir, "state.json");
function save(s: State) {
  writeFileSync(stateFile + ".tmp", JSON.stringify(s), { mode: 0o600 });
  renameSync(stateFile + ".tmp", stateFile);
}

try {
  const text = read(join(dir, "relay.json"));
  if (text === undefined) throw new Error(`no relay.json in ${dir}`);
  const config = parseConfig(text);
  // Without Full Disk Access this throws ("authorization denied"); launchd starts the relay again 30 s later.
  const db = openChatDb(join(homedir(), "Library", "Messages", "chat.db"));
  const d: RelayDeps = {
    config,
    state: parseState(read(stateFile)),
    save,
    watermark: () => watermark(db),
    read: (after) => newTexts(db, after, config.allow),
    send: (t, to) => sendText(t, to),
    fetch: (path, init = {}) => fetch(config.server + path, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${config.key}` } }),
    log,
    sleep: (ms) => Bun.sleep(ms),
  };
  log(`started, ${config.server ? `with blimpd at ${config.server}` : "in echo mode"}`);
  const why = pokeMessages();
  if (why) log(`couldn't reach Messages at start: ${why}`);
  if (config.server) void outLoop(d);
  await inLoop(d);
} catch (e) {
  log(`stopped: ${(e as Error).message}`);
  process.exit(1);
}
