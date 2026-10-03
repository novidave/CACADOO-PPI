"use client";

import { useState } from "react";
import { DAYS, type DayKey, type OpeningHours } from "@/lib/hours";

/**
 * Opening hours per weekday, several ranges per day (lunch breaks).
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
  labels: { closed: string; add: string; remove: string };
}) {
  const [hours, setHours] = useState<Record<DayKey, [string, string][]>>(() =>
    Object.fromEntries(DAYS.map((d) => [d, (initial?.[d] ?? []).map((r) => [r[0], r[1]] as [string, string])])) as Record<
      DayKey,
      [string, string][]
    >,
  );

  const update = (day: DayKey, ranges: [string, string][]) => setHours((h) => ({ ...h, [day]: ranges }));

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
        </div>
      ))}
    </div>
  );
}
