"use client";

import { useEffect, useRef, useState } from "react";
import { DAYS, type DayKey, type OpeningHours } from "@/lib/hours";

type Ranges = Record<DayKey, [string, string][]>;

/** What the small editor is open for: one range, a new range, or a break that splits the day's one range. */
type Editing = { day: DayKey; mode: "range"; index: number } | { day: DayKey; mode: "new" } | { day: DayKey; mode: "break" };

export interface HoursLabels {
  closed: string;
  add: string;
  remove: string;
  add_break: string;
  break_from: string;
  break_to: string;
  break_outside: string;
  past_midnight: string;
  from: string;
  to: string;
  done: string;
  close: string;
  edit: string;
}

const MAX_RANGES = 4;
const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const clock = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
/** "08:00" → "8:00" (the pills, as the artboard writes them). */
const short = (t: string) => t.replace(/^0(\d)/, "$1");

/**
 * Opening hours per weekday as pills (canvas "Cacaduu – webová aplikácia (Môj obchod)", artboard 9, 2026-11-07): one
 * 52 px row per day — the short day name, then a pill per range ("8:00–12:00", 44 px, radius 22); "+ prestávka" (dashed)
 * when a day has one range, "+ čas" when it has two or three; a closed day = the grey pill "Zatvorené". A tap on a pill
 * opens a small `<dialog>` (from / to, "Zatvorené", "Odstrániť", "Hotovo"; Esc closes it) that changes only that range;
 * a break splits the day's range in two (the gap is the break, no new data). A closing time before the opening time
 * runs past midnight. Writes JSON into a hidden input named `name` — the server cleans it again (sanitizeHours, SQL's
 * valid_week_hours). `data-initial` lets the save bar count the change; the form's "Zrušiť" (reset) puts it back.
 */
