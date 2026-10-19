// A native browser view (lib/browser.ts) is drawn above all of the page, so it hides while
// anything of the page's is open that could be over it: a dialog, a menu, a drag.

import { useEffect, useSyncExternalStore } from "react";

let open = 0;
const subs = new Set<() => void>();
const changed = () => subs.forEach((f) => f());

// Counts as open while `on` (and mounted).
export function useOverlay(on = true) {
  useEffect(() => {
    if (!on) return;
    open++;
    changed();
    return () => {
      open--;
      changed();
    };
  }, [on]);
}

// Whether any is open.
export function useOverlayOpen(): boolean {
  return useSyncExternalStore(
    (f) => (subs.add(f), () => void subs.delete(f)),
    () => open > 0,
  );
}
