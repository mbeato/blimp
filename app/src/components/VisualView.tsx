// A page a session showed (lib/visuals.ts), filling its tab: blimpd's copy in a frame that may run the page's
// scripts but has an origin of its own (a sandbox without allow-same-origin), so it can't reach the app, its token
// or blimpd; blimpd sends the page with a policy that allows its own scripts and blimp's kit and no requests at all
// (docs/DESIGN.md, Visuals). The app's own policy lets frames come only from 127.0.0.1, so the page can't take its
// frame to a website. The frame doesn't take the keyboard as it loads: if the page tries, focus goes back.

import { useEffect, useRef, useState } from "react";
import type { Api, Visual } from "../lib/api";
import { errorText } from "../lib/connection";

export function VisualView(props: { visual: Visual; api: Api | null }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState("");
  const frame = useRef<HTMLIFrameElement>(null);
  const before = useRef<Element | null>(null);
  useEffect(() => {
    const api = props.api;
    if (!api) {
      setError("Not connected.");
      return;
    }
    let live = true;
    api.visualKey().then(
      (key) => {
        if (!live) return;
        before.current = document.activeElement;
        setSrc(api.visualUrl(key, props.visual.id));
        setError("");
      },
      (e) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [props.visual.id, props.api]);
  const loaded = () => {
    if (document.activeElement === frame.current && before.current instanceof HTMLElement) before.current.focus();
  };
  return (
    <>
      {error && <p className="view-note">Can't show this visual: {error}</p>}
      {src && <iframe ref={frame} className="visual-view" sandbox="allow-scripts" src={src} title={props.visual.title || "Visual"} onLoad={loaded} />}
    </>
  );
}
