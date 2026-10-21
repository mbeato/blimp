// blimpd send <session> <message…>: types a message into another session's Claude, the way the
// phone does (the chat socket's input: refused while Claude asks something). Run from inside a
// blimp session, the message says which one it came from and how to answer, so two sessions can
// talk. It reaches the running blimpd on its socket, with the Mac's token.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { blimpDir, socketPath } from "./sessions";

export async function runSend(args: string[]): Promise<number> {
  const fail = (m: string) => (console.error(`blimpd send: ${m}`), 1);
  const [name, ...words] = args;
  const text = words.length ? words.join(" ") : await new Response(Bun.stdin.stream()).text();
  if (!name || !text.trim()) return fail('usage: blimpd send <session> <message> (or the message on stdin)');
  let token: string;
  try {
    token = readFileSync(join(blimpDir(), "token"), "utf8").trim();
  } catch {
    return fail("blimpd isn't set up here (no token)");
  }
  const sock = socketPath();
  let sessions: { name: string; sessionId?: string }[];
  try {
    sessions = await (await fetch("http://blimpd/sessions", { unix: sock, headers: { Authorization: `Bearer ${token}` } } as any)).json();
  } catch {
    return fail("blimpd isn't running");
  }
  const s = sessions.find((x) => x.name === name);
  if (!s) return fail(`no session named ${name}`);
  if (!s.sessionId) return fail(`${name} has no Claude conversation to send to`);
  const from = process.env.ZMX_SESSION;
  const message = from ? `[from blimp session ${from}; reply with: blimpd send ${from} "<message>"]\n${text}` : text;

  const id = crypto.randomUUID();
  return await new Promise<number>((done) => {
    const ws = new WebSocket(`ws+unix://${sock}:/sessions/${encodeURIComponent(name)}/chat?token=${token}`);
    const end = (code: number) => (ws.close(), done(code));
    ws.onopen = () => ws.send(JSON.stringify({ type: "input", id, text: message }));
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.id !== id) return;
      if (m.type === "ack") return console.log(`sent to ${name}`), end(0);
      if (m.type === "error") end(fail(m.error));
    };
    ws.onclose = (e) => done(fail(e.code === 4000 ? `${name} ended` : "lost the connection to blimpd"));
  });
}
