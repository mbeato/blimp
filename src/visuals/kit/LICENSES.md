# The kit's libraries

Served to visuals by blimpd (src/visuals/kit.ts), unchanged from their npm packages. All are MIT, like blimp.

- `chart.js`: Chart.js 4.5.1, `dist/chart.umd.min.js`. Copyright (c) 2014-2024 Chart.js Contributors. MIT.
  https://github.com/chartjs/Chart.js/blob/v4.5.1/LICENSE.md
- `mermaid.js`: Mermaid 12.1.0, `dist/mermaid.min.js`. Copyright (c) 2014 - 2022 Knut Sveidqvist. MIT.
  https://github.com/mermaid-js/mermaid/blob/mermaid%4012.1.0/LICENSE
- `three/`: three.js 0.187.0 (r187). `build/three.module.js` and `build/three.core.js`, and under `three/addons/`,
  from `examples/jsm/`: `controls/OrbitControls.js`, `loaders/GLTFLoader.js`, `utils/BufferGeometryUtils.js`,
  `utils/SkeletonUtils.js`, `environments/RoomEnvironment.js`, `geometries/RoundedBoxGeometry.js`.
  Copyright © 2010-2026 three.js authors. MIT. https://github.com/mrdoob/three.js/blob/r187/LICENSE

To update one: `npm pack <name>@<version>` in an empty folder, copy the same built file over, and change its
version here, in the spec and its SHA-256 in kit.ts (test/visuals-kit.test.ts checks it).
