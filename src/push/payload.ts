// What a notification says (docs/superpowers/specs/2026-10-20-phone-push-design.md, section 4), as Apple's JSON: the
// alert, the session as its thread (iOS groups them), and for the app `session`, `kind` and, for a permission, the
// wait's `at` and the pick and label that Yes and No answer with: the first option and the last, as on the phone.
// Text goes through Apple's servers, so secrets come out first (activity.ts redact).

import { basename } from "node:path";
import { redact } from "../activity";
import type { Session } from "../sessions";
import type { PushEvent, PushSession } from "./rule";

export type Shown = PushSession & Pick<Session, "title" | "dir">;
export type Choice = { pick: number; label: string };
// The category the app gives Yes and No (Yes needs Face ID).
export const PERMISSION_CATEGORY = "permission";

// At most n characters (code points, so never half an emoji), with … when cut.
const cut = (s: string, n: number) => {
  const a = Array.from(s);
  return a.length > n ? a.slice(0, n - 1).join("").trimEnd() + "…" : s;
};

// One line of plain text from Markdown: fences, links (their words stay), headings, quotes, list marks, emphasis
// and code marks out. A single underscore stays: it's more often in a name than emphasis.
export function plainText(md: string): string {
  return md
    .replace(/^\s*```.*$/gm, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/\*(\S[^*\n]*?)\*/g, "$1")
    .replace(/`([^`\n]*)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function pushPayload(s: Shown, e: PushEvent, reply?: string): Record<string, unknown> {
  const title = cut(s.title, 80);
  const folder = basename(s.dir) || s.dir;
  const p = s.prompt;
  const aps: Record<string, unknown> = { alert: {}, sound: "default", "thread-id": s.name };
  const data: Record<string, unknown> = { session: s.name, kind: e.kind };
  if (e.kind === "finish") {
    const text = reply ? cut(plainText(redact(reply)), 150) : "";
    aps.alert = { title: `${title} finished`, body: text || folder };
  } else if (p?.kind === "permission" && p.options.length >= 2) {
    const last = p.options.length - 1;
    aps.alert = { title: `${title} is waiting`, body: cut(redact(p.summary), 200) };
    aps.category = PERMISSION_CATEGORY;
    const yes: Choice = { pick: 0, label: p.options[0] };
    const no: Choice = { pick: last, label: p.options[last] };
    Object.assign(data, { at: p.at, yes, no });
  } else if (p?.kind === "question" && p.questions[0]) {
    aps.alert = { title: `${title} is waiting`, body: cut(redact(p.questions[0].question), 200) };
  } else {
    aps.alert = { title: `${title} is waiting`, body: folder };
  }
  return { aps, ...data };
}
