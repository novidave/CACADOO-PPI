import { FALLBACK_TIME_ZONE } from "./format";

/**
 * {"mon":[["08:00","12:00"],["13:00","17:00"]], ..., "sun":[]} — times in the shop's time zone.
 * Several ranges per day = breaks. A range that ends earlier than it starts ("22:00"–"02:00")
 * runs past midnight and belongs to the day it starts.
 */
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
const DAY_MINUTES = 24 * 60;
/** A gap between two ranges of a day shorter than this is a lunch break (blue), longer = closed. */
const BREAK_LIMIT = 3 * 60;

function minutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

/** "08:00" → "8:00" (how times are shown); "24:00" stays. */
export function displayTime(time: string): string {
  return time.replace(/^0(\d)/, "$1");
}

/** Well-formed ranges (start ≠ end; a start of "24:00" is not one), sorted by start. */
export function validRanges(list: unknown): [string, string][] {
  if (!Array.isArray(list)) return [];
  return list
    .filter(
      (r): r is [string, string] =>
        Array.isArray(r) && typeof r[0] === "string" && typeof r[1] === "string" && TIME.test(r[0]) && TIME.test(r[1]) &&
        minutes(r[0]) < DAY_MINUTES && minutes(r[0]) !== minutes(r[1]) && minutes(r[1]) <= DAY_MINUTES,
    )
    .sort((a, b) => minutes(a[0]) - minutes(b[0]));
}

/** Well-formed ranges for one day, sorted; anything malformed is ignored. */
export function rangesFor(hours: OpeningHours | null | undefined, day: DayKey): [string, string][] {
  return validRanges(hours?.[day]);
}

export function hasHours(hours: OpeningHours | null | undefined): boolean {
  return DAYS.some((d) => rangesFor(hours, d).length > 0);
}

/** schema.org openingHoursSpecification for JSON-LD (a closing time before the opening time = past midnight). */
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

/** Clean opening hours from a form: only well-formed ranges per known day (at most 4). */
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

// ---------------------------------------------------------------- the shop's status

/** 'day_off' = shops may open ("overte otváracie hodiny"); 'shops_closed' = closed by law (from closedFrom). */
export type HolidayKind = "day_off" | "shops_closed";

/** One date of the shop's calendar (shop_calendar(): the owner's special hours and/or a public holiday). */
export interface CalendarDay {
  /** YYYY-MM-DD, the shop's local date. */
  date: string;
  special: { closed: boolean; ranges: [string, string][]; note: string | null } | null;
  /** Only when "Automatické štátne sviatky" is on (the database leaves it out otherwise). */
  holiday: { kind: HolidayKind; closedFrom: string | null; name: { sk: string | null; hu: string | null; en: string | null } } | null;
}

/** Everything the status is computed from: the same for the page, the browser, the API and MCP. */
export interface StatusInput {
  hours: OpeningHours | null;
  timeZone: string | null;
  days: CalendarDay[];
}

export type StatusState = "open" | "break" | "closed" | "holiday" | "no_hours";

export interface ShopStatus {
  state: StatusState;
  /** "sviatok" (special hours on a holiday, or a shortened holiday) / "mimoriadne" (the owner's special hours). */
  label: "holiday" | "special" | null;
  /** Closed because shops must close by law today ("Zatvorené – štátny sviatok"). */
  closedByLaw: boolean;
  /** open: closes at; break: opens again at ("17:00"). */
  until: string | null;
  /** closed: the next opening within a week (null when unknown, e.g. a public day off comes first). */
  next: { time: string; inDays: number; day: DayKey } | null;
  /** When the status changes next (ISO, UTC); null when it never does by itself (no hours). */
  nextChange: string | null;
}

interface Span {
  start: number;
  /** May be past 1440 (past midnight). */
  end: number;
}

interface DayInfo {
  spans: Span[];
  kind: "special" | "closed_by_law" | "day_off" | "regular";
  /** A public holiday applies to this date (with the switch on). */
  holiday: boolean;
  /** closed_by_law: shops close from this minute (0 = all day). */
  closedFrom: number;
}

