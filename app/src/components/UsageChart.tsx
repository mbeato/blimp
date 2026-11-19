import { useState, type PointerEvent } from "react";
import { accountName, amount, axis, busiest, chart, dayLabel, measured, modelName, money, tokens, type Chart, type Measure, type UsageView } from "../lib/usage";

const GUTTER = 44; // px, the axis values' column left of the plot (.uc-plot's padding-left)
const DENSE = 120; // more bars than this: no gap between them (years of weeks)
const MIN_BOX = 150; // px: less room than this beside a slot, and the hover box goes elsewhere
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// The ids that get a colour on the chart, the biggest first, with their names and their amount over the range (cost, or
// tokens). The Breakdown table puts the same dots by the same rows.
export function chartSeries(v: UsageView, by: "account" | "model", measure: Measure): { id: string; name: string; amount: number }[] {
  const named = (
    by === "account"
      ? v.accounts.map((a) => ({ id: a.id, name: accountName(a), amount: amount(a, measure) }))
      : v.models.map((m) => ({ id: m.model, name: modelName(m.model), amount: amount(m, measure) }))
  ).filter((n) => n.amount > 0);
  // blimpd sends them most cost first; by tokens they are sorted again (a tie keeps that order).
  if (measure === "tokens") named.sort((x, y) => y.amount - x.amount);
  // chart() picks the series from the ranked ids alone.
  return named.slice(0, chart([], by, named.map((n) => n.id)).series.length);
}

// An axis value, short: $0, $250, $2.5K, $0.5; tokens as tokens() says them (0, 500M, 1B).
const tick = (n: number, measure: Measure) => (measure === "tokens" ? tokens(n) : n >= 1000 ? `$${Number((n / 1000).toFixed(1))}K` : `$${n}`);
const two = (n: number) => String(n).padStart(2, "0");
const weekday = (day: string) => WEEKDAYS[new Date(day + "T00:00:00Z").getUTCDay()];

