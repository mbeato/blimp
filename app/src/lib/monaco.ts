// Monaco, bundled locally and loaded on first use (see loadMonaco in FilesPane).
// Only the editor and syntax highlighting: the language services (TypeScript, JSON, CSS, HTML)
// would type-check a remote file without its project and mark every import as an error, and the
// TypeScript worker alone is several MB.

import * as monaco from "monaco-editor/editor/editor.api";
import { isLight, onSettings } from "./settings";
import "monaco-editor/features/register.all";
import "monaco-editor/languages/definitions/register.all";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";

// Vite bundles the worker; without this Monaco would look for it next to its own files.
globalThis.MonacoEnvironment = { getWorker: () => new EditorWorker() };


// Monaco needs real colors, so take the editor background from theme.css like the terminal does.
// It only accepts #rrggbb, and the CSS minifier shortens colors, so let a canvas spell them out.
const ctx = document.createElement("canvas").getContext("2d")!;
function applyTheme() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => {
    ctx.fillStyle = css.getPropertyValue(name).trim();
    return ctx.fillStyle;
  };
  const light = isLight();
  monaco.editor.defineTheme("blimp", {
    base: light ? "vs" : "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": v("--bg"),
      "editorGutter.background": v("--bg"),
      "minimap.background": v("--bg"),
    },
  });
  monaco.editor.setTheme("blimp");
}
applyTheme();
// The Theme setting, or the system going light/dark (after theme.css has switched its colors).
onSettings(() => requestAnimationFrame(applyTheme));

export { monaco };
