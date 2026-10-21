import { useState } from "react";
import type { Session } from "../lib/api";
import { oneLine, type RunItem, runBar } from "../lib/runs";

// A slim bar above a Claude session's terminal with the commands in Claude's latest reply (lib/runs.ts).
// Each one's full text is its tooltip; clicking Run is the go-ahead (nothing runs before). A run opens in a
// split to the right; once it ended, its exit code and Send result to Claude, which types the exit code
// and the last lines of its output into Claude. × hides the bar until a reply with other commands.
export function RunBar(props: {
  bar: NonNullable<ReturnType<typeof runBar>>;
  onRun: (command: string) => void;
  onShow: (run: Session) => void;
  onSend: (run: Session) => void;
  onHide: () => void;
}) {
  const { bar } = props;
  const [menu, setMenu] = useState(false);
  return (
    <div className="runbar" role="toolbar" aria-label="Commands from Claude's reply">
      <span className="runbar-label">Run</span>
      <span className="runbar-items">
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
