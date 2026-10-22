import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToBrief, checkRecap, newBrief, readRecaps, recapper, recapPrompt, saveRecap } from "../src/recaps";

const MIN = 60_000;
const now = 1_000_000_000_000;

const none = { done: [], doing: [], stuck: [], next: [] };

describe("checkRecap", () => {
  test("one goal, then what's done, in progress, stuck and next, each one line", () => {
    // As haiku answers: the kinds in its own order, a blank line between some.
    const out = [
      "GOAL | Make the phone's login work again",
      "DONE | Token refresh fixed in src/auth.ts",
      "DONE | Tests added for an expired token",
      "",
      "DOING | Running the full test suite",
      "STUCK | Waiting on you: approve the deploy to production",
      "STUCK | Tests fail in auth.test.ts on the clock skew case",
      "NEXT | Release v0.2.20",
      "NEXT | Tell the phone testers",
      "",
    ].join("\n");
    expect(checkRecap(out)).toEqual({
      goal: "Make the phone's login work again",
      done: ["Token refresh fixed in src/auth.ts", "Tests added for an expired token"],
      doing: ["Running the full test suite"],
      stuck: ["Waiting on you: approve the deploy to production", "Tests fail in auth.test.ts on the clock skew case"],
      next: ["Release v0.2.20", "Tell the phone testers"],
    });
    // A kind with nothing in it is left out; any case, any spaces round the bar.
    expect(checkRecap("goal|Tidy the README\ndone | Install steps rewritten\nNext  |  Add a screenshot")).toEqual({ ...none, goal: "Tidy the README", done: ["Install steps rewritten"], next: ["Add a screenshot"] });
    expect(checkRecap("GOAL | Tidy the README")).toEqual({ ...none, goal: "Tidy the README" });
  });

  test("markdown marks are taken out, and only the first 4 done and 3 of each other kind are kept", () => {
    const many = (kind: string) => Array.from({ length: 6 }, (_, i) => `${kind} | ${kind.toLowerCase()} ${i}`).join("\n");
    const r = checkRecap(`GOAL | Fix **the** \`build\`\n${many("DONE")}\n${many("DOING")}\n${many("STUCK")}\n${many("NEXT")}\nNEXT | - ship it`);
    expect(r).toEqual({
      goal: "Fix the build",
      done: ["done 0", "done 1", "done 2", "done 3"],
      doing: ["doing 0", "doing 1", "doing 2"],
      stuck: ["stuck 0", "stuck 1", "stuck 2"],
      next: ["next 0", "next 1", "next 2"],
    });
    expect(checkRecap("GOAL | a\nSTUCK | **Waiting on you:** pick a name")!.stuck).toEqual(["Waiting on you: pick a name"]);
  });

  test("a line over 140 characters is cut at a word with …, and the rest of the card is kept", () => {
    const long = "Saving your testing rule to recense failed twice because its background cleanup is holding a lock. Decide whether to let it finish so I can retry.";
    const done150 = `${"word ".repeat(29)}abcd`.padEnd(150, "x");
    const r = checkRecap(`GOAL | ${"goal ".repeat(40)}\nDONE | ${done150}\nDONE | Tests added\nSTUCK | ${long}\nNEXT | Release it`)!;
    expect(r.done[1]).toBe("Tests added");
    expect(r.next).toEqual(["Release it"]);
    for (const l of [r.goal, r.done[0], r.stuck[0]]) expect(l.length).toBeLessThanOrEqual(140), expect(l.endsWith("…")).toBe(true);
    expect(r.stuck[0]).toBe(long.slice(0, long.lastIndexOf(" ", 139)) + "…");
    expect(r.goal).toBe(`${"goal ".repeat(27)}goal…`);
    expect(r.done[0]).toBe(`${"word ".repeat(27)}word…`);
    // One long word: cut where it hits 140.
    expect(checkRecap(`GOAL | ${"x".repeat(200)}`)!.goal).toBe("x".repeat(139) + "…");
  });

  test("an item that only says there's nothing is skipped, not shown under a heading", () => {
    // As haiku wrote them for a session with everything done.
    const out = [
      "GOAL | Fix typos in the README and commit them",
      "DONE | Fixed 6 typos in README.md",
      "DONE | Committed as a1b2c3d",
      "DOING | Nothing running right now",
      "STUCK | None",
      "STUCK | No blockers.",
      "NEXT | Nothing left. Ask for a new task if you want more work done here.",
      "NEXT | Nothing left to do on this task",
      "NEXT | **N/A**",
    ].join("\n");
    expect(checkRecap(out)).toEqual({ ...none, goal: "Fix typos in the README and commit them", done: ["Fixed 6 typos in README.md", "Committed as a1b2c3d"] });
    // One that goes on to say what is an item; skipped ones don't count toward the 3.
    const r = checkRecap("GOAL | a\nSTUCK | Nothing renders in Safari\nSTUCK | None of the tests pass on CI\nNEXT | Nothing else\nNEXT | x\nNEXT | y\nNEXT | z")!;
    expect(r.stuck).toEqual(["Nothing renders in Safari", "None of the tests pass on CI"]);
    expect(r.next).toEqual(["x", "y", "z"]);
    // The goal is never skipped.
    expect(checkRecap("GOAL | None")!.goal).toBe("None");
  });

  test("anything else is ignored", () => {
    expect(checkRecap("")).toBeUndefined();
    expect(checkRecap("DONE | a")).toBeUndefined(); // no goal
    expect(checkRecap("GOAL | a\nGOAL | b")).toBeUndefined();
    expect(checkRecap("Here is the card:\nGOAL | a")).toBeUndefined();
    expect(checkRecap("GOAL | ")).toBeUndefined();
    expect(checkRecap("GOAL | a\nSTUCK | bell\x07")).toBeUndefined();
    expect(checkRecap("GOAL | a\nDOING | ")).toBeUndefined();
    // The kinds from before, or ones made up.
    expect(checkRecap("GOAL | a\nOPEN | b")).toBeUndefined();
    expect(checkRecap("GOAL | a\nBLOCKED | b")).toBeUndefined();
    // A colon instead of the bar.
    expect(checkRecap("GOAL: a\nDONE: b")).toBeUndefined();
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
  expect(p).toContain("DOING | ");
  expect(p).toContain("STUCK | ");
  expect(p).toContain("NEXT | ");
  expect(p).toContain("Leave out a kind with nothing in it: never write a line saying there is nothing.");
  // Claude asking you something is stuck on you, not in progress.
  expect(p).toContain('If Claude asked the user something or waits for their go-ahead, that is STUCK ("Waiting on you: ..."), never DOING');
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
    for (let i = 0; i < 203; i++) saveRecap(`s${i}`, { goal: `g ${i}`, ...none, at: 1000 + i, replies: 1 }, file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const all = readRecaps(file);
    expect(Object.keys(all).length).toBe(200);
    expect(all.s0).toBeUndefined();
    expect(all.s202).toEqual({ goal: "g 202", ...none, at: 1202, replies: 1 });
    writeFileSync(file, "{ not json");
    expect(readRecaps(file)).toEqual({});
    rmSync(dir, { recursive: true, force: true });
  });
});

const line = (o: object) => JSON.stringify(o) + "\n";
const prompt = (t: string) => line({ type: "user", message: { role: "user", content: t } });
const reply = (t: string) => line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: t }] } });
const CARD = "GOAL | Ship the login fix\nDONE | Token refresh fixed\nDOING | Running the tests\nSTUCK | Waiting on you: approve the deploy\nNEXT | Release it";

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
    const card = { goal: "Ship the login fix", done: ["Token refresh fixed"], doing: ["Running the tests"], stuck: ["Waiting on you: approve the deploy"], next: ["Release it"] };
    // open: doing, stuck and next in one, for the apps from 0.3.0.
    const want = { ...card, open: ["Running the tests", "Waiting on you: approve the deploy", "Release it"], at: now };
    expect(await recap(session)).toEqual(want);
    expect(asked.length).toBe(1);
    expect(asked[0]).toContain("Session: Login\n");
    expect(asked[0]).toContain("- Shipping.\n");
    // open isn't kept: it's made from the others.
    expect(readRecaps(deps.file).s1).toEqual({ ...card, at: now, replies: 3 });
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

  test("one kept by a blimpd from before doing, stuck and next is written again, not given as it was", async () => {
    const { dir, asked, deps, session } = setup();
    writeFileSync(deps.file, JSON.stringify({ s1: { goal: "Old goal", done: ["Old done"], open: ["Old open"], at: now - MIN, replies: 3 } }));
    expect(readRecaps(deps.file)).toEqual({});
    const r = await recapper(deps)(session);
    expect(asked.length).toBe(1);
    expect(r).toMatchObject({ goal: "Ship the login fix", next: ["Release it"], at: now });
    expect(readRecaps(deps.file).s1).toMatchObject({ goal: "Ship the login fix", replies: 3 });
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
