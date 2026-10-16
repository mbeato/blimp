// Markdown to HTML, in a worker. The files pane shows any repo's Markdown, and marked can be made
// to take minutes (it's quadratic on long runs of emphasis like "_a _a _a …") or to recurse until
// the stack runs out (thousands of nested ">"). On the UI thread that freezes every terminal, or
// throws during render and blanks the window. In a worker, a parse that fails or runs past the
// limit only rejects, and the worker is thrown away.

export const MAX_CHARS = 1_000_000; // the HTML is sanitized on the UI thread, so bound it too
export const TIME_LIMIT_MS = 5000;

export function parseMarkdown(text: string, signal?: AbortSignal, limit = TIME_LIMIT_MS): Promise<string> {
  if (text.length > MAX_CHARS) return Promise.reject(new Error("it's too big to render"));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./markdown.worker.ts", import.meta.url), { type: "module" });
    const finish = (fn: () => void) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      worker.terminate();
      fn();
    };
    const abort = () => finish(() => reject(new DOMException("Aborted", "AbortError")));
    const timer = setTimeout(() => finish(() => reject(new Error("it took too long to render"))), limit);
    worker.onmessage = (e: MessageEvent<{ html?: string; error?: string }>) =>
      finish(() => (e.data.error === undefined ? resolve(e.data.html!) : reject(new Error(e.data.error))));
    worker.onerror = (e) => finish(() => reject(new Error(e.message || "the renderer failed")));
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort);
    worker.postMessage(text);
  });
}
