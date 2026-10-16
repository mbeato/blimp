// A 1 px divider with a wider invisible grab area. onDrag gets the pointer's x in the window.
export function Splitter(props: { onDrag: (x: number) => void; label: string }) {
  return (
    <div
      className="splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label={props.label}
      onPointerDown={(e) => {
        e.preventDefault();
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        document.body.classList.add("dragging");
        const move = (ev: PointerEvent) => props.onDrag(ev.clientX);
        const up = () => {
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", up);
          document.body.classList.remove("dragging");
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
      }}
    />
  );
}
