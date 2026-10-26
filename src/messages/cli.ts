// blimpd messages on | off | status | revoke (docs/superpowers/specs/2026-10-26-messages-design.md): texting the
// assistant through a relay on a Mac. On makes the relay's key if there's none; off refuses the relay and keeps
// the key; revoke deletes the key.

import { join } from "node:path";
import { blimpDir } from "../sessions";
import { makeRelayKey, messagesFile, messagesOn, readRelayKey, readState, relayKeyFile, revokeRelayKey, setMessagesOn } from "./store";

const ago = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 3_600_000)} h`);

export function runMessages(args: string[], dir = blimpDir(), now = Date.now()): number {
  const [what, ...rest] = args;
  if (rest.length || (what !== undefined && !["on", "off", "status", "revoke"].includes(what))) {
    console.error("blimpd messages: usage: blimpd messages on | off | status | revoke");
    return 1;
  }
  const config = join(dir, "config.json");
  if (what === "on") {
    setMessagesOn(true, config, messagesFile(dir));
    makeRelayKey(dir);
    console.log(`Texting is on. The relay's key is in ${relayKeyFile(dir)}: copy it into the relay's relay.json.`);
  } else if (what === "off") {
    setMessagesOn(false, config, messagesFile(dir));
    console.log("Texting is off. blimpd refuses the relay until it's on again; its key stays.");
  } else if (what === "revoke") {
    revokeRelayKey(dir);
    console.log("The relay's key is gone. blimpd messages on makes a new one, for a new relay.json.");
  } else {
    const s = readState(messagesFile(dir));
    const n = s.outbox.length;
    console.log(
      [
        messagesOn(config) ? "Texting is on." : "Texting is off.",
        s.relaySeen === undefined ? "The relay hasn't called yet." : `The relay last called ${ago(now - s.relaySeen)} ago.`,
        `${n} ${n === 1 ? "text is" : "texts are"} waiting to go out.`,
        ...(readRelayKey(dir) ? [] : ["There's no relay key: blimpd messages on makes one."]),
      ].join(" "),
    );
  }
  return 0;
}
