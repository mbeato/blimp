// blimp's kit for visuals (src/visuals/kit/), built into blimpd's binary (bun's file imports): its stylesheet and
// script, Chart.js, Mermaid and three.js with a few of its addons (LICENSES.md). A page loads them by relative paths,
// kit/<file>, which carry the visual key (visuals/http.ts). Each is gzipped once, the first time it's asked for:
// Mermaid is 5.5 MB, 1.6 MB gzipped. three.js comes as the ES modules it ships as: a page maps "three" to
// kit/three/three.module.js and "three/addons/" to kit/three/addons/, as three.js's own examples do.

import blimpCss from "./kit/blimp.css" with { type: "file" };
import blimpJs from "./kit/blimp.js" with { type: "file" };
import chartJs from "./kit/chart.js" with { type: "file" };
import mermaidJs from "./kit/mermaid.js" with { type: "file" };
import orbitControls from "./kit/three/addons/controls/OrbitControls.js" with { type: "file" };
import roomEnvironment from "./kit/three/addons/environments/RoomEnvironment.js" with { type: "file" };
import roundedBox from "./kit/three/addons/geometries/RoundedBoxGeometry.js" with { type: "file" };
import gltfLoader from "./kit/three/addons/loaders/GLTFLoader.js" with { type: "file" };
import geometryUtils from "./kit/three/addons/utils/BufferGeometryUtils.js" with { type: "file" };
import skeletonUtils from "./kit/three/addons/utils/SkeletonUtils.js" with { type: "file" };
import threeCore from "./kit/three/three.core.js" with { type: "file" };
import threeModule from "./kit/three/three.module.js" with { type: "file" };

const JS = "text/javascript; charset=utf-8";
export const KIT: Record<string, { file: string; type: string }> = {
  "blimp.css": { file: blimpCss, type: "text/css; charset=utf-8" },
  "blimp.js": { file: blimpJs, type: JS },
  "chart.js": { file: chartJs, type: JS },
  "mermaid.js": { file: mermaidJs, type: JS },
  "three/three.module.js": { file: threeModule, type: JS },
  "three/three.core.js": { file: threeCore, type: JS },
  "three/addons/controls/OrbitControls.js": { file: orbitControls, type: JS },
  "three/addons/loaders/GLTFLoader.js": { file: gltfLoader, type: JS },
  "three/addons/utils/BufferGeometryUtils.js": { file: geometryUtils, type: JS },
  "three/addons/utils/SkeletonUtils.js": { file: skeletonUtils, type: JS },
  "three/addons/environments/RoomEnvironment.js": { file: roomEnvironment, type: JS },
  "three/addons/geometries/RoundedBoxGeometry.js": { file: roundedBox, type: JS },
};

// The libraries as vendored (test/visuals-kit.test.ts): Chart.js 4.5.1, Mermaid 12.1.0 and three.js 0.187.0.
export const KIT_SUMS = {
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
