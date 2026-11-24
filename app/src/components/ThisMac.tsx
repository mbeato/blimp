import { useEffect, useRef, useState } from "react";
import { errorText, thisMac, tryConnect, type Server } from "../lib/connection";
import { setUpThisMac, type Step } from "../lib/thismac";
import { installServer } from "../lib/updates";

// "Use This Mac" (FirstRun, Add server): the steps in lib/thismac.ts with React state. busy: the
// step under way, for the status line. error: why the last run failed; Cancel in the Mac's own
// dialog is no error, so it leaves none.
export function useThisMac(onAdd: (s: Server) => void): { busy: Step | null; error: string; run: () => void } {
  const [busy, setBusy] = useState<Step | null>(null);
  const [error, setError] = useState("");
  const running = useRef(false);
  // Closed meanwhile (Add server's Cancel): nothing is set and nothing added. The install itself
  // can't be stopped from here; it runs on in the background, as Install blimpd's does.
  const gone = useRef(false);
  useEffect(() => {
    gone.current = false;
    return () => {
      gone.current = true;
    };
  }, []);

  const run = () => {
    if (running.current) return;
    running.current = true;
    setError("");
    setUpThisMac({
      connect: () => tryConnect(thisMac).done,
      install: () => installServer(thisMac),
      step: (s) => void (gone.current || setBusy(s)),
    }).then(
      (connected) => {
        running.current = false;
        if (gone.current) return;
        if (connected) onAdd(thisMac);
        else setBusy(null);
      },
      (e) => {
        running.current = false;
        if (gone.current) return;
        setBusy(null);
        setError(errorText(e));
      },
    );
  };

  return { busy, error, run };
}
