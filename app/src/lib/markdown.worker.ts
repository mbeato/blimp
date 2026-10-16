// marked, off the UI thread. See markdown.ts.

import { marked } from "marked";

self.onmessage = (e: MessageEvent<string>) => {
  try {
    self.postMessage({ html: marked.parse(e.data, { async: false }) });
  } catch (err) {
    // marked appends a line asking to report the error upstream; the first line is the reason.
    self.postMessage({ error: String(err instanceof Error ? err.message : err).split("\n")[0] });
  }
};
