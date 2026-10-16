import { useState } from "react";
import type { Session } from "../lib/api";
import type { ServerLink } from "../lib/connection";
import { fuzzyFilter } from "../lib/fuzzy";
import { tildify } from "../lib/sidebar";
import { Dialog } from "./Dialog";

type Item = { link: ServerLink; s: Session; folder: string };

// ⌘K: jump to any session on any server by typing part of its title, folder or name.
export function Palette(props: { links: ServerLink[]; onPick: (link: ServerLink, name: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const all = props.links.flatMap((link) =>
    (link.sessions ?? []).map((s): Item => ({ link, s, folder: tildify(s.dir, link.home) })),
  );
  const items = fuzzyFilter(all, query, (i) => `${i.s.title} ${i.folder} ${i.s.name}`);
  const pick = (i: Item | undefined) => i && props.onPick(i.link, i.s.name);

  return (
    <Dialog onClose={props.onClose} className="palette">
      <input
        className="palette-input"
        autoFocus
        placeholder="Jump to a session"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setSel(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") setSel((n) => Math.min(n + 1, items.length - 1));
          else if (e.key === "ArrowUp") setSel((n) => Math.max(n - 1, 0));
          else if (e.key === "Enter") pick(items[sel]);
          else return;
          e.preventDefault();
        }}
      />
      <ul className="list" role="listbox">
        {items.map((i, n) => (
          <li
            key={`${i.link.key}/${i.s.name}`}
            role="option"
            aria-selected={n === sel}
            ref={n === sel ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
            className={"list-item" + (n === sel ? " selected" : "")}
            onMouseMove={() => setSel(n)}
            onClick={() => pick(i)}
          >
            <span className="row-mark">{i.s.state === "waiting" && <span className="dot" />}</span>
            <span className="list-main">{i.s.title}</span>
            <span className="list-side">{i.folder}</span>
          </li>
        ))}
        {items.length === 0 && <li className="list-empty">{all.length ? "No session matches." : "No sessions running."}</li>}
      </ul>
    </Dialog>
  );
}
