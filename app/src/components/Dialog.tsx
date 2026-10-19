import { useEffect, type ReactNode } from "react";
import { useOverlay } from "../lib/overlay";

// A sheet over the window. Esc or a click outside closes it.
export function Dialog(props: { onClose: () => void; className?: string; children: ReactNode }) {
  useOverlay();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      props.onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [props.onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className={"dialog " + (props.className ?? "")} role="dialog" aria-modal="true">
        {props.children}
      </div>
    </div>
  );
}
