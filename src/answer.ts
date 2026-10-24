// Answering what a waiting Claude asks (docs/DESIGN.md, Chat): for the phone's chat socket (chatsocket.ts)
// and for POST /sessions/<name>/answer (server.ts), one implementation, so both type the same keys. An
// answer names the wait it's for (`at`) and the choice as it was shown (`label`): one asked again, or
// answered on the Mac first, is refused and nothing is typed. The keys go through the session's one
// typing queue (typing.ts), so they never interleave with a message or another answer.

import { HttpError } from "./files";
import { answerKeys, answerSteps, choiceLabel, cleanText, type Expect, type Prompt, parseDialog, parseTrust, screenMeets, trustSteps } from "./prompt";
import { zmxOutput } from "./sessions";
import { Asking, findSession, release, typed, type Typist, typist, wasTyped } from "./typing";

// How long a deny waits after its Esc for Claude to stop asking: well under a second, unless it didn't take the Esc.
const DENY_WAIT = 5000;

// Types m (an `answer`, `interrupt` or `deny`, as the chat socket takes them) once per id, or throws why not,
// in words for the person who sent it. Callers check first that it's a Claude session with a conversation
// (or, for an answer, one asking whether to trust its folder).
export async function answer(t: Typist, id: string, m: any): Promise<void> {
  const name = t.name;
  if (wasTyped(name, id)) return;
  if (m.type === "answer" && m.answers !== undefined) {
    // Every question of a dialog: blimpd types it step by step, each after the screen shows its place.
    let steps: { expect: Expect }[] = [];
    let p: Prompt | undefined;
    return typed(t, id, async () => {
      const s = await findSession(name);
      p = s?.state === "waiting" && s.prompt?.at === m.at ? s.prompt : undefined;
      const r = p ? answerSteps(p, m.answers, m.labels) : { error: "the question changed" };
      if ("error" in r) throw new Error(r.error);
      steps = r.steps;
      await onScreen(name, p!, steps[0].expect);
      return r.steps.map((s) => s.keys);
    }, (i) => onScreen(name, p!, steps[i].expect));
  }
  if (m.type === "answer") {
    let steps: ReturnType<typeof trustSteps>;
    let preview: { p: Prompt; steps: { expect: Expect }[] } | undefined;
    return typed(t, id, async () => {
      const s = await findSession(name);
      // The same wait and the same choice under pick: the options can change within one wait.
      const p = s?.state === "waiting" ? s.prompt : undefined;
      const same = p && p.at === m.at && typeof m.label === "string" && choiceLabel(p, m.pick) === m.label;
      // Folder trust has no digits: the cursor is moved and Enter pressed, each after the screen shows it.
      if (same && p.kind === "trust" && (steps = trustSteps(m.pick))) {
        await onTrust(name, steps[0].cursor);
        return steps.map((t) => t.keys);
      }
      // A question with previews: the digit moves the cursor, then Enter, each after the screen shows its place.
      if (same && p.kind === "question" && p.questions[0]?.preview) {
        const r = answerSteps(p, [{ picks: [m.pick] }], [[m.label]]);
        if ("error" in r) throw new Error(r.error);
        preview = { p, steps: r.steps };
        await onScreen(name, p, r.steps[0].expect);
        return r.steps.map((s) => s.keys);
      }
      const keys = same ? answerKeys(p, m.pick) : undefined;
      if (!keys) throw new Error("the question changed");
      return [keys];
    }, (i) => (preview ? onScreen(name, preview.p, preview.steps[i].expect) : onTrust(name, steps![i].cursor)));
  }
  if (m.type === "interrupt") {
    // With `at`, the phone dismisses that question: Esc only while it's still up. Otherwise the Esc would
    // stop Claude's work, if it was answered on the Mac just before.
    return typed(t, id, async () => {
      if (m.at !== undefined) await stillAsking(name, m.at);
      return ["\x1b"];
    });
  }
  if (m.type === "deny") {
    // No, and why: Esc says no (as Dismiss does), then the reason goes in as a message once Claude has
    // stopped asking. One write, so nothing else is typed in between.
    if (typeof m.text !== "string" || m.text.length > 100_000 || !cleanText(m.text).trim())
      throw new HttpError(400, "text must be some text, at most 100 000 characters");
    // Without it, a waiting session with no prompt read yet would take the Esc.
    if (typeof m.at !== "number") throw new HttpError(400, "a deny needs the prompt's at");
    const text = cleanText(m.text);
    return typed(t, id, async () => {
      await stillAsking(name, m.at);
      return ["\x1b", "\x1b[200~" + text + "\x1b[201~", "\r"];
    }, (i) => (i === 1 ? answered(name) : notWaiting(name)));
  }
  throw new HttpError(400, "unknown message");
}

