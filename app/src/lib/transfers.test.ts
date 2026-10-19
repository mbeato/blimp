import { expect, test } from "bun:test";
import { freeName, plainName } from "./transfers";

test("freeName adds a number before the extension until the name is free", () => {
  const taken = new Set(["a.txt", "a 2.txt", "p.tar.gz", "README"]);
  expect(freeName("b.txt", taken)).toBe("b.txt");
  expect(freeName("a.txt", taken)).toBe("a 3.txt");
  expect(freeName("p.tar.gz", taken)).toBe("p 2.tar.gz");
  expect(freeName("README", taken)).toBe("README 2");
});

test("plainName makes a terminal-safe word out of a Mac screenshot's name", () => {
  expect(plainName("Screenshot 2026-10-19 at 4.12.33 PM.png")).toBe("Screenshot-2026-10-19-at-4.12.33-PM.png");
  expect(plainName("'; rm -rf ~.txt")).toBe("rm--rf-.txt");
  expect(plainName("...")).toBe("file");
});
