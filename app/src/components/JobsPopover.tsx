import { useEffect, useRef } from "react";
import type { Job } from "../lib/api";
import { jobState, KIND_WORD } from "../lib/jobs";

// A session's background jobs, from its row's "2 jobs": each job's kind, what it does, how long it has
// run (or how it ended), and a running job's last output line. at: the "2 jobs" text's box; the popover
// opens under it, or over it when the row is in the lower half of the window, right edges lined up.
// A job's output file isn't offered: it's in /tmp/claude-<uid>, outside home, where blimpd's /fs
// doesn't read.
export function JobsPopover(props: { jobs: Job[]; at: DOMRect; now: number; onClose: () => void }) {
  const { at } = props;
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => box.current?.focus(), []);
  const below = at.top < innerHeight / 2;
  const style = { right: Math.max(8, innerWidth - at.right), ...(below ? { top: at.bottom + 4 } : { bottom: innerHeight - at.top + 4 }) };
  return (
    <>
      <div className="menu-scrim" onClick={props.onClose} onContextMenu={(e) => (e.preventDefault(), props.onClose())} />
      <div className="menu jobs-pop" role="dialog" aria-label="Background jobs" tabIndex={-1} style={style} ref={box} onKeyDown={(e) => e.key === "Escape" && props.onClose()}>
        {props.jobs.map((j) => (
          <div key={j.id} className={"job job-" + j.status} title={j.label}>
            <div className="job-head">
              <span className="job-kind">{KIND_WORD[j.kind]}</span>
              <span className="job-label">{j.label}</span>
              <span className="job-state">{jobState(j, props.now)}</span>
            </div>
            {j.status === "running" && j.lastLine && <div className="job-line">{j.lastLine}</div>}
          </div>
        ))}
      </div>
    </>
  );
}
