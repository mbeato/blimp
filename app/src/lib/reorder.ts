// Dragging a tab along its strip to move it: the project tabs at the top and the browser tabs.
// Pointer events, as the session list does: the Mac app takes HTML drag and drop for files from Finder.

// Where the dragged tab goes among the others: before the first whose middle is right of the pointer.
export const dropIndex = (mids: number[], x: number) => mids.filter((m) => m < x).length;

export function moved<T>(list: T[], from: number, to: number): T[] {
  const rest = list.filter((_, i) => i !== from);
  rest.splice(to, 0, list[from]);
  return rest;
}

// items in a dragged order (keys); the ones it doesn't have, after, as they came (a new tab at the end).
export function byOrder<T>(items: T[], key: (x: T) => string, order: string[] | undefined): T[] {
  if (!order?.length) return items;
  const rank = new Map(order.map((k, i) => [k, i]));
  const known = items.filter((x) => rank.has(key(x))).sort((a, b) => rank.get(key(a))! - rank.get(key(b))!);
  return [...known, ...items.filter((x) => !rank.has(key(x)))];
}

// From a pointerdown on a tab: past a few pixels it's a drag, and the tab follows the pointer. Let go,
// and onMove gets where it was and where it goes among tabs() (the strip's draggable tabs, left to
// right). A press that doesn't move stays a click. No pointer capture: it would take the click from
// the tab's × button.
export function startReorder(e: { button: number; clientX: number; pointerId: number; currentTarget: HTMLElement }, tabs: () => HTMLElement[], onMove: (from: number, to: number) => void) {
  if (e.button !== 0) return;
  const el = e.currentTarget;
  const x0 = e.clientX;
  const id = e.pointerId;
  let dragging = false;
  const move = (ev: PointerEvent) => {
    if (ev.pointerId !== id) return;
    const dx = ev.clientX - x0;
    if (!dragging && Math.abs(dx) < 5) return;
    if (!dragging) (dragging = true), el.classList.add("tab-dragging");
    el.style.transform = `translateX(${dx}px)`;
  };
  const up = (ev: PointerEvent) => {
    if (ev.pointerId !== id) return;
    removeEventListener("pointermove", move);
    removeEventListener("pointerup", up);
    removeEventListener("pointercancel", up);
    if (!dragging) return;
    el.style.transform = "";
    el.classList.remove("tab-dragging");
    const list = tabs();
    const from = list.indexOf(el);
    if (ev.type === "pointercancel" || from < 0) return;
    const mids = list.filter((t) => t !== el).map((t) => {
      const r = t.getBoundingClientRect();
      return r.left + r.width / 2;
    });
    const to = dropIndex(mids, ev.clientX);
    if (to !== from) onMove(from, to);
  };
  addEventListener("pointermove", move);
  addEventListener("pointerup", up);
  addEventListener("pointercancel", up);
}
