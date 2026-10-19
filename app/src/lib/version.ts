// The app's version, and comparing it with blimpd's (the two are released together).

import pkg from "../../package.json";

export const appVersion: string = pkg.version;

// -1, 0 or 1, for versions like 0.2.0 or 0.2.0-rc.3 (a release candidate comes before its
// release). Anything unreadable counts as 0.0.0.
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const m = v.trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/);
    if (!m) return [0, 0, 0, Infinity];
    return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? Infinity : Number(m[4])];
  };
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}