/** Ranges as minutes; past midnight → end + 24 h; touching or overlapping ranges joined. */
function toSpans(ranges: [string, string][]): Span[] {
  const spans = validRanges(ranges).map(([a, b]) => {
    const start = minutes(a);
    let end = minutes(b);
    if (end <= start) end += DAY_MINUTES;
    return { start, end };
  });
  const out: Span[] = [];
  for (const s of spans) {
    const last = out.at(-1);
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}

const fmt = (minute: number) => {
  const m = ((minute % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  return minute === DAY_MINUTES ? "24:00" : `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

/** "2026-12-24" + n days. */
export function addDays(date: string, n: number): string {
  const t = new Date(`${date}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

export function weekdayOf(date: string): DayKey {
  return DAYS[(new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7];
}

function zoneOf(timeZone: string | null | undefined): string {
  const zone = timeZone || FALLBACK_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return zone;
  } catch {
    return FALLBACK_TIME_ZONE;
  }
}

/** The wall clock in a time zone: date (YYYY-MM-DD) and minutes since midnight. */
export function localDateTime(now: Date, timeZone: string | null | undefined): { date: string; minute: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: zoneOf(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, minute: Number(get("hour")) * 60 + Number(get("minute")) };
}

/** A local date and time in a time zone → the moment (ISO, UTC); right on daylight-saving days too. */
export function zonedToUtc(date: string, minute: number, timeZone: string | null | undefined): string {
  const zone = zoneOf(timeZone);
  const [y, m, d] = date.split("-").map(Number);
  const wanted = Date.UTC(y, m - 1, d, 0, minute);
  const offset = (t: number) => {
    const local = localDateTime(new Date(t), zone);
    const [ly, lm, ld] = local.date.split("-").map(Number);
    return Date.UTC(ly, lm - 1, ld, 0, local.minute) - Math.floor(t / 60_000) * 60_000;
  };
  let t = wanted - offset(wanted);
  t = wanted - offset(t);
  return new Date(t).toISOString();
}

function dayInfo(input: StatusInput, date: string): DayInfo {
  const cal = input.days.find((d) => d.date === date);
  const regular = toSpans(rangesFor(input.hours, weekdayOf(date)));
  // a) the owner's special hours for that date
  if (cal?.special) {
    return {
      spans: cal.special.closed ? [] : toSpans(cal.special.ranges),
      kind: "special",
      holiday: Boolean(cal.holiday),
      closedFrom: 0,
    };
  }
  // b) shops must close by law (from closedFrom; the regular hours before it)
  if (cal?.holiday?.kind === "shops_closed") {
    const from = cal.holiday.closedFrom && TIME.test(cal.holiday.closedFrom) ? minutes(cal.holiday.closedFrom) : 0;
    return {
      spans: regular.filter((s) => s.start < from).map((s) => ({ start: s.start, end: Math.min(s.end, from) })),
      kind: "closed_by_law",
      holiday: true,
      closedFrom: from,
    };
  }
  // c) a public day off
  if (cal?.holiday?.kind === "day_off") return { spans: regular, kind: "day_off", holiday: true, closedFrom: 0 };
  // d) the regular opening hours
  return { spans: regular, kind: "regular", holiday: false, closedFrom: 0 };
}

const labelOf = (info: DayInfo): ShopStatus["label"] =>
  info.kind === "special" ? (info.holiday ? "holiday" : "special") : info.kind === "closed_by_law" ? "holiday" : null;

/** The next opening after `minute` of `date` (that day or the next 7), or null (unknown or none). */
function nextOpening(input: StatusInput, date: string, minute: number): ShopStatus["next"] & { date: string; start: number } | null {
  for (let offset = 0; offset <= 7; offset++) {
    const day = addDays(date, offset);
    const info = dayInfo(input, day);
    // On a public day off nobody knows: the shop may or may not open.
    if (offset > 0 && info.kind === "day_off") return null;
    const span = info.spans.find((s) => (offset > 0 ? true : s.start > minute));
    if (span) return { time: fmt(span.start), inDays: offset, day: weekdayOf(day), date: day, start: span.start };
  }
  return null;
}

/**
 * Open / lunch break / closed / holiday / no hours, now, in the shop's time zone. The first
 * rule that applies wins: a) the owner's special hours for the date; b) a day shops must close
 * by law (from its closing time); c) a public day off (yellow); d) the regular hours — open
 * inside a range, lunch break in a gap of under 3 hours between two ranges of the day, closed
 * otherwise; e) no opening hours at all (grey). A range past midnight belongs to the day it
 * starts. Holidays reach this function only when the shop's "Automatické štátne sviatky" is on.
 */
export function shopStatus(input: StatusInput, now: Date = new Date()): ShopStatus {
  const zone = zoneOf(input.timeZone);
  const { date, minute } = localDateTime(now, zone);
  const at = (day: string, m: number) => zonedToUtc(addDays(day, Math.floor(m / DAY_MINUTES)), m % DAY_MINUTES, zone);
  const base = { label: null, closedByLaw: false, until: null, next: null } as const;

  // A range of yesterday that runs past midnight still counts (it belongs to yesterday).
  const yesterday = addDays(date, -1);
  const before = dayInfo(input, yesterday);
  for (const s of before.spans) {
    if (s.end > DAY_MINUTES && minute < s.end - DAY_MINUTES) {
      if (before.kind === "day_off") return { ...base, state: "holiday", nextChange: at(date, s.end - DAY_MINUTES) };
      return { ...base, state: "open", label: labelOf(before), until: fmt(s.end), nextChange: at(yesterday, s.end) };
    }
  }

  const today = dayInfo(input, date);
  if (today.kind === "day_off") return { ...base, state: "holiday", nextChange: at(date, DAY_MINUTES) };
  if (today.kind === "regular" && !hasHours(input.hours)) return { ...base, state: "no_hours", nextChange: null };
  if (today.kind === "closed_by_law" && !hasHours(input.hours) && minute < today.closedFrom) {
    return { ...base, state: "no_hours", nextChange: at(date, today.closedFrom) };
  }
  const label = labelOf(today);

  const inside = today.spans.find((s) => s.start <= minute && minute < s.end);
  if (inside) return { ...base, state: "open", label, until: fmt(inside.end), nextChange: at(date, inside.end) };

  const previous = [...today.spans].reverse().find((s) => s.end <= minute);
  const following = today.spans.find((s) => s.start > minute);
  if (previous && following && following.start - previous.end < BREAK_LIMIT) {
    return { ...base, state: "break", label, until: fmt(following.start), nextChange: at(date, following.start) };
  }

  const closedByLaw = today.kind === "closed_by_law" && minute >= today.closedFrom;
  const next = nextOpening(input, date, minute);
  return {
    ...base,
    state: "closed",
    label: closedByLaw ? null : label,
    closedByLaw,
    next: next ? { time: next.time, inDays: next.inDays, day: next.day } : null,
    nextChange: next ? at(next.date, next.start) : at(date, DAY_MINUTES),
  };
}

/** The texts of a status (namespace "status" of the messages). */
export interface StatusLabels {
  open: string;
  break: string;
  closed: string;
  closed_holiday: string;
  holiday: string;
  no_hours: string;
  closes_at: string;
  opens_at: string;
  opens_tomorrow: string;
  opens_day: string;
  label_holiday: string;
  label_special: string;
}

const fill = (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (all, k: string) => values[k] ?? all);

/** "Otvorené" + "zatvára o 17:00" (+ "sviatok"): the same words on the page, in the browser, the API and MCP. */
export function statusParts(status: ShopStatus, labels: StatusLabels, lang: string): { main: string; detail: string | null; label: string | null } {
  const label = status.label === "holiday" ? labels.label_holiday : status.label === "special" ? labels.label_special : null;
  switch (status.state) {
    case "open":
      return { main: labels.open, detail: fill(labels.closes_at, { time: displayTime(status.until ?? "") }), label };
    case "break":
      return { main: labels.break, detail: fill(labels.opens_at, { time: displayTime(status.until ?? "") }), label };
    case "closed": {
      const next = status.next;
      const time = next ? displayTime(next.time) : "";
      const detail = !next
        ? null
        : next.inDays === 0
          ? fill(labels.opens_at, { time })
          : next.inDays === 1
            ? fill(labels.opens_tomorrow, { time })
            : fill(labels.opens_day, { day: dayName(next.day, lang), time });
      return { main: status.closedByLaw ? labels.closed_holiday : labels.closed, detail, label };
    }
    case "holiday":
      return { main: labels.holiday, detail: null, label: null };
    default:
      return { main: labels.no_hours, detail: null, label: null };
  }
}

/** One line: "Otvorené · zatvára o 17:00 · sviatok". */
export function statusText(status: ShopStatus, labels: StatusLabels, lang: string): string {
  const p = statusParts(status, labels, lang);
  return [p.main, p.detail, p.label].filter(Boolean).join(" · ");
}

/** The special days and holidays from today on (shop's time zone), for the list under the hours. */
export function upcomingDays(input: StatusInput, now: Date = new Date(), count = 14) {
  const { date: today } = localDateTime(now, input.timeZone);
  const last = addDays(today, count - 1);
  return input.days
    .filter((d) => d.date >= today && d.date <= last && (d.special || d.holiday))
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => {
      const info = dayInfo(input, d.date);
      return {
        date: d.date,
        day: weekdayOf(d.date),
        kind: info.kind,
        holidayName: d.holiday?.name ?? null,
        note: d.special?.note ?? null,
        closed: info.kind !== "day_off" && info.spans.length === 0,
        ranges: info.spans.map((s) => [fmt(s.start), fmt(s.end)] as [string, string]),
        closedFrom: d.holiday?.kind === "shops_closed" && !d.special ? d.holiday.closedFrom : null,
      };
    });
}

/**
 * schema.org specialOpeningHoursSpecification for the coming days: the owner's special days and
 * the days shops must close by law (closed all day = opens and closes "00:00"). Public days off
 * where shops may open are left out: their hours are not known.
 */
export function specialOpeningHoursSpecification(input: StatusInput, now: Date = new Date(), count = 60) {
  const { date: today } = localDateTime(now, input.timeZone);
  const last = addDays(today, count - 1);
  return input.days
    .filter((d) => d.date >= today && d.date <= last && (d.special || d.holiday?.kind === "shops_closed"))
    .sort((a, b) => a.date.localeCompare(b.date))
    .flatMap((d) => {
      const info = dayInfo(input, d.date);
      const valid = { validFrom: d.date, validThrough: d.date };
      if (info.spans.length === 0) return [{ "@type": "OpeningHoursSpecification", opens: "00:00", closes: "00:00", ...valid }];
      return info.spans.map((s) => ({
        "@type": "OpeningHoursSpecification",
        opens: fmt(s.start),
        closes: s.end === DAY_MINUTES ? "23:59" : fmt(s.end),
        ...valid,
      }));
    });
}

/** Colours of the status dots (the one colour exception besides the logo; always with the text). */
export { STATUS_COLORS } from "./statusColors";