export function HoursEditor({
  name,
  initial,
  dayNames,
  shortNames,
  labels,
}: {
  name: string;
  initial: OpeningHours | null;
  dayNames: Record<DayKey, string>;
  shortNames: Record<DayKey, string>;
  labels: HoursLabels;
}) {
  const start = () =>
    Object.fromEntries(DAYS.map((d) => [d, (initial?.[d] ?? []).map((r) => [r[0], r[1]] as [string, string])])) as Ranges;
  const [first] = useState(start);
  const [hours, setHours] = useState<Ranges>(first);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [from, setFrom] = useState("08:00");
  const [to, setTo] = useState("17:00");
  const [problem, setProblem] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);

  // the save bar counts the change (the form hears "change"); "Zrušiť" (the form's reset) puts the first hours back
  useEffect(() => {
    field.current?.dispatchEvent(new Event("change", { bubbles: true }));
  }, [hours]);
  useEffect(() => {
    const form = field.current?.form;
    if (!form) return;
    const reset = () => setHours(first);
    form.addEventListener("reset", reset);
    return () => form.removeEventListener("reset", reset);
  }, [first]);

  const update = (day: DayKey, ranges: [string, string][]) => setHours((h) => ({ ...h, [day]: ranges }));

  function open(next: Editing, button: HTMLButtonElement) {
    opener.current = button;
    const ranges = hours[next.day];
    if (next.mode === "range") {
      setFrom(ranges[next.index][0]);
      setTo(ranges[next.index][1]);
    } else if (next.mode === "break") {
      // 12:00–12:30 when it fits the day's range, else 30 minutes in its middle
      const [a, b] = ranges[0];
      const start = minutes(a);
      const end = minutes(b) <= start ? minutes(b) + 24 * 60 : minutes(b);
      const fits = start < 12 * 60 && 12 * 60 + 30 < end;
      const mid = fits ? 12 * 60 : Math.round((start + end) / 2 / 30) * 30 - 15;
      setFrom(clock(mid));
      setTo(clock(mid + 30));
    } else {
      const last = ranges.at(-1);
      setFrom(last ? last[1] : "08:00");
      setTo(last ? "18:00" : "17:00");
    }
    setProblem(false);
    setEditing(next);
    dialog.current?.showModal();
  }

  function close() {
    dialog.current?.close();
  }

  function done() {
    if (!editing || !from || !to) return;
    const { day } = editing;
    const ranges = hours[day];
    if (editing.mode === "range") {
      update(day, ranges.map((r, j) => (j === editing.index ? [from, to] : r)));
    } else if (editing.mode === "new") {
      if (ranges.length >= MAX_RANGES) return close();
      update(day, [...ranges, [from, to]]);
    } else {
      // 8:00–17:00 + a break 12:00–12:30 → 8:00–12:00, 12:30–17:00
      const i = ranges.findIndex(([a, b]) => {
        const end = minutes(b) <= minutes(a) ? minutes(b) + 24 * 60 : minutes(b);
        return minutes(a) < minutes(from) && minutes(from) < minutes(to) && minutes(to) < end;
      });
      if (i < 0) {
        setProblem(true);
        return;
      }
      const [a, b] = ranges[i];
      update(day, [...ranges.slice(0, i), [a, from], [to, b], ...ranges.slice(i + 1)]);
    }
    close();
  }

  const pill = "min-h-11 whitespace-nowrap rounded-[22px] border border-[#D6D6D6] bg-white px-3.5 text-[15px] font-semibold text-[#111]";
  const timeField = "min-h-[52px] w-full rounded-xl border border-[#D6D6D6] bg-white px-3.5 text-[17px] font-medium";
  const day = editing?.day;
  const title = day ? dayNames[day] : "";

  return (
    <div className="flex flex-col" data-hours-editor>
      <input ref={field} type="hidden" name={name} value={JSON.stringify(hours)} data-initial={JSON.stringify(first)} />
      {DAYS.map((d, n) => {
        const ranges = hours[d];
        return (
          <div
            key={d}
            className={`grid min-h-[52px] grid-cols-[44px_1fr] items-center gap-2.5 py-1 ${n < DAYS.length - 1 ? "border-b border-[#E4E4E4]" : ""}`}
            data-hours-day={d}
          >
            <strong className="capitalize" title={dayNames[d]}>
              {shortNames[d]}
            </strong>
            <div className="flex flex-wrap gap-2">
              {ranges.length === 0 && (
                <button
                  type="button"
                  className={`${pill} bg-[#F2F2F2]`}
                  aria-label={`${dayNames[d]}: ${labels.closed}. ${labels.add}`}
                  onClick={(e) => open({ day: d, mode: "new" }, e.currentTarget)}
                  data-hours-closed={d}
                >
                  {labels.closed}
                </button>
              )}
              {ranges.map(([a, b], i) => (
                <button
                  key={i}
                  type="button"
                  className={pill}
                  aria-label={`${labels.edit}: ${dayNames[d]} ${short(a)}–${short(b)}`}
                  onClick={(e) => open({ day: d, mode: "range", index: i }, e.currentTarget)}
                  data-hours-range={`${d}-${i}`}
                >
                  {short(a)}–{short(b)}
                </button>
              ))}
              {ranges.length === 1 && (
                <button
                  type="button"
                  className={`${pill} border-dashed`}
                  aria-label={`${dayNames[d]}: ${labels.add_break}`}
                  onClick={(e) => open({ day: d, mode: "break" }, e.currentTarget)}
                  data-add-break={d}
                >
                  {labels.add_break}
                </button>
              )}
              {ranges.length >= 2 && ranges.length < MAX_RANGES && (
                <button
                  type="button"
                  className={`${pill} border-dashed`}
                  aria-label={`${dayNames[d]}: ${labels.add}`}
                  onClick={(e) => open({ day: d, mode: "new" }, e.currentTarget)}
                  data-add-range={d}
                >
                  {labels.add}
                </button>
              )}
            </div>
          </div>
        );
      })}
      <p className="pt-2 text-xs text-muted">{labels.past_midnight}</p>

      <dialog
        ref={dialog}
        className="m-auto w-[min(92vw,400px)] rounded-2xl border border-[#E4E4E4] p-0 backdrop:bg-black/40"
        aria-label={title}
        onClose={() => {
          setEditing(null);
          opener.current?.focus();
        }}
        data-hours-dialog
      >
        <div className="flex flex-col gap-4 p-5">
          <h3 className="text-lg font-bold capitalize">
            {title}
            {editing?.mode === "break" ? ` · ${labels.add_break.replace(/^\+\s*/, "")}` : ""}
          </h3>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1.5 text-sm font-semibold">
              {editing?.mode === "break" ? labels.break_from : labels.from}
              <input type="time" value={from} onChange={(e) => setFrom(e.target.value)} className={timeField} data-hours-from />
            </label>
            <label className="flex flex-col gap-1.5 text-sm font-semibold">
              {editing?.mode === "break" ? labels.break_to : labels.to}
              <input type="time" value={to} onChange={(e) => setTo(e.target.value)} className={timeField} data-hours-to />
            </label>
          </div>
          {problem && (
            <p role="alert" className="text-sm font-semibold">
              {labels.break_outside}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2 empty:hidden">
            {editing && editing.mode !== "break" && hours[editing.day].length > 0 && (
              <button
                type="button"
                className="min-h-11 rounded-xl border border-[#D6D6D6] bg-white px-3.5 font-bold"
                onClick={() => {
                  update(editing.day, []);
                  close();
                }}
                data-hours-set-closed
              >
                {labels.closed}
              </button>
            )}
            {editing?.mode === "range" && (
              <button
                type="button"
                className="min-h-11 rounded-xl border border-[#D6D6D6] bg-white px-3.5 font-bold"
                onClick={() => {
                  update(editing.day, hours[editing.day].filter((_, j) => j !== editing.index));
                  close();
                }}
                data-hours-remove
              >
                {labels.remove}
              </button>
            )}
          </div>
          <div className="flex items-center justify-end gap-2">
            <button type="button" className="min-h-11 px-2 font-bold underline underline-offset-4" onClick={close}>
              {labels.close}
            </button>
            <button type="button" className="min-h-11 rounded-xl border border-[#111] bg-[#111] px-5 font-bold text-white" onClick={done} data-hours-done>
              {labels.done}
            </button>
          </div>
        </div>
      </dialog>
    </div>
  );
}
