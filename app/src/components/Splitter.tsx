// A 1 px divider with a wider invisible grab area. onDrag gets the pointer's x in the window
// (axis "x", a vertical divider between columns) or its y (axis "y", between rows).
export function Splitter(props: { onDrag: (pos: number) => void; label: string; axis?: "x" | "y" }) {
  const y = props.axis === "y";
  return (
    <div
      className={"splitter" + (y ? " splitter-y" : "")}
      role="separator"
      aria-orientation={y ? "horizontal" : "vertical"}
      aria-label={props.label}
      onPointerDown={(e) => {
        e.preventDefault();
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        document.body.classList.add(y ? "dragging-y" : "dragging");
        const move = (ev: PointerEvent) => props.onDrag(y ? ev.clientY : ev.clientX);
        const up = () => {
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", up);
          document.body.classList.remove("dragging", "dragging-y");
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
      }}
    />
  );
}