// Cost or tokens per day (Today: per hour, from view.hours), stacked by account or by model, drawn by hand. The 5
// biggest series get a colour each and the rest share a grey. The grid's steps come from axis(), and the top step is
// the top of the plot. One pointer handler on the plot works out the slot under the pointer from its x, so moving
// between slots never flickers; the slot gets a band and a box beside it with the day's amount by series.
export function CostChart(props: { view: UsageView; by: "account" | "model"; days: number; measure: Measure }) {
  const v = props.view;
  // The slot under the pointer, and the bars' width in px then (to place the box).
  const [pointer, setPointer] = useState<{ i: number; w: number } | null>(null);
  const hourly = props.days === 1 && !!v.hours;
  const rows = measured(hourly ? v.hours!.map((h) => ({ ...h, day: two(h.hour) })) : v.days, props.measure);
  const named = chartSeries(v, props.by, props.measure);
  const c = chart(rows, props.by, named.map((n) => n.id));
  const n = c.bars.length;
  const hover = pointer && pointer.i < n ? pointer.i : null; // the slot under the pointer, if it is still there
  const byTokens = props.measure === "tokens";
  const fmt = byTokens ? tokens : money;
  if (!c.max) return <p className="uc-empty">{byTokens ? "No tokens in this range." : "No cost in this range."}</p>;

  const rest = c.bars.reduce((a, bar) => a + bar.rest, 0);
  const ticks = axis(c.max);
  const top = ticks[ticks.length - 1];
  const nowHour = new Date().getHours();
  // The bar that isn't over yet: today's (the last day or week), or the current hour.
  const current = hourly ? nowHour : n - 1;
  const label = (b: Chart["bars"][number]) => (hourly ? `${b.from}:00` : b.from === b.to ? `${weekday(b.from)} ${dayLabel(b.from)}` : `${dayLabel(b.from)} – ${dayLabel(b.to)}`);
  const peak = busiest(rows);
  const range = props.days === 1 ? "today" : props.days > 366 ? "all of the history" : `the last ${props.days} days`;
  const aria =
    `${byTokens ? "Tokens" : "Cost"} per ${hourly ? "hour" : "day"}, ${range}: ${fmt(amount(v.totals, props.measure))} in all` +
    (peak ? `; the busiest ${hourly ? "hour" : "day"} was ${hourly ? `${peak.day}:00` : dayLabel(peak.day)}, ${fmt(peak.cost)}` : "");

  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.floor(((e.clientX - r.left) / r.width) * n);
    // The same slot keeps the same state object, so moving inside a slot renders nothing.
    setPointer((p) => (i < 0 || i >= n ? null : p && p.i === i && p.w === r.width ? p : { i, w: r.width }));
  };

  // Dates under the plot: the first, the last, and one about every 7 bars between (fewer when there are many; every bar
  // when there are 10 or fewer, which leaves room); hours every 6. One too close to the last is left out.
  const step = hourly ? 6 : n <= 10 ? 1 : Math.max(7, Math.ceil(n / 8));
  const dates = hourly ? [0, 6, 12, 18].filter((i) => i < n) : [...new Set([0, ...Array.from({ length: n }, (_, i) => i).filter((i) => i > 0 && i % step === 0 && n - 1 - i >= step / 2), n - 1])];

  const b = hover === null ? undefined : c.bars[hover];
  const parts = b
    ? [...b.costs.map((cost, i) => ({ cost, name: named[i].name, color: `var(--series-${i + 1})` })), { cost: b.rest, name: "Other", color: "var(--series-rest)" }].filter((p) => p.cost > 0).sort((x, y) => y.cost - x.cost)
    : [];
  // Beside its slot: to its right in the left half, to its left in the right half, its width capped by the room on that
  // side so it never leaves the card. With too little room either side (one wide bar), over the plot's left end.
  let box: { left?: number; right?: number; maxWidth: number } | undefined;
  if (pointer && hover !== null) {
    const slot = pointer.w / n;
    const right = pointer.w - (hover + 1) * slot - 8; // room right of the slot, in the plot
    const left = GUTTER + hover * slot - 8; // room left of it, the gutter included
    const toRight = (hover + 0.5) / n <= 0.5 ? right >= MIN_BOX || right >= left : left < MIN_BOX && right > left;
    if (Math.max(left, right) < MIN_BOX) box = { left: GUTTER + 8, maxWidth: pointer.w - 16 };
    else if (toRight) box = { left: GUTTER + (hover + 1) * slot + 8, maxWidth: right };
    else box = { right: pointer.w - hover * slot + 8, maxWidth: left };
  }

  return (
    <>
      <div className="uc-plot" role="img" aria-label={aria}>
        <div className="uc-grid" aria-hidden>
          {ticks.map((t) => (
            <div key={t} className="uc-line" style={{ bottom: `${(t / top) * 100}%` }}>
              <span className="uc-tick">{tick(t, props.measure)}</span>
            </div>
          ))}
        </div>
        <div className={"uc-bars" + (n > DENSE ? " dense" : "")} onPointerMove={onMove} onPointerLeave={() => setPointer(null)} aria-hidden>
          {hover !== null && <div className="uc-band" style={{ left: `${(hover / n) * 100}%`, width: `${100 / n}%` }} />}
          {c.bars.map((bar, i) => (
            <div key={bar.from} className="uc-slot">
              {bar.total > 0 && (
                <div className={"uc-bar" + (i === current ? " current" : "")} style={{ height: `${(bar.total / top) * 100}%` }}>
                  {bar.rest > 0 && <div className="uc-part" style={{ flexGrow: bar.rest, background: "var(--series-rest)" }} />}
                  {bar.costs.map((cost, k) => ({ cost, k })).reverse().map(({ cost, k }) => cost > 0 && <div key={k} className="uc-part" style={{ flexGrow: cost, background: `var(--series-${k + 1})` }} />)}
                </div>
              )}
            </div>
          ))}
        </div>
        {b && box && (
          <div className="uc-box" style={box} aria-hidden>
            <div className="uc-box-head">
              <span className="uc-box-when">
                {label(b)}
                {hover === current && " so far"}
              </span>
              <span className="uc-box-total">{fmt(b.total)}</span>
            </div>
            {parts.map((p) => (
              <div key={p.name} className="uc-box-row">
                <span className="usage-dot" style={{ background: p.color }} />
                <span className="uc-box-name">{p.name}</span>
                <span className="uc-box-cost">{fmt(p.cost)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="uc-dates" aria-hidden>
        {dates.map((i) => (
          <span key={i} style={{ left: `${((i + 0.5) / n) * 100}%` }}>
            {hourly ? c.bars[i].from : dayLabel(c.bars[i].from)}
          </span>
        ))}
      </div>
      <div className="uc-legend">
        {named.map((s, i) => (
          <span key={s.id} className="uc-key">
            <span className="usage-dot" style={{ background: `var(--series-${i + 1})` }} />
            <span className="uc-key-name">{s.name}</span>
            <span className="uc-key-cost">{fmt(s.amount)}</span>
          </span>
        ))}
        {rest > 0 && (
          <span className="uc-key">
            <span className="usage-dot" style={{ background: "var(--series-rest)" }} />
            <span className="uc-key-name">Other</span>
            <span className="uc-key-cost">{fmt(rest)}</span>
          </span>
        )}
      </div>
    </>
  );
}
