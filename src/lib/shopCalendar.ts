import type { SupabaseClient } from "@supabase/supabase-js";
import { addDays, type CalendarDay, type HolidayKind, type OpeningHours, type StatusInput, validRanges } from "./hours";

interface CalendarRow {
  shop_id: string;
  date: string;
  special_closed: boolean | null;
  special_ranges: unknown;
  special_note: string | null;
  holiday_kind: HolidayKind | null;
  holiday_closed_from: string | null;
  holiday_name_sk: string | null;
  holiday_name_hu: string | null;
  holiday_name_en: string | null;
}

/**
 * The special days and holidays of these shops from yesterday for `days` days (shop_calendar(),
 * database update 27: holidays only for shops with "Automatické štátne sviatky" on). Before the
 * update, or on any error: none (the regular hours alone decide).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the server, browser and public clients all work
export async function loadCalendars(client: SupabaseClient<any, any, any>, shopIds: string[], days = 16): Promise<Map<string, CalendarDay[]>> {
  const out = new Map<string, CalendarDay[]>();
  const ids = [...new Set(shopIds.filter(Boolean))];
  if (ids.length === 0) return out;
  const today = new Date().toISOString().slice(0, 10);
  const from = addDays(today, -1);
  const to = addDays(today, days + 1);
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await client.rpc("shop_calendar", { p_shop_ids: ids.slice(i, i + 200), p_from: from, p_to: to });
    if (error) return out;
    for (const row of (data ?? []) as CalendarRow[]) {
      const list = out.get(row.shop_id) ?? [];
      list.push({
        date: row.date,
        special:
          row.special_closed === null || row.special_closed === undefined
            ? null
            : { closed: row.special_closed, ranges: validRanges(row.special_ranges), note: row.special_note },
        holiday: row.holiday_kind
          ? {
              kind: row.holiday_kind,
              closedFrom: row.holiday_closed_from,
              name: { sk: row.holiday_name_sk, hu: row.holiday_name_hu, en: row.holiday_name_en },
            }
          : null,
      });
      out.set(row.shop_id, list);
    }
  }
  return out;
}

/** What the status of one shop is computed from. */
export function statusInput(
  shop: { id: string; opening_hours: OpeningHours | null; timezone: string | null },
  calendars: Map<string, CalendarDay[]>,
): StatusInput {
  return { hours: shop.opening_hours, timeZone: shop.timezone, days: calendars.get(shop.id) ?? [] };
}
