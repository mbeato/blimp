import { expect, test } from "bun:test";
import { relTime } from "./time";

const now = 1_700_000_000_000;

test("relative times", () => {
  expect(relTime(now, now)).toBe("just now");
  expect(relTime(now - 59_000, now)).toBe("just now");
  expect(relTime(now - 60_000, now)).toBe("1m ago");
  expect(relTime(now - 2 * 60_000 - 5_000, now)).toBe("2m ago");
  expect(relTime(now - 59 * 60_000, now)).toBe("59m ago");
  expect(relTime(now - 3 * 3600_000, now)).toBe("3h ago");
  expect(relTime(now - 49 * 3600_000, now)).toBe("2d ago");
});

test("clock skew into the future reads as just now", () => {
  expect(relTime(now + 10_000, now)).toBe("just now");
});
