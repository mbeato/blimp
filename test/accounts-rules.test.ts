// Which account comes next and whose login a changed live file is (src/accounts/rules.ts). Pure: no files.

import { describe, expect, test } from "bun:test";
import { filing, isOut, nextAccount, resetAt } from "../src/accounts/rules";
import type { Rec, Saved, State } from "../src/accounts/store";

const now = 1_800_000_000_000;
const a: Saved = { id: "id-a", email: "a@x.com", expires: now + 1e9 };
const b: Saved = { id: "id-b", email: "b@x.com", expires: now + 1e9 };
const c: Saved = { id: "id-c", email: "c@x.com", expires: now + 1e9 };
const saved = [a, b, c];
const state = (s: Partial<State> = {}): State => ({ order: ["id-a", "id-b", "id-c"], out: {}, ...s });
const out = (until: number) => ({ at: now - 1000, until });

describe("nextAccount", () => {
  test("the one after the active one, wrapping round", () => {
    expect(nextAccount(saved, state({ active: "id-a" }), now)).toBe(b);
    expect(nextAccount(saved, state({ active: "id-b" }), now)).toBe(c);
    expect(nextAccount(saved, state({ active: "id-c" }), now)).toBe(a);
  });

  test("one that is out is skipped until its time has passed", () => {
    expect(nextAccount(saved, state({ active: "id-a", out: { "id-b": out(now + 1) } }), now)).toBe(c);
    expect(nextAccount(saved, state({ active: "id-a", out: { "id-b": out(now - 1) } }), now)).toBe(b);
  });

  test("one whose login has expired is skipped", () => {
    expect(nextAccount([a, { ...b, expires: now - 1 }, c], state({ active: "id-a" }), now)).toBe(c);
  });

  test("none: only the active one, or every other one out", () => {
    expect(nextAccount([a], state({ active: "id-a" }), now)).toBeUndefined();
    expect(nextAccount(saved, state({ active: "id-a", out: { "id-b": out(now + 1), "id-c": out(now + 1) } }), now)).toBeUndefined();
  });

  test("no active account: the first one that isn't out", () => {
    expect(nextAccount(saved, state(), now)).toBe(a);
    expect(nextAccount(saved, state({ out: { "id-a": out(now + 1) } }), now)).toBe(b);
  });
});

describe("filing", () => {
  const rec = (id: string, fetchedAt?: number): Rec => ({ id, email: `${id}@x.com`, ...(fetchedAt !== undefined && { fetchedAt }), account: { accountUuid: id } });
  const settled = (o: Partial<State> = {}) => state({ active: "id-b", filed: { mtime: 1, at: 1000 }, ...o });

  test("no login notice since the last settle: a renewal for the active account, whatever the record says or when it was fetched", () => {
    expect(filing(settled(), rec("id-a", 5000), undefined)).toEqual({ id: "id-b", login: false });
    expect(filing(settled(), rec("id-a", 5000), 900)).toEqual({ id: "id-b", login: false });
    expect(filing(settled(), rec("id-a", 5000), 1000)).toEqual({ id: "id-b", login: false });
    expect(filing(settled(), undefined, undefined)).toEqual({ id: "id-b", login: false });
  });

  test("a login notice since the last settle and a record fetched after it: a login for the account the record names", () => {
    expect(filing(settled(), rec("id-a", 1001), 1500)).toEqual({ id: "id-a", login: true });
    expect(filing(settled(), rec("id-b", 2000), 1500)).toEqual({ id: "id-b", login: true });
  });

  test("a login notice but a record not fetched since the settle, or none: wait", () => {
    expect(filing(settled(), rec("id-a", 1000), 1500)).toBe("wait");
    expect(filing(settled(), rec("id-a"), 1500)).toBe("wait");
    expect(filing(settled(), undefined, 1500)).toBe("wait");
  });

  test("never settled and no active account: the record's account as a login; no record: unknown", () => {
    expect(filing(state(), rec("id-c"), undefined)).toEqual({ id: "id-c", login: true });
    expect(filing(state(), undefined, undefined)).toBeUndefined();
  });

  test("a state from before `at` (settled at 0): a notice counts, and any stamped record is fresh", () => {
    expect(filing(state({ active: "id-b", filed: { mtime: 1, at: 0 } }), rec("id-a", 5), 10)).toEqual({ id: "id-a", login: true });
  });

  test("owner unknown: only a login notice with a fresh record files; a renewal or a record alone is held", () => {
    const unknown = (o: Partial<State> = {}) => state({ unknown: true, filed: { mtime: 1, at: 1000 }, ...o });
    expect(filing(unknown(), rec("id-c", 2000), 1500)).toEqual({ id: "id-c", login: true });
    expect(filing(unknown(), rec("id-c"), 1500)).toBe("wait");
    expect(filing(unknown(), rec("id-c", 2000), 900)).toBe("held");
    expect(filing(unknown(), rec("id-c", 2000), undefined)).toBe("held");
    expect(filing(unknown(), undefined, undefined)).toBe("held");
    expect(filing(unknown({ active: "id-b" }), rec("id-c"), undefined)).toBe("held");
  });
});

describe("isOut", () => {
  test("out only while its time hasn't passed", () => {
    expect(isOut(state(), "id-a", now)).toBe(false);
    expect(isOut(state({ out: { "id-a": out(now + 1) } }), "id-a", now)).toBe(true);
    expect(isOut(state({ out: { "id-a": out(now - 1) } }), "id-a", now)).toBe(false);
  });
});

