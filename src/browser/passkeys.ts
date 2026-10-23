// Passkeys: a page that asks for one (WebAuthn) gets Chrome's own passkey dialog, which headless
// Chrome never draws, and while it's open the page takes no clicks or keys. The phone's or Mac's
// passkeys can't reach a server's Chrome either (that needs Bluetooth near it). So blimpd keeps
// Chrome's virtual passkey mode on in every tab, with its dialog off and no virtual passkeys: the
// ask is never answered, the page stays usable (a site's "try another way"), and the page hears
// no (NotAllowedError) when its own wait ends.
//
// The mode lasts while the session that turned it on stays, and Chrome turns it off for the tab
// whenever any session on it leaves (a view closing, a session's MCP quitting), so blimpd keeps
// one session on each tab and turns it on again after every other session's leaving. It has to be
// on before the ask: turning it on doesn't close a dialog already open.

import type { CdpMessage, Chrome } from "./chrome";

// attach: the gate's attachDirect, so these sessions are never taken for a client's.
export function keepPasskeyDialogsOff(chrome: Chrome, attach: (targetId: string) => Promise<string | undefined>) {
  const mine = new Map<string, string>(); // targetId → blimpd's session on it
  const on = (s: string) => void chrome.call("WebAuthn.enable", { enableUI: false }, s);
  chrome.onMessage((m: CdpMessage) => {
    if (m.sessionId) return;
    const p = m.params ?? {};
    if (m.method === "Target.targetCreated" && p.targetInfo?.type === "page") {
      const id = p.targetInfo.targetId;
      void attach(id).then((s) => s && (mine.set(id, s), on(s)));
    } else if (m.method === "Target.detachedFromTarget" && mine.has(p.targetId)) {
      // Sent at once, from this event: it reaches Chrome before anything sent after the leaving.
      if (p.sessionId !== mine.get(p.targetId)) on(mine.get(p.targetId)!);
      else mine.delete(p.targetId);
    } else if (m.method === "Target.targetDestroyed") mine.delete(p.targetId);
  });
}
