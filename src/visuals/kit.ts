// blimp's kit for visuals (src/visuals/kit/), built into blimpd's binary (bun's file imports): its stylesheet and
// script, Chart.js and Mermaid (LICENSES.md). A page loads them by relative paths, kit/<file>, which carry the visual
// key (visuals/http.ts). Each is gzipped once, the first time it's asked for: Mermaid is 5.5 MB, 1.6 MB gzipped.

import blimpCss from "./kit/blimp.css" with { type: "file" };
import blimpJs from "./kit/blimp.js" with { type: "file" };
import chartJs from "./kit/chart.js" with { type: "file" };
import mermaidJs from "./kit/mermaid.js" with { type: "file" };

const JS = "text/javascript; charset=utf-8";
export const KIT: Record<string, { file: string; type: string }> = {
  "blimp.css": { file: blimpCss, type: "text/css; charset=utf-8" },
  "blimp.js": { file: blimpJs, type: JS },
  "chart.js": { file: chartJs, type: JS },
  "mermaid.js": { file: mermaidJs, type: JS },
};

// The libraries as vendored (test/visuals-kit.test.ts): Chart.js 4.5.1 and Mermaid 12.1.0.
export const KIT_SUMS = {
  "chart.js": "48444a82d4edcb5bec0f1965faacdde18d9c17db3063d042abada2f705c9f54a",
  "mermaid.js": "6484afc32872a3aa16cac9a76ba1816a1ed4cc870a6593cc2e17757750f518b2",
};

const read = new Map<string, Promise<{ bytes: Uint8Array; gzipped: Uint8Array; type: string }>>();

export function kitFile(name: string) {
  if (!Object.hasOwn(KIT, name)) return Promise.resolve(undefined);
  let f = read.get(name);
  if (!f) {
    const { file, type } = KIT[name];
    read.set(name, (f = Bun.file(file).bytes().then((bytes) => ({ bytes, gzipped: Bun.gzipSync(bytes), type }))));
  }
  return f;
}
