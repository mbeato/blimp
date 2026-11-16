// Which account comes next and whose login a changed live file is (src/accounts/rules.ts). Pure: no files.

import { describe, expect, test } from "bun:test";
import { filing, isOut, nextAccount } from "../src/accounts/rules";
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
});

describe("isOut", () => {
  test("out only while its time hasn't passed", () => {
    expect(isOut(state(), "id-a", now)).toBe(false);
    expect(isOut(state({ out: { "id-a": out(now + 1) } }), "id-a", now)).toBe(true);
    expect(isOut(state({ out: { "id-a": out(now - 1) } }), "id-a", now)).toBe(false);
  });
});
