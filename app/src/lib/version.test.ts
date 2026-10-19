import { expect, test } from "bun:test";
import { compareVersions } from "./version";

test("versions compare by number, and a release candidate comes before its release", () => {
  expect(compareVersions("0.2.0", "0.2.1")).toBe(-1);
  expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
  expect(compareVersions("v0.2.0", "0.2.0")).toBe(0);
  expect(compareVersions("0.2.0-rc.6", "0.2.0")).toBe(-1);
  expect(compareVersions("0.2.0-rc.10", "0.2.0-rc.9")).toBe(1);
  expect(compareVersions("junk", "0.0.1")).toBe(-1);
});
