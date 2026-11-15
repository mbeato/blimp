// blimp's kit for visuals (src/visuals/kit.ts): the files blimpd serves, the libraries exactly as vendored.

import { expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import { KIT, KIT_SUMS, kitFile } from "../src/visuals/kit";

const sha256 = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");

const THREE = [
  "three/three.module.js",
  "three/three.core.js",
  "three/addons/controls/OrbitControls.js",
  "three/addons/loaders/GLTFLoader.js",
  "three/addons/utils/BufferGeometryUtils.js",
  "three/addons/utils/SkeletonUtils.js",
  "three/addons/environments/RoomEnvironment.js",
  "three/addons/geometries/RoundedBoxGeometry.js",
];

test("the kit is blimp's stylesheet and script, Chart.js, Mermaid, and three.js with its addons", () => {
  expect(Object.keys(KIT).sort()).toEqual(["blimp.css", "blimp.js", "chart.js", "mermaid.js", ...THREE].sort());
  expect(KIT["blimp.css"].type).toBe("text/css; charset=utf-8");
  for (const n of ["blimp.js", "chart.js", "mermaid.js", ...THREE]) expect(KIT[n].type).toBe("text/javascript; charset=utf-8");
});

test("Chart.js 4.5.1, Mermaid 12.1.0 and three.js 0.187.0, byte for byte as vendored", async () => {
  expect(KIT_SUMS).toEqual({
    "chart.js": "48444a82d4edcb5bec0f1965faacdde18d9c17db3063d042abada2f705c9f54a",
    "mermaid.js": "6484afc32872a3aa16cac9a76ba1816a1ed4cc870a6593cc2e17757750f518b2",
    "three/three.module.js": "104f56145899722094556490d787aae0617cc2fc3382f31df02d724ea1aee341",
    "three/three.core.js": "613e370f76638fdef83926642bf256dc9615684922de1ce1f63a8583e5d78578",
    "three/addons/controls/OrbitControls.js": "e7fca2fe9e7670a828af9b28084669a5909445b7f36f1f26cee9bf8f2961c32c",
    "three/addons/loaders/GLTFLoader.js": "532ac726e120039acbcd6cf54328c57acbf7b438176afaa6951257126d11bff1",
    "three/addons/utils/BufferGeometryUtils.js": "7bda2a8ba836b2bcf67cb938d4b9e1bb5d1b1bc616817103ed858c0b58296ce7",
    "three/addons/utils/SkeletonUtils.js": "b1632a703206c3d830de9fcbe515696770d04b71a15ee6b50afa6d2c3298c86f",
    "three/addons/environments/RoomEnvironment.js": "55f466192cc84298755a424c5e040345006b2ee1455589b3b54126c2ea4123f4",
    "three/addons/geometries/RoundedBoxGeometry.js": "c5feab96123858ed8823c889b238dc8734adab7e760e3cfd21e7f3f2f3e348e3",
  });
  for (const [name, sum] of Object.entries(KIT_SUMS)) expect(sha256((await kitFile(name))!.bytes)).toBe(sum);
});

test("three.js is r187, and each addon's imports are in the kit", async () => {
  const text = async (n: string) => new TextDecoder().decode((await kitFile(n))!.bytes);
  expect(await text("three/three.core.js")).toContain("const REVISION = '187'");
  const imported = new Set<string>();
  for (const n of THREE) {
    const dir = n.slice(0, n.lastIndexOf("/") + 1);
    for (const [, from] of (await text(n)).matchAll(/^(?:import|export)\b[^;]*?\bfrom\s+'([^']+)';/gms)) {
      if (from === "three") continue;
      const path = new URL(from, `http://kit/${dir}`).pathname.slice(1);
      expect(Object.keys(KIT)).toContain(path);
      imported.add(path);
    }
  }
  expect([...imported].sort()).toEqual(["three/addons/utils/BufferGeometryUtils.js", "three/addons/utils/SkeletonUtils.js", "three/three.core.js"]);
});

test("each file also gzipped, made once", async () => {
  const a = (await kitFile("mermaid.js"))!;
  expect(gunzipSync(a.gzipped).equals(Buffer.from(a.bytes))).toBe(true);
  expect(a.gzipped.length).toBeLessThan(a.bytes.length / 2);
  expect((await kitFile("mermaid.js"))!.gzipped).toBe(a.gzipped);
});

test("nothing else, and nothing outside the kit", async () => {
  for (const n of ["", "x.js", "../store.ts", "kit/chart.js", "three", "three/", "three/three.cjs", "three/addons/../three.core.js", "constructor", "__proto__", "hasOwnProperty"]) expect(await kitFile(n)).toBeUndefined();
});

test("the stylesheet has blimp's colours for both schemes, and every series colour", async () => {
  const text = new TextDecoder().decode((await kitFile("blimp.css"))!.bytes);
  expect(text).toContain("@media (prefers-color-scheme: dark)");
  for (const v of ["--bg", "--fg", "--fg-dim", "--line", "--c1", "--c6", "--font"]) expect(text).toContain(`${v}:`);
});
