// The shop status rules (src/lib/hours.ts) in Europe/Bratislava. Run: npm run test:status (Deno).
import { assertEquals } from "jsr:@std/assert@1";
import {
  type CalendarDay,
  closedPillText,
  type OpeningHours,
  shopStatus,
  type StatusInput,
  statusText,
  specialOpeningHoursSpecification,
  upcomingDays,
  weekHours,
} from "./hours.ts";
import sk from "../i18n/messages/sk.json" with { type: "json" };

const TZ = "Europe/Bratislava";
const WEEK: OpeningHours = {
  mon: [["08:00", "12:00"], ["12:30", "17:00"]],
  tue: [["08:00", "12:00"], ["12:30", "17:00"]],
  wed: [["08:00", "12:00"], ["12:30", "17:00"]],
  thu: [["08:00", "12:00"], ["12:30", "17:00"]],
  fri: [["08:00", "12:00"], ["12:30", "17:00"]],
  sat: [["08:00", "12:00"]],
  sun: [],
};
const input = (days: CalendarDay[] = [], hours: OpeningHours | null = WEEK): StatusInput => ({ hours, timeZone: TZ, days });
const holiday = (date: string, kind: "day_off" | "shops_closed", closedFrom: string | null = null): CalendarDay => ({
  date,
  special: null,
  holiday: { kind, closedFrom, name: { sk: "Sviatok", hu: "Ünnep", en: "Holiday" } },
});
const special = (date: string, closed: boolean, ranges: [string, string][] = [], withHoliday?: CalendarDay["holiday"]): CalendarDay => ({
  date,
  special: { closed, ranges, note: null },
  holiday: withHoliday ?? null,
});
/** Local time in Bratislava (summer +2 until 25 Oct 2026 03:00, then +1). */
const at = (iso: string) => new Date(iso);
const text = (i: StatusInput, iso: string) => statusText(shopStatus(i, at(iso)), sk.status, "sk");

Deno.test("open (green) inside a range", () => {
  const s = shopStatus(input(), at("2026-10-14T08:00:00Z")); // Wed 10:00
  assertEquals([s.state, s.until, s.nextChange], ["open", "12:00", "2026-10-14T10:00:00.000Z"]);
  assertEquals(text(input(), "2026-10-14T08:00:00Z"), "Otvorené · zatvára o 12:00");
});

Deno.test("lunch break (blue) between two ranges under 3 hours", () => {
  const s = shopStatus(input(), at("2026-10-14T10:15:00Z")); // Wed 12:15
  assertEquals([s.state, s.until], ["break", "12:30"]);
  assertEquals(text(input(), "2026-10-14T10:15:00Z"), "Obedňajšia prestávka · otvára o 12:30");
});

Deno.test("a gap of 3 hours or more is closed (red)", () => {
  const hours: OpeningHours = { wed: [["08:00", "11:00"], ["14:00", "18:00"]] };
  const s = shopStatus(input([], hours), at("2026-10-14T10:00:00Z")); // Wed 12:00
  assertEquals([s.state, s.next?.time, s.next?.inDays], ["closed", "14:00", 0]);
  assertEquals(text(input([], hours), "2026-10-14T10:00:00Z"), "Zatvorené · otvára o 14:00");
  // exactly 3 hours is closed too
  const three: OpeningHours = { wed: [["08:00", "11:00"], ["14:00", "18:00"]] };
  assertEquals(shopStatus(input([], three), at("2026-10-14T09:30:00Z")).state, "closed");
});

Deno.test("before opening, after closing, closed day (red)", () => {
  assertEquals(text(input(), "2026-10-14T05:00:00Z"), "Zatvorené · otvára o 8:00"); // Wed 07:00
  assertEquals(text(input(), "2026-10-14T16:00:00Z"), "Zatvorené · otvára zajtra o 8:00"); // Wed 18:00
  const sunday = shopStatus(input(), at("2026-10-18T08:00:00Z")); // Sun 10:00
  assertEquals([sunday.state, sunday.next?.inDays, sunday.next?.day], ["closed", 1, "mon"]);
  assertEquals(text(input(), "2026-10-17T11:00:00Z"), "Zatvorené · otvára: pondelok 8:00"); // Sat 13:00
});

Deno.test("a range past midnight belongs to the day it starts", () => {
  const hours: OpeningHours = { fri: [["20:00", "02:00"]] };
  const fri = shopStatus(input([], hours), at("2026-10-16T21:00:00Z")); // Fri 23:00
  assertEquals([fri.state, fri.until, fri.nextChange], ["open", "02:00", "2026-10-17T00:00:00.000Z"]);
  const sat = shopStatus(input([], hours), at("2026-10-16T23:00:00Z")); // Sat 01:00
  assertEquals([sat.state, sat.until], ["open", "02:00"]);
  assertEquals(shopStatus(input([], hours), at("2026-10-17T00:30:00Z")).state, "closed"); // Sat 02:30
});

