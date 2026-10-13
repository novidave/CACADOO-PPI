"use client";

import { useState } from "react";
import { DAYS, type DayKey, type OpeningHours } from "@/lib/hours";

/**
 * Opening hours per weekday, several ranges per day (lunch breaks). "+ Obedňajšia prestávka"
 * splits the day's range in two (no new data: two ranges, the gap is the break); editing two
 * ranges by hand does the same. A closing time before the opening time runs past midnight.
 * Writes JSON into a hidden input named `name`; the server cleans it again.
 */
export function HoursEditor({
  name,
  initial,
  dayNames,
  labels,
}: {
  name: string;
  initial: OpeningHours | null;
  dayNames: Record<DayKey, string>;
  labels: {
    closed: string;
    add: string;
    remove: string;
    add_break: string;
    break_from: string;
    break_to: string;
    break_add: string;
    break_cancel: string;
    break_outside: string;
    past_midnight: string;
  };
}) {
  const [hours, setHours] = useState<Record<DayKey, [string, string][]>>(() =>
    Object.fromEntries(DAYS.map((d) => [d, (initial?.[d] ?? []).map((r) => [r[0], r[1]] as [string, string])])) as Record<
      DayKey,
      [string, string][]
    >,
  );

  const update = (day: DayKey, ranges: [string, string][]) => setHours((h) => ({ ...h, [day]: ranges }));
  // The day whose "+ Obedňajšia prestávka" is open, with the break's from–to.
  const [breakDay, setBreakDay] = useState<DayKey | null>(null);
  const [breakFrom, setBreakFrom] = useState("12:00");
  const [breakTo, setBreakTo] = useState("12:30");
  const [breakProblem, setBreakProblem] = useState(false);

  /** Splits the range that holds the break into two: 8:00–17:00 + 12:00–12:30 → 8:00–12:00, 12:30–17:00. */
  function addBreak(day: DayKey) {
    const m = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
    const ranges = hours[day];
    const i = ranges.findIndex(([a, b]) => {
      const end = m(b) <= m(a) ? m(b) + 24 * 60 : m(b);
      return m(a) < m(breakFrom) && m(breakFrom) < m(breakTo) && m(breakTo) < end;
    });
    if (i < 0) {
      setBreakProblem(true);
      return;
    }
    const [a, b] = ranges[i];
    update(day, [...ranges.slice(0, i), [a, breakFrom], [breakTo, b], ...ranges.slice(i + 1)]);
    setBreakDay(null);
    setBreakProblem(false);
  }

  return (
    <div className="flex flex-col divide-y divide-line border-y border-line">
      <input type="hidden" name={name} value={JSON.stringify(hours)} />
      {DAYS.map((day) => (
        <div key={day} className="flex flex-wrap items-center gap-2 py-2">
          <span className="w-28 capitalize">{dayNames[day]}</span>
          {hours[day].length === 0 && <span className="text-sm text-muted">{labels.closed}</span>}
          {hours[day].map(([from, to], i) => (
            <span key={i} className="flex items-center gap-1">
              <input
                type="time"
                value={from}
                aria-label={`${dayNames[day]} ${i + 1} from`}
                onChange={(e) => update(day, hours[day].map((r, j) => (j === i ? [e.target.value, r[1]] : r)))}
                className="rounded border border-line px-1 py-0.5"
              />
              –
              <input
                type="time"
                value={to}
                aria-label={`${dayNames[day]} ${i + 1} to`}
                onChange={(e) => update(day, hours[day].map((r, j) => (j === i ? [r[0], e.target.value] : r)))}
                className="rounded border border-line px-1 py-0.5"
              />
              <button
                type="button"
                onClick={() => update(day, hours[day].filter((_, j) => j !== i))}
                className="px-1 text-sm text-muted underline"
              >
                {labels.remove}
              </button>
            </span>
          ))}
          {hours[day].length < 4 && (
            <button
              type="button"
              onClick={() => {
                const last = hours[day].at(-1);
                update(day, [...hours[day], last ? [last[1], "18:00"] : ["08:00", "17:00"]]);
              }}
              className="text-sm underline underline-offset-4"
            >
              {labels.add}
            </button>
          )}
          {hours[day].length > 0 && hours[day].length < 4 && breakDay !== day && (
            <button
              type="button"
              onClick={() => {
                setBreakDay(day);
                setBreakProblem(false);
              }}
              className="text-sm underline underline-offset-4"
              data-add-break={day}
            >
              {labels.add_break}
            </button>
          )}
          {breakDay === day && (
            <span className="flex flex-wrap items-center gap-1 text-sm" data-break-form={day}>
              <span>{labels.break_from}</span>
              <input
                type="time"
                value={breakFrom}
                aria-label={`${dayNames[day]} ${labels.break_from}`}
                onChange={(e) => setBreakFrom(e.target.value)}
                className="rounded border border-line px-1 py-0.5"
              />
              <span>{labels.break_to}</span>
              <input
                type="time"
                value={breakTo}
                aria-label={`${dayNames[day]} ${labels.break_to}`}
                onChange={(e) => setBreakTo(e.target.value)}
                className="rounded border border-line px-1 py-0.5"
              />
              <button type="button" onClick={() => addBreak(day)} className="rounded border border-foreground px-2 py-0.5">
                {labels.break_add}
              </button>
              <button type="button" onClick={() => setBreakDay(null)} className="underline underline-offset-4">
                {labels.break_cancel}
              </button>
              {breakProblem && (
                <span role="alert" className="w-full">
                  {labels.break_outside}
                </span>
              )}
            </span>
          )}
        </div>
      ))}
      <p className="py-2 text-xs text-muted">{labels.past_midnight}</p>
    </div>
  );
}
