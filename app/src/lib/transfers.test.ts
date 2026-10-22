import { expect, test } from "bun:test";
import { dropPoint, freeName, pastedImages, plainName } from "./transfers";

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

test("dropPoint: a Mac's drag position is already in the page's pixels; elsewhere it is divided by the scale", () => {
  // A Retina Mac, pointer near the bottom right of an 800 x 600 page with no title bar inset:
  // there, not at half the way.
  const flat = { frameH: 600, viewH: 600 };
  expect(dropPoint({ x: 790, y: 590 }, { mac: true, dpr: 2, ...flat })).toEqual({ x: 790, y: 590 });
  expect(dropPoint({ x: 790, y: 590 }, { mac: true, dpr: 1, ...flat })).toEqual({ x: 790, y: 590 });
  expect(dropPoint({ x: 1580, y: 1180 }, { mac: false, dpr: 2, ...flat })).toEqual({ x: 790, y: 590 });
  expect(dropPoint({ x: 300, y: 150 }, { mac: false, dpr: 1.5, ...flat })).toEqual({ x: 200, y: 100 });
});

test("dropPoint: on a Mac, y is measured from the bottom, since the web view's frame starts under the title bar", () => {
  // A 900 pt frame, the top 28 pt under the title bar: the page is 872 high, and a pointer 500 pt
  // below the frame's top is 472 below the page's.
  const o = { mac: true, dpr: 2, frameH: 900, viewH: 872 };
  expect(dropPoint({ x: 300, y: 500 }, o)).toEqual({ x: 300, y: 472 });
  // The page's top and bottom rows, and the same 28 pt anywhere between.
  expect(dropPoint({ x: 10, y: 29 }, o)).toEqual({ x: 10, y: 1 });
  expect(dropPoint({ x: 10, y: 899 }, o)).toEqual({ x: 10, y: 871 });
  // Windows and Linux: no change, from the top.
  expect(dropPoint({ x: 600, y: 1000 }, { ...o, mac: false })).toEqual({ x: 300, y: 500 });
});

test("dropPoint: a measured gap that can't be a title bar's (a size read mid-move between screens) is ignored", () => {
  expect(dropPoint({ x: 10, y: 500 }, { mac: true, dpr: 2, frameH: 1800, viewH: 872 })).toEqual({ x: 10, y: 500 });
  expect(dropPoint({ x: 10, y: 500 }, { mac: true, dpr: 1, frameH: 436, viewH: 872 })).toEqual({ x: 10, y: 500 });
  expect(dropPoint({ x: 10, y: 500 }, { mac: true, dpr: 2, frameH: 900, viewH: 872 })).toEqual({ x: 10, y: 472 });
});
