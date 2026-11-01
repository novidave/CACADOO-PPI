import type Anthropic from "@anthropic-ai/sdk";

/**
 * Update 63: the shop assistant's booking tools and their small rules, shared by `@/lib/shopChat` and
 * `bookingTools_test.ts`. Every booking rule itself lives in SQL (booking_free_slots, booking_create); here only what the
 * AI may ask for. **No tool takes a name, phone number, e-mail, address or code** — the page's own form does
 * (`ContactCodePanel`), so personal data never passes through the AI.
 */
export const SERVICE_TOOLS: Anthropic.Tool[] = [
  {
    name: "list_services",
    description: "Lists what this shop takes bookings for: a ref (v1…), the name, minutes, how many people at once and the shop's note.",
    strict: true,
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "find_free_slots",
    description:
      "Free start times of one service from a day on (the shop's local time), at most 7 days: inside the opening hours, " +
      "never over another booking, a blocked time or a busy time of the shop's calendar. Returns up to 12 times with a " +
      "ref (s…), the local day, weekday and time, and the person or room when it matters.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        service_ref: { type: "string", description: "A ref from list_services." },
        from: { type: "string", description: 'The first day as YYYY-MM-DD, or "" for today.' },
        days: { type: "integer", description: "How many days from it, 1 to 7." },
      },
      required: ["service_ref", "from", "days"],
      additionalProperties: false,
    },
  },
  {
    name: "book_slot",
    description:
      "Books a time the shopper chose: only a ref find_free_slots returned. The shop checks the time again. Answers ok " +
      "with the booking, or a reason: not_verified (the shopper's mobile is not checked yet: set request_contact), " +
      "slot_taken (offer other times), contact_limit (too many bookings that day), ref (call find_free_slots again).",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        slot_ref: { type: "string" },
        people: { type: "integer", description: "How many people, 1 unless the shopper said more." },
      },
      required: ["slot_ref", "people"],
      additionalProperties: false,
    },
  },
];

/** The index of a service ref "v1"… in the list the assistant was given, or null. */
export function serviceIndex(ref: unknown, count: number): number | null {
  const m = /^v(\d{1,3})$/.exec(String(ref ?? ""));
  if (!m) return null;
  const i = Number(m[1]) - 1;
  return i >= 0 && i < count ? i : null;
}

/** 1…7 days (anything else: 1). */
export const toolDays = (value: unknown) => Math.min(Math.max(Math.floor(Number(value) || 1), 1), 7);

/** 1…500 people (anything else: 1). */
export const toolPeople = (value: unknown) => Math.min(Math.max(Math.floor(Number(value) || 1), 1), 500);

/** Today as YYYY-MM-DD in the shop's time zone. */
export const shopToday = (timeZone: string, now = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone }).format(now);

/** The instant of the wall-clock time `time` (HH:MM) on `day` (YYYY-MM-DD) in `timeZone`, or null for a bad value. */
export function localInstant(day: string, time: string, timeZone: string): Date | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  const t = /^(\d{2}):(\d{2})$/.exec(time);
  if (!d || !t || Number(t[1]) > 23 || Number(t[2]) > 59) return null;
  const guess = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]));
  const offsetAt = (ms: number) => {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
      }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]),
    );
    return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - ms;
  };
  // two steps: the offset at the guess, then at the corrected instant (they differ only across a clock change)
  const first = guess - offsetAt(guess);
  return new Date(guess - offsetAt(first));
}

/** The instant the day `day` (YYYY-MM-DD) begins in `timeZone` — correct on the days the clocks change. */
export const localMidnight = (day: string, timeZone: string): Date => localInstant(day, "00:00", timeZone) ?? new Date(NaN);

/** The window find_free_slots asks SQL for: from the day's local midnight, `days` days on (+1 h for a long DST day). */
export function slotWindow(fromText: string, days: number, timeZone: string, now = new Date()) {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(fromText) ? fromText : shopToday(timeZone, now);
  const from = localMidnight(day, timeZone);
  return { day, from, to: new Date(from.getTime() + days * 86_400_000 + 3_600_000) };
}

/** The page's contact form shows only while nothing was booked and the booking tools asked for the checked number. */
export const wantsContact = (booked: boolean, serviceTools: boolean, notVerified: boolean, askedByAnswer: boolean) =>
  !booked && serviceTools && (notVerified || askedByAnswer);