async function stillAsking(name: string, at: unknown) {
  const s = await findSession(name);
  if (s?.state !== "waiting" || s.prompt?.at !== at) throw new Error("the question changed");
}

async function notWaiting(name: string) {
  if ((await findSession(name))?.state === "waiting") throw new Asking();
}

// After a deny's Esc: until Claude no longer asks. Still asking after DENY_WAIT, the reason isn't typed:
// its Enter would confirm whatever is highlighted.
async function answered(name: string) {
  const end = Date.now() + DENY_WAIT;
  for (;;) {
    const s = await findSession(name);
    if (!s) throw new Error("the session ended");
    if (s.state !== "waiting") return;
    if (Date.now() > end) throw new Error("Claude still asks something after Esc. Send your reason once it's answered.");
    await Bun.sleep(100);
  }
}

// Waits (up to 3 s) for Claude's screen to show where the next keys belong. Otherwise the answer stops
// there: the rest would land in the wrong place.
async function untilScreen(name: string, where: string, want: string, meets: (screen: string) => boolean, read: (screen: string) => unknown) {
  const end = Date.now() + 3000;
  for (;;) {
    const screen = (await zmxOutput("history", name)).split("\n").slice(-120).join("\n");
    if (meets(screen)) return;
    if (Date.now() > end) {
      // What it saw, so a stopped answer can be told apart from a new dialog layout.
      console.error(`answer for ${name} stopped before ${where} (${want}); the screen read as ${JSON.stringify(read(screen))}; the screen's end:\n${screen.split("\n").slice(-30).join("\n")}`);
      throw new Error(`stopped: Claude's screen didn't show ${where} as expected. Finish it on the Mac.`);
    }
    await Bun.sleep(100);
  }
}

const onScreen = (name: string, p: Prompt, e: Expect) =>
  untilScreen(name, "review" in e ? "the review screen" : `question ${e.q + 1}`, JSON.stringify(e), (s) => screenMeets(p, parseDialog(s), e), parseDialog);

const onTrust = (name: string, cursor: "yes" | "no") =>
  untilScreen(name, "the folder trust question", `cursor on ${cursor}`, (s) => parseTrust(s)?.cursor === cursor, parseTrust);

// For POST /sessions/<name>/answer: the chat socket's checks, with a zmx client of its own for just this
// answer. Throws HttpError: 404 for no such session, 400 for a body that isn't an answer, 409 with why
// when it wasn't typed (asked again, answered already, not a Claude session, the screen not as expected).
export async function answerOnce(name: string, id: string, m: any): Promise<void> {
  const s = await findSession(name);
  if (!s) throw new HttpError(404, `no session named ${name}`);
  // Before Claude has a conversation, the one thing to answer is its folder trust question.
  if (!s.sessionId && !(m.type === "answer" && s.prompt?.kind === "trust")) throw new HttpError(409, "open this session on the Mac");
  const t = typist(name);
  try {
    await answer(t, id, m);
  } catch (e) {
    throw e instanceof HttpError ? e : new HttpError(409, (e as Error).message);
  } finally {
    await release(t);
  }
}