describe("resetAt", () => {
  // The two real messages' times: Nov 20 2026 at 17:58 and 20:14 in Berlin (UTC+1 in November).
  const fable = Date.UTC(2026, 10, 20, 16, 58);
  const weekly = Date.UTC(2026, 10, 20, 19, 14);
  const utc = (mo: number, d: number, h: number, min = 0, y = 2026) => Date.UTC(y, mo - 1, d, h, min);

  test.each([
    ["You've hit your Fable limit · resets Nov 25, 1pm (Europe/Berlin)", fable, "UTC", utc(11, 25, 12)],
    ["You've hit your weekly limit · resets 2pm (Europe/Berlin)", weekly, "UTC", utc(11, 21, 13)],
    ["resets 9pm (Europe/Berlin)", fable, "UTC", utc(11, 20, 20)], // later today
    ["resets 2:30pm (Europe/Berlin)", weekly, "UTC", utc(11, 21, 13, 30)],
    ["resets 12am (Europe/Berlin)", weekly, "UTC", utc(11, 20, 23)], // midnight
    ["resets 12pm (Europe/Berlin)", weekly, "UTC", utc(11, 21, 11)], // noon
    ["Resets 11 AM (Europe/Berlin)", weekly, "UTC", utc(11, 21, 10)],
    ["resets November 25 1pm (Europe/Berlin)", fable, "UTC", utc(11, 25, 12)],
    ["resets 5pm", weekly, "America/New_York", utc(11, 20, 22)], // 14:14 there now
    ["resets 9am", weekly, "Asia/Kolkata", utc(11, 21, 3, 30)], // 00:44 there now
    ["resets 2:30pm", weekly, "Asia/Kolkata", utc(11, 21, 9)],
    ["resets 2pm (Europe/Berlin)", weekly, "Asia/Kolkata", utc(11, 21, 13)], // the bracketed zone wins
    ["resets Jan 2, 9am (Europe/Berlin)", utc(12, 30, 12), "UTC", utc(1, 2, 8, 0, 2027)], // into next year
  ])("%p at %p in %p", (message, at, zone, want) => {
    expect(resetAt(message, at, zone)).toBe(want);
  });

  test.each([
    ["resets 2pm (Mars/Olympus)", "UTC"], // unknown zone in brackets
    ["resets 2pm", "Nowhere/Nope"], // unknown zone given
    ["resets Dec 1, 1pm (Europe/Berlin)", "UTC"], // more than 8 days ahead
    ["resets Nov 19, 1pm (Europe/Berlin)", "UTC"], // past, so next year: too far
    ["API Error: Rate limit reached", "UTC"],
    ["You've hit your limit", "UTC"],
    ["", "UTC"],
    [undefined, "UTC"],
    ["resets soon", "UTC"],
    ["resets 25pm", "UTC"],
    ["resets 13:00", "UTC"],
    ["resets 2:75pm", "UTC"],
    ["resets Foo 25, 1pm (Europe/Berlin)", "UTC"],
    ["resets Nov 32, 1pm (Europe/Berlin)", "UTC"],
    ["resets 2pm (", "UTC"], // a bracket cut short
    ["resets 2pm (Europe/Ber", "UTC"],
    ["resets 2pm (  )", "UTC"],
    ["resets Nov 31, 1pm (Europe/Berlin)", "UTC"], // would roll into Dec 1, six days after `fable`
  ])("unreadable: %p in %p", (message, zone) => {
    expect(resetAt(message, weekly, zone)).toBeUndefined();
  });

  test("a day the month doesn't have is not read as the next month's", () => {
    expect(resetAt("resets Nov 31, 1pm (Europe/Berlin)", Date.UTC(2026, 10, 28, 12), "UTC")).toBeUndefined();
    expect(resetAt("resets Feb 30, 1pm (Europe/Berlin)", Date.UTC(2027, 1, 25, 12), "UTC")).toBeUndefined();
    expect(resetAt("resets Feb 29, 1pm (Europe/Berlin)", Date.UTC(2027, 1, 25, 12), "UTC")).toBeUndefined(); // 2027 has none
    expect(resetAt("resets Feb 29, 1pm (Europe/Berlin)", Date.UTC(2028, 1, 25, 12), "UTC")).toBe(Date.UTC(2028, 1, 29, 12));
  });

  test("the day Berlin's clocks go forward: a normal time is right, a skipped one is within an hour and doesn't throw", () => {
    const before = Date.UTC(2027, 2, 27, 12); // Mar 28 2027, 02:00 CET becomes 03:00 CEST
    expect(resetAt("resets Mar 28, 1pm (Europe/Berlin)", before, "UTC")).toBe(Date.UTC(2027, 2, 28, 11));
    expect(resetAt("resets Mar 28, 1:30am (Europe/Berlin)", before, "UTC")).toBe(Date.UTC(2027, 2, 28, 0, 30));
    const skipped = resetAt("resets Mar 28, 2:30am (Europe/Berlin)", before, "UTC");
    expect(typeof skipped).toBe("number");
    expect(Math.abs(skipped! - Date.UTC(2027, 2, 28, 1, 30))).toBeLessThanOrEqual(3600_000);
    const twice = resetAt("resets Oct 31, 2:30am (Europe/Berlin)", Date.UTC(2027, 9, 30, 12), "UTC"); // comes twice
    expect(Math.abs(twice! - Date.UTC(2027, 9, 31, 0, 30))).toBeLessThanOrEqual(3600_000);
  });
});
