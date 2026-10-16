// pdf.js with its worker bundled locally, loaded on first use.

import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;

// Draws every page into its own canvas, as wide as `width` CSS pixels, appended to `into`.
// Returns a function that stops the work and frees the document.
export function renderPdf(bytes: Uint8Array, into: HTMLElement, width: number, onError: (e: unknown) => void) {
  // pdf.js moves the buffer to its worker, so hand it a copy and keep ours intact.
  const task = getDocument({ data: bytes.slice() });
  let stopped = false;
  (async () => {
    const doc = await task.promise;
    for (let n = 1; n <= doc.numPages && !stopped; n++) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const scale = (width / base.width) * devicePixelRatio;
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.className = "pdf-page";
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      into.append(canvas);
      await page.render({ canvas, viewport }).promise;
    }
  })().catch((e) => !stopped && onError(e));
  return () => {
    stopped = true;
    void task.destroy();
  };
}
