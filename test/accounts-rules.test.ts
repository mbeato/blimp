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
  const rec = (id: string): Rec => {
    const account = { accountUuid: id, emailAddress: `${id}@x.com` };
    return { id, email: account.emailAddress, raw: JSON.stringify(account), account };
  };

  test("nothing filed yet and a record: a login for that account", () => {
    expect(filing(state(), rec("id-a"))).toEqual({ id: "id-a", login: true });
  });

  test("the record unchanged since the last filing: a renewal for the active account, even when the record names another", () => {
    const r = rec("id-a");
    expect(filing(state({ active: "id-b", filed: { mtime: 1, record: r.raw } }), r)).toEqual({ id: "id-b", login: false });
  });

  test("the record changed since the last filing: a login for the account it names", () => {
    const r = rec("id-c");
    expect(filing(state({ active: "id-b", filed: { mtime: 1, record: rec("id-a").raw } }), r)).toEqual({ id: "id-c", login: true });
  });

  test("no record: the active account's renewal, or unknown with none active", () => {
    expect(filing(state({ active: "id-b" }), undefined)).toEqual({ id: "id-b", login: false });
    expect(filing(state(), undefined)).toBeUndefined();
  });

  test("the record unchanged and none active: unknown", () => {
    const r = rec("id-a");
    expect(filing(state({ filed: { mtime: 1, record: r.raw } }), r)).toBeUndefined();
  });
});

describe("isOut", () => {
  test("out only while its time hasn't passed", () => {
    expect(isOut(state(), "id-a", now)).toBe(false);
    expect(isOut(state({ out: { "id-a": out(now + 1) } }), "id-a", now)).toBe(true);
    expect(isOut(state({ out: { "id-a": out(now - 1) } }), "id-a", now)).toBe(false);
  });
});