Deno.test("public day off (yellow), also without opening hours", () => {
  const days = [holiday("2027-01-06", "day_off")];
  const s = shopStatus(input(days), at("2027-01-06T09:00:00Z")); // Wed 10:00 (winter, +1)
  assertEquals(s.state, "holiday");
  assertEquals(text(input(days), "2027-01-06T09:00:00Z"), "Štátny sviatok – overte otváracie hodiny");
  assertEquals(shopStatus(input(days, null), at("2027-01-06T09:00:00Z")).state, "holiday");
});

Deno.test("shops closed by law (red), 24.12 from 12:00", () => {
  const days = [holiday("2026-12-24", "shops_closed", "12:00"), holiday("2026-12-25", "shops_closed"), holiday("2026-12-26", "shops_closed")];
  const morning = shopStatus(input(days), at("2026-12-24T09:00:00Z")); // Thu 10:00
  assertEquals([morning.state, morning.until, morning.label], ["open", "12:00", "holiday"]);
  assertEquals(text(input(days), "2026-12-24T09:00:00Z"), "Otvorené · zatvára o 12:00 · sviatok");
  const noon = shopStatus(input(days), at("2026-12-24T11:30:00Z")); // 12:30
  assertEquals([noon.state, noon.closedByLaw], ["closed", true]);
  assertEquals(text(input(days), "2026-12-24T11:30:00Z"), "Zatvorené – štátny sviatok · otvára: pondelok 8:00");
  const christmas = shopStatus(input(days), at("2026-12-25T09:00:00Z"));
  assertEquals([christmas.state, christmas.closedByLaw], ["closed", true]);
});

Deno.test("special hours win: on a holiday with a break (blue + sviatok), a special closed day", () => {
  const xmas = holiday("2026-12-25", "shops_closed").holiday;
  const days = [special("2026-12-25", false, [["10:00", "12:00"], ["12:30", "15:00"]], xmas)];
  const s = shopStatus(input(days), at("2026-12-25T11:15:00Z")); // 12:15
  assertEquals([s.state, s.until, s.label], ["break", "12:30", "holiday"]);
  assertEquals(text(input(days), "2026-12-25T11:15:00Z"), "Obedňajšia prestávka · otvára o 12:30 · sviatok");
  const closed = shopStatus(input([special("2026-10-14", true)]), at("2026-10-14T08:00:00Z"));
  assertEquals([closed.state, closed.label, closed.next?.inDays], ["closed", "special", 1]);
  const opened = shopStatus(input([special("2026-10-18", false, [["09:00", "13:00"]])]), at("2026-10-18T08:00:00Z")); // Sun 10:00
  assertEquals([opened.state, opened.label], ["open", "special"]);
});

Deno.test("no opening hours (grey)", () => {
  const s = shopStatus(input([], null), at("2026-10-14T08:00:00Z"));
  assertEquals([s.state, s.nextChange], ["no_hours", null]);
  assertEquals(text(input([], {}), "2026-10-14T08:00:00Z"), "Otváracie hodiny neuvedené");
});

Deno.test("automatic holidays off: the database leaves holidays out, the regular hours apply", () => {
  // Same day as the shops-closed test, but no holiday rows (the switch is off) → regular Friday hours.
  assertEquals(shopStatus(input([]), at("2026-12-25T09:00:00Z")).state, "open");
  // and the owner's special hours still win
  assertEquals(shopStatus(input([special("2026-12-25", true)]), at("2026-12-25T09:00:00Z")).state, "closed");
});

Deno.test("daylight-saving change days (last Sunday of March and October)", () => {
  const sunday: OpeningHours = { sun: [["09:00", "18:00"]] };
  // 29 March 2026: 02:00 → 03:00. 01:30 (+1) → opens at 9:00 (+2) = 07:00 UTC.
  const night = shopStatus(input([], sunday), at("2026-03-29T00:30:00Z"));
  assertEquals([night.state, night.nextChange], ["closed", "2026-03-29T07:00:00.000Z"]);
  const day = shopStatus(input([], sunday), at("2026-03-29T08:00:00Z")); // 10:00 (+2)
  assertEquals([day.state, day.nextChange], ["open", "2026-03-29T16:00:00.000Z"]);
  // 25 October 2026: 03:00 → 02:00. 10:00 (+1) = 09:00 UTC; closes 18:00 (+1) = 17:00 UTC.
  const autumn = shopStatus(input([], sunday), at("2026-10-25T09:00:00Z"));
  assertEquals([autumn.state, autumn.nextChange], ["open", "2026-10-25T17:00:00.000Z"]);
  assertEquals(shopStatus(input([], sunday), at("2026-10-25T07:30:00Z")).state, "closed"); // 08:30 (+1)
});

