import "server-only";
import OpeningHours from "opening_hours";
import tzLookup from "@photostructure/tz-lookup";
import type { Dictionary } from "@/i18n/dictionaries";
import { t } from "@/i18n/dictionaries";
import { hoursState, wallClock } from "./sources";

/**
 * Opening hours of a shop nearby as OpenStreetMap writes them ("Mo-Fr 09:00-17:00"), read with the
 * opening_hours library in the town's own time zone (looked up from the town's centre, never from
 * the visitor) and shown as "otvorené do 17:00 (podľa OpenStreetMap)". Nothing when OpenStreetMap
 * has no hours or they cannot be read.
 */

/** The IANA time zone of a point (the town's centre), or null. */
export function townTimeZone(lat: number, lng: number): string | null {
  try {
    return tzLookup(lat, lng);
  } catch {
    return null;
  }
}

export function osmHoursText(
  value: string | null,
  town: { lat: number; lng: number; country: string | null },
  dict: Dictionary,
  now: Date = new Date(),
): { text: string; open: boolean } | null {
  if (!value) return null;
  const timeZone = townTimeZone(town.lat, town.lng);
  if (!timeZone) return null;
  let state;
  try {
    const oh = new OpeningHours(value, { lat: town.lat, lon: town.lng, address: { country_code: (town.country ?? "").toLowerCase(), state: "" } });
    state = hoursState(oh, wallClock(now, timeZone));
  } catch {
    return null;
  }
  if (!state) return null;
  const s = dict.search;
  const hours = state.open
    ? state.next
      ? t(s.open_until, { time: state.next.time })
      : s.open_now
    : state.next
      ? t(state.next.tomorrow ? s.closed_opens_tomorrow : s.closed_opens, { time: state.next.time })
      : s.closed_now;
  return { text: t(s.hours_osm, { hours }), open: state.open };
}

/** "pred 3 h" — how old outside data is, without any time zone. */
export function ageText(iso: string | null | undefined, dict: Dictionary, now: number = Date.now()): string {
  const s = dict.search;
  const at = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(at)) return s.age_now;
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 2) return s.age_now;
  if (minutes < 60) return t(s.age_minutes, { n: minutes });
  if (minutes < 48 * 60) return t(s.age_hours, { n: Math.round(minutes / 60) });
  return t(s.age_days, { n: Math.round(minutes / 1440) });
}
