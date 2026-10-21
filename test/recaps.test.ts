import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToBrief, checkRecap, newBrief, readRecaps, recapper, recapPrompt, saveRecap } from "../src/recaps";

const MIN = 60_000;
const now = 1_000_000_000_000;

describe("checkRecap", () => {
  test("one goal, then what's done and what's open, each one line", () => {
    const out = "GOAL | Make the phone's login work again\nDONE | Token refresh fixed\nDONE | Tests added\n\nOPEN | Release v0.2.20\n";
    expect(checkRecap(out)).toEqual({ goal: "Make the phone's login work again", done: ["Token refresh fixed", "Tests added"], open: ["Release v0.2.20"] });
    expect(checkRecap("goal|Tidy the README\ndone | Install steps rewritten")).toEqual({ goal: "Tidy the README", done: ["Install steps rewritten"], open: [] });
  });

  test("markdown marks are taken out, and only the first 4 done and 4 open are kept", () => {
    const many = Array.from({ length: 6 }, (_, i) => `DONE | step ${i}`).join("\n");
    const r = checkRecap(`GOAL | Fix **the** \`build\`\n${many}\nOPEN | - ship it`);
    expect(r).toEqual({ goal: "Fix the build", done: ["step 0", "step 1", "step 2", "step 3"], open: ["ship it"] });
  });

  test("a line over 140 characters is cut at a word with …, and the rest of the card is kept", () => {
    const long = "Saving your testing rule to recense failed twice because its background cleanup is holding a lock. Decide whether to let it finish so I can retry.";
    const done150 = `${"word ".repeat(29)}abcd`.padEnd(150, "x");
    const r = checkRecap(`GOAL | ${"goal ".repeat(40)}\nDONE | ${done150}\nDONE | Tests added\nOPEN | ${long}\nOPEN | Release it`)!;
    expect(r.done[1]).toBe("Tests added");
    expect(r.open[1]).toBe("Release it");
    for (const l of [r.goal, r.done[0], r.open[0]]) expect(l.length).toBeLessThanOrEqual(140), expect(l.endsWith("…")).toBe(true);
    expect(r.open[0]).toBe(long.slice(0, long.lastIndexOf(" ", 139)) + "…");
    expect(r.goal).toBe(`${"goal ".repeat(27)}goal…`);
    expect(r.done[0]).toBe(`${"word ".repeat(27)}word…`);
    // One long word: cut where it hits 140.
    expect(checkRecap(`GOAL | ${"x".repeat(200)}`)!.goal).toBe("x".repeat(139) + "…");
  });

  test("anything else is ignored", () => {
    expect(checkRecap("")).toBeUndefined();
    expect(checkRecap("DONE | a")).toBeUndefined(); // no goal
    expect(checkRecap("GOAL | a\nGOAL | b")).toBeUndefined();
    expect(checkRecap("Here is the card:\nGOAL | a")).toBeUndefined();
    expect(checkRecap("GOAL | ")).toBeUndefined();
    expect(checkRecap("GOAL | a\nOPEN | bell\x07")).toBeUndefined();
    expect(checkRecap("GOAL | a\nNEXT | b")).toBeUndefined();
  });
});

const user = (text: string) => ({ id: "u", at: 0, role: "user" as const, text });
const said = (text: string) => ({ id: "a", at: 0, role: "assistant" as const, text });

test("a brief keeps the first request, the last 3 requests, the last 6 replies and the counts", () => {
  const b = newBrief();
  for (let i = 1; i <= 8; i++) addToBrief(b, user(`ask ${i}`)), addToBrief(b, said(`reply ${i}`));
  addToBrief(b, { id: "t", at: 0, role: "tool", name: "Bash", summary: "ls", input: "ls" });
  expect(b).toMatchObject({ prompts: 8, replies: 8, first: "ask 1", last: ["ask 6", "ask 7", "ask 8"], said: ["reply 3", "reply 4", "reply 5", "reply 6", "reply 7", "reply 8"] });
});

test("recapPrompt: the format, the title, the first and latest requests and the latest replies, each cut to about 300 characters", () => {
  const p = recapPrompt({ title: "Login fix", first: "fix the login", last: ["add tests", "b".repeat(1000)], said: ["Fixed it.", "Tests pass."], prompts: 5, replies: 7 });
  expect(p).toContain("GOAL | ");
  expect(p).toContain("DONE | ");
  expect(p).toContain("OPEN | ");
  expect(p).toContain("Session: Login fix\n");
  expect(p).toContain("5 requests and 7 replies so far.\n");
  expect(p).toContain("First request: fix the login\n");
  expect(p).toContain("Latest requests, oldest first:\n- add tests\n");
  expect(p).toContain(`- ${"b".repeat(300)}…\n`);
  expect(p).toContain("Claude's latest replies, oldest first:\n- Fixed it.\n- Tests pass.\n");
  // With 3 requests or fewer, the first is one of the latest.
  expect(recapPrompt({ first: "a", last: ["a"], said: [], prompts: 1, replies: 0 })).not.toContain("First request");
});

