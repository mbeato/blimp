import { useLayoutEffect, useRef, useState } from "react";
import type { Session } from "../lib/api";
import { type Bar, fitBar, oneLine, type RunItem } from "../lib/runs";

// A slim bar above a Claude session's terminal with the commands in Claude's latest reply (lib/runs.ts).
// Each one's full text is its tooltip; clicking Run is the go-ahead (nothing runs before). A run opens in a
// split to the right; once it ended, its exit code and Send result to Claude, which types the exit code
// and the last lines of its output into Claude. × hides the bar until a reply with other commands.
// In a narrow split, the commands that don't fit go to the +N menu (lib/runs.ts fitBar): measured, as
// widths depend on the commands, their exit codes and the split.
export function RunBar(props: {
  bar: Bar;
  onRun: (command: string) => void;
  onShow: (run: Session) => void;
  onSend: (run: Session) => void;
  onHide: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const items = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = box.current!;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // When the bar, a run's state or the width changes: all of them first, then one fewer at a time while
  // they overflow (a layout effect, so before anything is painted).
  const sig = [width, props.bar.key, ...props.bar.shown.map((i) => (i.run ? `${i.run.name}:${i.run.run?.exit}` : ""))].join("\0");
  const [fit, setFit] = useState({ sig, n: props.bar.shown.length });
  const n = fit.sig === sig ? fit.n : props.bar.shown.length;
  useLayoutEffect(() => {
    const el = items.current;
    if (el && n > 1 && el.scrollWidth > el.clientWidth + 1) setFit({ sig, n: n - 1 });
  });
  const bar = fitBar(props.bar, n);
  return (
    <div className="runbar" role="toolbar" aria-label="Commands from Claude's reply" ref={box}>
      <span className="runbar-label">Run</span>
      <span className={"runbar-items" + (bar.shown.length === 1 ? " lone" : "")} ref={items}>
        {bar.shown.map((item) => (
          <Item key={item.command} item={item} {...props} />
        ))}
      </span>
      {bar.more.length > 0 && (
        <div className="menu-anchor">
          <button className="runbar-more" aria-expanded={menu} title="More commands from Claude's reply" onClick={() => setMenu(!menu)}>
            +{bar.more.length}
          </button>
          {menu && (
            <>
              <div className="menu-scrim" onClick={() => setMenu(false)} />
              <div className="menu runbar-menu" role="menu" onKeyDown={(e) => e.key === "Escape" && setMenu(false)}>
                {bar.more.map((item, i) => (
                  <button key={item.command} role="menuitem" autoFocus={i === 0} title={item.command} onClick={() => (setMenu(false), props.onRun(item.command))}>
                    <code>{oneLine(item.command)}</code>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
      <button className="tab-close runbar-hide" title="Hide these commands" aria-label="Hide these commands" onClick={props.onHide}>
        ×
      </button>
    </div>
  );
}

function Item(props: { item: RunItem; onRun: (command: string) => void; onShow: (run: Session) => void; onSend: (run: Session) => void }) {
  const { command, run } = props.item;
  const exit = run?.run?.exit;
  return (
    <>
      <button className="runbar-run" title={`Run in a new split:\n${command}`} onClick={() => props.onRun(command)}>
        <svg width="8" height="10" viewBox="0 0 8 10" aria-hidden>
          <path d="M0 0l8 5-8 5z" fill="currentColor" />
        </svg>
        <code>{oneLine(command)}</code>
      </button>
      {run && exit === undefined && (
        <button className="runbar-status" title="Show the run" onClick={() => props.onShow(run)}>
          running…
        </button>
      )}
      {run && exit !== undefined && (
        <>
          <button className={"runbar-status" + (exit ? " failed" : "")} title="Show the run" onClick={() => props.onShow(run)}>
            exit {exit}
          </button>
          <button className="runbar-send" title="Type its exit code and the last lines of its output into Claude" onClick={() => props.onSend(run)}>
            Send result to Claude
          </button>
        </>
      )}
    </>
  );
}
