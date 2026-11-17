import { useEffect, useRef, type ReactNode } from "react";

// A sheet over the window. Esc or a click outside closes it.
export function Dialog(props: { onClose: () => void; className?: string; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  // A field in the sheet that saves when left (a server's name) is left first: once the sheet is
  // gone, React no longer hears its blur. Focus elsewhere (a terminal behind) stays where it is.
  const close = () => {
    const el = document.activeElement;
    if (el instanceof HTMLElement && box.current?.contains(el)) el.blur();
    props.onClose();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [props.onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={box} className={"dialog " + (props.className ?? "")} role="dialog" aria-modal="true">
        {props.children}
      </div>
    </div>
  );
}