describe("recaps.json", () => {
  test("600, through a temp file, the 200 newest kept", () => {
    const dir = mkdtempSync(join(tmpdir(), "blimp-recaps-"));
    const file = join(dir, "recaps.json");
    for (let i = 0; i < 203; i++) saveRecap(`s${i}`, { goal: `g ${i}`, done: [], open: [], at: 1000 + i, replies: 1 }, file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const all = readRecaps(file);
    expect(Object.keys(all).length).toBe(200);
    expect(all.s0).toBeUndefined();
    expect(all.s202).toEqual({ goal: "g 202", done: [], open: [], at: 1202, replies: 1 });
    writeFileSync(file, "{ not json");
    expect(readRecaps(file)).toEqual({});
    rmSync(dir, { recursive: true, force: true });
  });
});

const line = (o: object) => JSON.stringify(o) + "\n";
const prompt = (t: string) => line({ type: "user", message: { role: "user", content: t } });
const reply = (t: string) => line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: t }] } });
const CARD = "GOAL | Ship the login fix\nDONE | Token refresh fixed\nOPEN | Release it";

describe("recapper", () => {
  const setup = (lines = [prompt("fix the login"), reply("Fixed."), prompt("add tests"), reply("Added."), prompt("ship it"), reply("Shipping.")]) => {
    const dir = mkdtempSync(join(tmpdir(), "blimp-recaps-"));
    const transcript = join(dir, "s1.jsonl");
    writeFileSync(transcript, lines.join(""));
    const asked: string[] = [];
    let answer: string | undefined = CARD;
    const ask = async (p: string) => (asked.push(p), answer);
    let t = now;
    const deps = { ask, now: () => t, on: () => true, file: join(dir, "recaps.json"), transcript: () => transcript };
    const session = { kind: "claude", sessionId: "s1", title: "Login" };
    return { dir, transcript, asked, deps, session, setAnswer: (a?: string) => (answer = a), at: (n: number) => (t = n) };
  };
  const status = (p: Promise<unknown>) => p.then(() => 200, (e) => [e.status, e.message]);

  test("the model's card, saved and given again until a new reply lands", async () => {
    const { dir, transcript, asked, deps, session } = setup();
    const recap = recapper(deps);
    const want = { goal: "Ship the login fix", done: ["Token refresh fixed"], open: ["Release it"], at: now };
    expect(await recap(session)).toEqual(want);
    expect(asked.length).toBe(1);
    expect(asked[0]).toContain("Session: Login\n");
    expect(asked[0]).toContain("- Shipping.\n");
    expect(readRecaps(deps.file).s1).toEqual({ ...want, replies: 3 });
    expect(await recap(session)).toEqual(want);
    // A fresh blimpd reads the saved one.
    expect(await recapper(deps)(session)).toEqual(want);
    expect(asked.length).toBe(1);
    appendFileSync(transcript, prompt("and the phone?"));
    expect(await recap(session)).toEqual(want); // a prompt alone changes nothing
    appendFileSync(transcript, reply("The phone works too."));
    await recap(session);
    expect(asked.length).toBe(2);
    expect(asked[1]).toContain("- The phone works too.\n");
    rmSync(dir, { recursive: true, force: true });
  });

  test("two asks at once share one call", async () => {
    const { dir, asked, deps, session } = setup();
    const recap = recapper(deps);
    const [a, b] = await Promise.all([recap(session), recap(session)]);
    expect(a).toEqual(b);
    expect(asked.length).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  test("404 when recaps are off, the session isn't Claude's, or it has fewer prompts than asked for", async () => {
    const { dir, asked, deps, session } = setup();
    expect(await status(recapper({ ...deps, on: () => false })(session))).toEqual([404, "Recaps are off"]);
    expect(await status(recapper(deps)({ ...session, kind: "shell" }))).toEqual([404, "No conversation to recap"]);
    expect(await status(recapper(deps)({ ...session, sessionId: undefined }))).toEqual([404, "No conversation to recap"]);
    expect(await status(recapper({ ...deps, transcript: () => undefined })(session))).toEqual([404, "No conversation to recap"]);
    expect(await status(recapper(deps)(session, 4))).toEqual([404, "Not enough to recap yet"]);
    expect(asked.length).toBe(0);
    expect(await status(recapper(deps)(session, 3))).toBe(200);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a conversation without a prompt and a reply has nothing to recap", async () => {
    const { dir, asked, deps, session } = setup([prompt("hello")]);
    expect(await status(recapper(deps)(session))).toEqual([404, "Not enough to recap yet"]);
    expect(asked.length).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("an answer that isn't a card is a 502 and saves nothing; the next ask tries again", async () => {
    const { dir, asked, deps, session, setAnswer } = setup();
    const recap = recapper(deps);
    setAnswer("Sure! The session is about logins.");
    expect(await status(recap(session))).toEqual([502, "Couldn't write a recap"]);
    setAnswer(undefined);
    expect(await status(recap(session))).toEqual([502, "Couldn't write a recap"]);
    expect(readRecaps(deps.file)).toEqual({});
    setAnswer(CARD);
    expect(await status(recap(session))).toBe(200);
    expect(asked.length).toBe(3);
    rmSync(dir, { recursive: true, force: true });
  });

  test("at most 30 calls an hour", async () => {
    const { dir, transcript, asked, deps, session, at } = setup();
    const recap = recapper(deps);
    for (let i = 0; i < 30; i++) {
      appendFileSync(transcript, reply(`more ${i}`));
      await recap(session);
    }
    appendFileSync(transcript, reply("one more"));
    expect(await status(recap(session))).toEqual([429, "Too many recaps this hour"]);
    expect(asked.length).toBe(30);
    at(now + 60 * MIN);
    expect(await status(recap(session))).toBe(200);
    rmSync(dir, { recursive: true, force: true });
  });
});
