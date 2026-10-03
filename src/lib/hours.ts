import { FALLBACK_TIME_ZONE } from "./format";

/** {"mon":[["08:00","12:00"],["13:00","17:00"]], ..., "sun":[]} — times in the shop's time zone. */
export type OpeningHours = Partial<Record<DayKey, [string, string][]>>;

export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type DayKey = (typeof DAYS)[number];

const SCHEMA_DAYS: Record<DayKey, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

const TIME = /^([01]\d|2[0-4]):[0-5]\d$/;

function minutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

/** Well-formed ranges for one day, sorted; anything malformed is ignored. */
export function rangesFor(hours: OpeningHours | null | undefined, day: DayKey): [string, string][] {
  const list = hours?.[day];
  if (!Array.isArray(list)) return [];
  return list
    .filter(
      (r): r is [string, string] =>
        Array.isArray(r) && TIME.test(r[0]) && TIME.test(r[1]) && minutes(r[0]) < minutes(r[1]),
    )
    .sort((a, b) => minutes(a[0]) - minutes(b[0]));
}

export function hasHours(hours: OpeningHours | null | undefined): boolean {
  return DAYS.some((d) => rangesFor(hours, d).length > 0);
}

/** Weekday and minutes since midnight, in the shop's time zone. */
function localNow(now: Date, timeZone: string | null | undefined): { day: number; minute: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: timeZone || FALLBACK_TIME_ZONE,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
  } catch {
    return localNow(now, FALLBACK_TIME_ZONE);
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const day = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(get("weekday"));
  return { day, minute: Number(get("hour")) * 60 + Number(get("minute")) };
}

export type OpeningStatus =
  | { open: true; closesAt: string }
  | { open: false; opensAt: string; opensIn: number /* 0 = today, 1 = tomorrow, … */; opensDay: DayKey }
  | { open: false; opensAt: null };

/** Open now? When does it close, or when does it open next (within a week)? */
export function openingStatus(
  hours: OpeningHours | null | undefined,
  timeZone: string | null | undefined,
  now: Date = new Date(),
): OpeningStatus | null {
  if (!hasHours(hours)) return null;
  const { day, minute } = localNow(now, timeZone);

  for (const [start, end] of rangesFor(hours, DAYS[day])) {
    if (minute >= minutes(start) && minute < minutes(end)) return { open: true, closesAt: end };
  }
  for (let offset = 0; offset < 7; offset++) {
    const dayKey = DAYS[(day + offset) % 7];
    const next = rangesFor(hours, dayKey).find(([start]) => offset > 0 || minutes(start) > minute);
    if (next) return { open: false, opensAt: next[0], opensIn: offset, opensDay: dayKey };
  }
  return { open: false, opensAt: null };
}

/** schema.org openingHoursSpecification for JSON-LD. */
export function openingHoursSpecification(hours: OpeningHours | null | undefined) {
  return DAYS.flatMap((day) =>
    rangesFor(hours, day).map(([opens, closes]) => ({
      "@type": "OpeningHoursSpecification",
      dayOfWeek: `https://schema.org/${SCHEMA_DAYS[day]}`,
      opens,
      closes: closes === "24:00" ? "23:59" : closes,
    })),
  );
}

/** Day name in the visitor's language: "pondelok", "hétfő", "Monday". */
export function dayName(day: DayKey, locale: string): string {
  // 2024-01-01 was a Monday.
  const date = new Date(Date.UTC(2024, 0, 1 + DAYS.indexOf(day), 12));
  return new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(date);
}

/** Clean opening hours from a form: only well-formed, non-overlapping-safe ranges per known day. */
export function sanitizeHours(value: unknown): OpeningHours {
  let raw: unknown = value;
  if (typeof value === "string") {
    try {
      raw = JSON.parse(value);
    } catch {
      raw = {};
    }
  }
  const out: OpeningHours = {};
  for (const day of DAYS) out[day] = rangesFor(raw as OpeningHours, day).slice(0, 4);
  return out;
}
