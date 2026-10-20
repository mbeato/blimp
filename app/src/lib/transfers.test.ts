import { expect, test } from "bun:test";
import { freeName, pastedImages, plainName } from "./transfers";

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

test("pastedImages names a pasted screenshot like the Mac does, and leaves text pastes alone", () => {
  const at = new Date(2026, 9, 20, 9, 5, 3);
  const png = new File(["p"], "image.png", { type: "image/png" });
  const jpg = new File(["j"], "", { type: "image/jpeg" });
  const txt = new File(["t"], "notes.txt", { type: "text/plain" });
  expect(pastedImages([png], false, at).map((i) => i.name)).toEqual(["Screenshot-2026-10-20-at-09.05.03.png"]);
  expect(pastedImages([png], false, at)[0].file).toBe(png);
  expect(pastedImages([png, txt, jpg], false, at).map((i) => i.name)).toEqual(["Screenshot-2026-10-20-at-09.05.03-1.png", "Screenshot-2026-10-20-at-09.05.03-2.jpg"]);
  // Already a terminal-safe word, so the upload keeps it
  expect(plainName(pastedImages([png], false, at)[0].name)).toBe("Screenshot-2026-10-20-at-09.05.03.png");
  expect(pastedImages([txt], false, at)).toEqual([]);
  expect(pastedImages([png], true, at)).toEqual([]);
});
