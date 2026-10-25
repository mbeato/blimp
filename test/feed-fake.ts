// A stand-in for the internet in the feed's tests: each address gets its page (status 200; HTML when it starts with
// "<", JSON otherwise), a status alone, a whole answer, or an error to throw. Anything else throws "not faked".
// `asked` lists every address in order, a POST as "POST <address>".

import type { Get, Got } from "../src/feed/net";

export function fakeGet(pages: Record<string, string | number | Error | Got>) {
  const asked: string[] = [];
  const get: Get = async (url, init) => {
    asked.push(init?.method === "POST" ? `POST ${url}` : url);
    const p = pages[url];
    if (p === undefined) throw new Error(`not faked: ${url}`);
    if (p instanceof Error) throw p;
    if (typeof p === "number") return { status: p, text: "", type: "" };
    if (typeof p === "string") return { status: 200, text: p, type: p.trimStart().startsWith("<") ? "text/html" : "application/json" };
    return p;
  };
  return { get, asked };
}
