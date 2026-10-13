import type { Locale } from "@/i18n/config";
import { t, type Dictionary } from "@/i18n/dictionaries";
import { addDays, displayTime, localDateTime, validRanges } from "@/lib/hours";
import type { MyShop } from "@/lib/myShops";
import { PendingButton } from "@/components/PendingButton";
import { deleteSpecialHours, holidayChoice, saveSpecialHours, setAutoHolidays } from "./holidayActions";
import type { Supabase } from "./ShopDocuments";

interface SpecialRow {
  date: string;
  closed: boolean;
  ranges: unknown;
  note: string | null;
}

interface HolidayRow {
  date: string;
  name_sk: string | null;
  name_hu: string | null;
  name_en: string | null;
  kind: "day_off" | "shops_closed";
  closed_from: string | null;
}

export interface HolidaysData {
  auto: boolean;
  today: string;
  specials: { date: string; closed: boolean; ranges: [string, string][]; note: string | null }[];
  holidays: HolidayRow[];
}

/**
 * The shop's "Automatické štátne sviatky" switch, its special days (from a week ago on) and
 * the public holidays of its country for the next 60 days. null before database update 27.
 */
export async function loadHolidays(supabase: Supabase, shop: MyShop): Promise<HolidaysData | null> {
  const today = localDateTime(new Date(), shop.timezone).date;
  const [auto, specials, holidays] = await Promise.all([
    supabase.from("shops").select("auto_holidays").eq("id", shop.id).maybeSingle(),
    supabase
      .from("shop_special_hours")
      .select("date, closed, ranges, note")
      .eq("shop_id", shop.id)
      .gte("date", addDays(today, -7))
      .order("date"),
    shop.country
      ? supabase.rpc("holidays_between", { p_country: shop.country, p_from: today, p_to: addDays(today, 60) })
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (auto.error || specials.error) return null;
  return {
    auto: (auto.data as { auto_holidays?: boolean } | null)?.auto_holidays !== false,
    today,
    specials: ((specials.data ?? []) as SpecialRow[]).map((r) => ({ date: r.date, closed: r.closed, ranges: validRanges(r.ranges), note: r.note })),
    holidays: holidays.error ? [] : ((holidays.data ?? []) as HolidayRow[]),
  };
}

export function holidaysSummary(data: HolidaysData | null, dict: Dictionary): string {
  if (!data) return dict.holidays.unavailable;
  const upcoming = data.specials.filter((s) => s.date >= data.today).length;
  return t(dict.holidays.summary, { state: data.auto ? dict.holidays.auto_on : dict.holidays.auto_off, n: upcoming });
}

const inputClass = "rounded border border-line px-3 py-2 outline-none focus:border-foreground";
const hoursText = (ranges: [string, string][]) => ranges.map(([a, b]) => `${displayTime(a)}–${displayTime(b)}`).join(", ");

/** Môj obchod → "Sviatky a mimoriadne zatvorenie" (every shop, free or paid). */
export function Holidays({
  data,
  shop,
  lang,
  dict,
  hidden,
  notice,
  editDate,
}: {
  data: HolidaysData | null;
  shop: MyShop;
  lang: Locale;
  dict: Dictionary;
  hidden: (extra?: Record<string, string>) => React.ReactNode;
  notice: React.ReactNode;
  /** ?date=…: the add form opens with that date (the holiday's "Iné hodiny" or "Upraviť"). */
  editDate: string | null;
}) {
  const h = dict.holidays;
  if (!data) return <p className="text-sm text-muted">{h.unavailable}</p>;
  const dateText = (date: string) =>
    new Intl.DateTimeFormat(lang, { weekday: "short", day: "numeric", month: "numeric", year: "numeric", timeZone: "UTC" }).format(
      new Date(`${date}T12:00:00Z`),
    );
  const edit = editDate ? data.specials.find((s) => s.date === editDate) ?? null : null;
  const holidayName = (row: HolidayRow) => (lang === "hu" ? row.name_hu : lang === "en" ? row.name_en : row.name_sk) || row.name_en || row.name_sk || "";
  const special = (date: string) => data.specials.find((s) => s.date === date) ?? null;
  const specialText = (s: { closed: boolean; ranges: [string, string][] }) => (s.closed ? h.mode_closed : hoursText(s.ranges));

  return (
    <div className="flex flex-col gap-5" data-holidays>
      {notice}

      {/* The switch: holidays shown automatically, or the regular hours on every day. */}
      <form action={setAutoHolidays} className="flex flex-col gap-2 border border-line p-3">
        {hidden({ at: "holidays" })}
        <label className="flex items-center gap-2 font-semibold">
          <input type="checkbox" name="auto" defaultChecked={data.auto} data-auto-holidays />
          {h.auto}
        </label>
        <p className="text-sm text-muted">{h.auto_text}</p>
        <PendingButton pending={dict.owner.saving}>{h.save}</PendingButton>
      </form>

      {/* A special day or a date range. */}
      <form action={saveSpecialHours} className="flex flex-col gap-3" id="special-form" data-special-form>
        {hidden({ at: "holidays" })}
        <h3 className="font-semibold">{edit ? h.edit_title : h.add_title}</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-sm">{h.from}</span>
            <input type="date" name="from" required min={addDays(data.today, -1)} defaultValue={editDate ?? ""} className={inputClass} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-sm">{h.to}</span>
            <input type="date" name="to" min={addDays(data.today, -1)} className={inputClass} />
          </label>
        </div>
        <fieldset className="flex flex-col gap-2">
          <label className="flex items-center gap-2">
            <input type="radio" name="mode" value="closed" defaultChecked={!editDate || Boolean(edit?.closed)} />
            {h.mode_closed}
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="mode" value="hours" defaultChecked={Boolean(editDate) && !edit?.closed} />
            {h.mode_hours}
          </label>
          <div className="flex flex-col gap-2 pl-6 text-sm">
            {[1, 2].map((n) => (
              <span key={n} className="flex flex-wrap items-center gap-1">
                <span className="w-full sm:w-auto">{n === 1 ? h.range1 : h.range2}</span>
                <input
                  type="time"
                  name={`r${n}_from`}
                  defaultValue={edit && !edit.closed ? (edit.ranges[n - 1]?.[0] ?? "") : n === 1 ? "08:00" : ""}
                  aria-label={`${n === 1 ? h.range1 : h.range2} ${h.from_time}`}
                  className="rounded border border-line px-1 py-0.5"
                />
                –
                <input
                  type="time"
                  name={`r${n}_to`}
                  defaultValue={edit && !edit.closed ? (edit.ranges[n - 1]?.[1] ?? "") : n === 1 ? "12:00" : ""}
                  aria-label={`${n === 1 ? h.range1 : h.range2} ${h.to_time}`}
                  className="rounded border border-line px-1 py-0.5"
                />
              </span>
            ))}
          </div>
        </fieldset>
        <label className="flex flex-col gap-1">
          <span className="text-sm">{h.note}</span>
          <input name="note" maxLength={100} defaultValue={edit?.note ?? ""} className={inputClass} />
        </label>
        <PendingButton pending={dict.owner.saving}>{h.save_special}</PendingButton>
      </form>

      {/* The shop's special days (past ones disappear after 7 days). */}
      <section className="flex flex-col gap-2" aria-labelledby="specials-heading">
        <h3 id="specials-heading" className="font-semibold">
          {h.list_title}
        </h3>
        {data.specials.length === 0 ? (
          <p className="text-sm text-muted">{h.none}</p>
        ) : (
          <ul className="divide-y divide-line border-y border-line text-sm">
            {data.specials.map((s) => (
              <li key={s.date} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2" data-special={s.date}>
                <span className="capitalize">{dateText(s.date)}</span>
                <span className="font-semibold">{specialText(s)}</span>
                {s.note && <span className="text-muted">{s.note}</span>}
                <span className="ml-auto flex gap-3">
                  <a
                    href={`/${lang}/dashboard?${new URLSearchParams({ shop: shop.slug, at: "holidays", date: s.date })}#special-form`}
                    className="underline underline-offset-4"
                  >
                    {h.edit}
                  </a>
                  <form action={deleteSpecialHours}>
                    {hidden({ at: "holidays", date: s.date })}
                    <button type="submit" className="underline underline-offset-4" data-delete-special={s.date}>
                      {h.delete}
                    </button>
                  </form>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* The country's public holidays: one choice per date (only with the switch on). */}
      {data.auto ? (
        <section className="flex flex-col gap-2" aria-labelledby="public-holidays-heading">
          <h3 id="public-holidays-heading" className="font-semibold">
            {h.holidays_title}
          </h3>
          {data.holidays.length === 0 ? (
            <p className="text-sm text-muted">{h.holidays_none}</p>
          ) : (
            <ul className="divide-y divide-line border-y border-line text-sm">
              {data.holidays.map((row) => {
                const mine = special(row.date);
                return (
                  <li key={row.date} className="flex flex-col gap-1 py-2" data-holiday={row.date}>
                    <span className="flex flex-wrap gap-x-2">
                      <span className="capitalize">{dateText(row.date)}</span>
                      <span className="font-semibold">{holidayName(row)}</span>
                    </span>
                    <span className="text-muted">
                      {row.kind === "day_off"
                        ? h.kind_day_off
                        : row.closed_from
                          ? t(h.kind_closed_from, { time: displayTime(row.closed_from) })
                          : h.kind_shops_closed}
                    </span>
                    {mine && <span className="font-semibold">{t(h.yours, { hours: specialText(mine) })}</span>}
                    <span className="flex flex-wrap gap-2">
                      {(["usual", "closed"] as const).map((choice) => (
                        <form key={choice} action={holidayChoice}>
                          {hidden({ at: "holidays", date: row.date, choice })}
                          <button type="submit" className="rounded border border-line px-2 py-1" data-choice={choice}>
                            {choice === "usual" ? h.usual : h.closed}
                          </button>
                        </form>
                      ))}
                      <a
                        href={`/${lang}/dashboard?${new URLSearchParams({ shop: shop.slug, at: "holidays", date: row.date })}#special-form`}
                        className="rounded border border-line px-2 py-1"
                        data-choice="other"
                      >
                        {h.other}
                      </a>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ) : (
        <p className="border border-line p-3 text-sm">{h.auto_off_note}</p>
      )}
    </div>
  );
}
