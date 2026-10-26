// blimp's kit for visuals (src/visuals/kit.ts): the files blimpd serves, the libraries exactly as vendored.

import { expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import { KIT, KIT_SUMS, kitFile } from "../src/visuals/kit";

const sha256 = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");

test("the kit is blimp's stylesheet and script, Chart.js and Mermaid", () => {
  expect(Object.keys(KIT).sort()).toEqual(["blimp.css", "blimp.js", "chart.js", "mermaid.js"]);
  expect(KIT["blimp.css"].type).toBe("text/css; charset=utf-8");
  for (const n of ["blimp.js", "chart.js", "mermaid.js"]) expect(KIT[n].type).toBe("text/javascript; charset=utf-8");
});

test("Chart.js 4.5.1 and Mermaid 12.1.0, byte for byte as vendored", async () => {
  expect(KIT_SUMS).toEqual({
    "chart.js": "48444a82d4edcb5bec0f1965faacdde18d9c17db3063d042abada2f705c9f54a",
    "mermaid.js": "6484afc32872a3aa16cac9a76ba1816a1ed4cc870a6593cc2e17757750f518b2",
  });
  for (const [name, sum] of Object.entries(KIT_SUMS)) expect(sha256((await kitFile(name))!.bytes)).toBe(sum);
});

test("each file also gzipped, made once", async () => {
  const a = (await kitFile("mermaid.js"))!;
  expect(gunzipSync(a.gzipped).equals(Buffer.from(a.bytes))).toBe(true);
  expect(a.gzipped.length).toBeLessThan(a.bytes.length / 2);
  expect((await kitFile("mermaid.js"))!.gzipped).toBe(a.gzipped);
});

test("nothing else, and nothing outside the kit", async () => {
  for (const n of ["", "x.js", "../store.ts", "kit/chart.js", "constructor", "__proto__", "hasOwnProperty"]) expect(await kitFile(n)).toBeUndefined();
});

test("the stylesheet has blimp's colours for both schemes, and every series colour", async () => {
  const text = new TextDecoder().decode((await kitFile("blimp.css"))!.bytes);
  expect(text).toContain("@media (prefers-color-scheme: dark)");
  for (const v of ["--bg", "--fg", "--fg-dim", "--line", "--c1", "--c6", "--font"]) expect(text).toContain(`${v}:`);
});
