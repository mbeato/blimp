# The kit's libraries

Served to visuals by blimpd (src/visuals/kit.ts), unchanged from their npm packages. Both are MIT, like blimp.

- `chart.js`: Chart.js 4.5.1, `dist/chart.umd.min.js`. Copyright (c) 2014-2024 Chart.js Contributors. MIT.
  https://github.com/chartjs/Chart.js/blob/v4.5.1/LICENSE.md
- `mermaid.js`: Mermaid 12.1.0, `dist/mermaid.min.js`. Copyright (c) 2014 - 2022 Knut Sveidqvist. MIT.
  https://github.com/mermaid-js/mermaid/blob/mermaid%4012.1.0/LICENSE

To update one: `npm pack <name>@<version>` in an empty folder, copy the same built file over, and change its
version here, in the spec and its SHA-256 in kit.ts (test/visuals-kit.test.ts checks it).