Deno.test("upcoming days and JSON-LD special hours", () => {
  const days = [
    holiday("2026-12-24", "shops_closed", "12:00"),
    holiday("2026-12-25", "shops_closed"),
    holiday("2027-01-06", "day_off"),
    special("2026-12-28", false, [["09:00", "12:00"]]),
  ];
  const list = upcomingDays(input(days), at("2026-12-20T09:00:00Z"), 14);
  assertEquals(list.map((d) => `${d.date}:${d.kind}:${d.closed}:${d.ranges.map((r) => r.join("-")).join(",")}`), [
    "2026-12-24:closed_by_law:false:08:00-12:00",
    "2026-12-25:closed_by_law:true:",
    "2026-12-28:special:false:09:00-12:00",
  ]);
  const spec = specialOpeningHoursSpecification(input(days), at("2026-12-20T09:00:00Z"), 60);
  assertEquals(spec.map((s) => `${s.validFrom} ${s.opens}-${s.closes}`), [
    "2026-12-24 08:00-12:00",
    "2026-12-25 00:00-00:00",
    "2026-12-28 09:00-12:00",
  ]);
});

// The shop page's hours card (2026-11-04): the week list shows this week's real hours, the closed pill only short words.
Deno.test("week list: a special day in the coming 7 days replaces its weekday's row", () => {
  // Wed 14 Oct 2026, 10:00; Thursday 15 Oct special 12:00–17:00, Saturday 17 Oct closed, next Wednesday 21 Oct special
  const days = [special("2026-10-15", false, [["12:00", "17:00"]]), special("2026-10-17", true), special("2026-10-21", false, [["10:00", "11:00"]])];
  const week = weekHours(input(days), at("2026-10-14T08:00:00Z"));
  const row = (d: string) => week.find((w) => w.day === d)!;
  assertEquals(row("thu"), { day: "thu", date: "2026-10-15", ranges: [["12:00", "17:00"]], changed: true });
  assertEquals(row("sat"), { day: "sat", date: "2026-10-17", ranges: [], changed: true });
  // today (Wednesday) is the date in the week; next Wednesday's special day is 7 days away: the regular row stays
  assertEquals(row("wed"), { day: "wed", date: "2026-10-14", ranges: WEEK.wed, changed: false });
  assertEquals(row("mon"), { day: "mon", date: "2026-10-19", ranges: WEEK.mon, changed: false });
  assertEquals(week.map((w) => w.day), ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
});

Deno.test("week list: a day shops must close by law shows what is left; a public day off keeps the regular hours", () => {
  // Sun 20 Dec 2026; Thu 24 Dec closes at 12:00 by law, Fri 25 Dec closed by law, Sat 26 Dec a day off
  const days = [holiday("2026-12-24", "shops_closed", "12:00"), holiday("2026-12-25", "shops_closed"), holiday("2026-12-26", "day_off")];
  const week = weekHours(input(days), at("2026-12-20T09:00:00Z"));
  const row = (d: string) => week.find((w) => w.day === d)!;
  assertEquals([row("thu").ranges, row("thu").changed], [[["08:00", "12:00"]], true]);
  assertEquals([row("fri").ranges, row("fri").changed], [[], true]);
  assertEquals([row("sat").ranges, row("sat").changed], [WEEK.sat, false]);
});

Deno.test("no holidays or special days in the next 14 days: no list in the hours card", () => {
  assertEquals(upcomingDays(input(), at("2026-10-14T08:00:00Z"), 14), []);
  // a special day 15 days away is not in it
  assertEquals(upcomingDays(input([special("2026-10-29", true)]), at("2026-10-14T08:00:00Z"), 14), []);
});

Deno.test("closed pill: only the short words — later today, tomorrow, another day; open stays as it was", () => {
  const labels = sk.status;
  // Wed 12:15 is a break; Wed 17:30 closed → tomorrow 08:00
  assertEquals(closedPillText(shopStatus(input(), at("2026-10-14T15:30:00Z")), labels), "Otvára zajtra");
  // Wed 07:00 (05:00 UTC) closed → today 08:00
  assertEquals(closedPillText(shopStatus(input(), at("2026-10-14T05:00:00Z")), labels), "Otvára o 8:00");
  // Sat 17 Oct 13:00 closed, Sunday closed → Monday
  assertEquals(closedPillText(shopStatus(input(), at("2026-10-17T11:00:00Z")), labels), "Otvára v pondelok");
  // Thursday: "vo štvrtok"
  const thu = { ...WEEK, wed: [], fri: [], sat: [] } as OpeningHours;
  assertEquals(closedPillText(shopStatus(input([], thu), at("2026-10-13T16:00:00Z")), labels), "Otvára vo štvrtok");
  // not closed, or no opening within a week: null (the full words stay)
  assertEquals(closedPillText(shopStatus(input(), at("2026-10-14T08:00:00Z")), labels), null);
  assertEquals(closedPillText(shopStatus(input([], {}), at("2026-10-14T08:00:00Z")), labels), null);
  // the full words stay for the pill's name (aria-label)
  assertEquals(text(input(), "2026-10-14T05:00:00Z"), "Zatvorené · otvára o 8:00");
});
