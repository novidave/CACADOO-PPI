import type { Locale } from "@/i18n/config";
import { t, type Dictionary } from "@/i18n/dictionaries";
import { displayTime } from "@/lib/hours";
import { deleteHoliday, saveHoliday } from "./actions";

export interface AdminHoliday {
  date: string;
  name_sk: string | null;
  name_hu: string | null;
  name_en: string | null;
  kind: "day_off" | "shops_closed" | "removed";
  closed_from: string | null;
  source: "library" | "admin";
  counts: boolean;
}

const input = "rounded border border-line px-2 py-1 outline-none focus:border-foreground";

/**
 * "Sviatky" on the admin page: one country and year, the library's rows and the admin's (which
 * always win), with add / change / remove. Every read and write is checked by is_admin() in
 * the database (admin_holidays, admin_save_holiday, admin_delete_holiday).
 */
export function HolidaysAdmin({
  rows,
  country,
  year,
  lang,
  dict,
  hidden,
  keep,
}: {
  rows: AdminHoliday[] | null;
  country: string;
  year: number;
  lang: Locale;
  dict: Dictionary;
  hidden: React.ReactNode;
  keep: string;
}) {
  const a = dict.admin_domains;
  const h = dict.holidays;
  const kindText = (row: { kind: AdminHoliday["kind"]; closed_from: string | null }) =>
    row.kind === "removed"
      ? a.holiday_removed
      : row.kind === "day_off"
        ? h.kind_day_off
        : row.closed_from
          ? t(h.kind_closed_from, { time: displayTime(row.closed_from) })
          : h.kind_shops_closed;
  const params = new URLSearchParams(keep.startsWith("?") ? keep.slice(1) : keep);
  return (
    <section id="holidays" className="flex flex-col gap-3" aria-labelledby="holidays-heading" data-admin-holidays>
      <h2 id="holidays-heading" className="text-lg font-semibold">
        {a.holidays_title}
      </h2>
      <p className="text-sm text-muted">{a.holidays_note}</p>
      <form method="get" className="flex flex-wrap items-end gap-2 text-sm">
        {[...params.entries()].filter(([k]) => k !== "hcountry" && k !== "hyear").map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        <label className="flex flex-col gap-1">
          <span>{a.holiday_country}</span>
          <input name="hcountry" defaultValue={country} maxLength={2} className={`${input} w-16 uppercase`} />
        </label>
        <label className="flex flex-col gap-1">
          <span>{a.holiday_year}</span>
          <input name="hyear" inputMode="numeric" defaultValue={String(year)} className={`${input} w-20`} />
        </label>
        <button type="submit" className="rounded border border-line px-3 py-1">
          {a.filter_button}
        </button>
      </form>
      {rows === null ? (
        <p className="text-sm text-muted">{h.unavailable}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left">
                <th className="py-1 pr-3 font-semibold">{a.holiday_date}</th>
                <th className="py-1 pr-3 font-semibold">{a.holiday_name}</th>
                <th className="py-1 pr-3 font-semibold">{a.holiday_kind}</th>
                <th className="py-1 pr-3 font-semibold">{a.holiday_source}</th>
                <th className="py-1 font-semibold" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.date}-${row.source}`} className={`border-b border-line ${row.counts ? "" : "text-muted line-through"}`} data-holiday-row={`${row.date}:${row.source}`}>
                  <td className="whitespace-nowrap py-1 pr-3">{new Intl.DateTimeFormat(lang, { day: "numeric", month: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(`${row.date}T12:00:00Z`))}</td>
                  <td className="py-1 pr-3">{(lang === "hu" ? row.name_hu : lang === "en" ? row.name_en : row.name_sk) || row.name_sk || row.name_en}</td>
                  <td className="py-1 pr-3">{kindText(row)}</td>
                  <td className="py-1 pr-3">{row.source === "admin" ? a.holiday_admin : a.holiday_library}</td>
                  <td className="py-1">
                    {row.source === "admin" ? (
                      <form action={deleteHoliday}>
                        {hidden}
                        <input type="hidden" name="country" value={country} />
                        <input type="hidden" name="date" value={row.date} />
                        <button type="submit" className="underline underline-offset-4">
                          {a.holiday_undo}
                        </button>
                      </form>
                    ) : (
                      <form action={saveHoliday}>
                        {hidden}
                        <input type="hidden" name="country" value={country} />
                        <input type="hidden" name="date" value={row.date} />
                        <input type="hidden" name="kind" value="removed" />
                        <button type="submit" className="underline underline-offset-4" data-remove-holiday={row.date}>
                          {a.holiday_remove}
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form action={saveHoliday} className="flex flex-wrap items-end gap-2 border-t border-line pt-3 text-sm" data-holiday-form>
        {hidden}
        <input type="hidden" name="country" value={country} />
        <label className="flex flex-col gap-1">
          <span>{a.holiday_date}</span>
          <input type="date" name="date" required className={input} />
        </label>
        <label className="flex flex-col gap-1">
          <span>{a.holiday_kind}</span>
          <select name="kind" className={`${input} bg-white`} defaultValue="day_off">
            <option value="day_off">{h.kind_day_off}</option>
            <option value="shops_closed">{h.kind_shops_closed}</option>
            <option value="removed">{a.holiday_removed}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span>{a.holiday_closed_from}</span>
          <input type="time" name="closed_from" className={input} />
        </label>
        {(["sk", "hu", "en"] as const).map((l) => (
          <label key={l} className="flex flex-col gap-1">
            <span>{t(a.holiday_name_in, { lang: l.toUpperCase() })}</span>
            <input name={`name_${l}`} maxLength={120} className={`${input} w-40`} />
          </label>
        ))}
        <button type="submit" className="rounded border border-foreground px-3 py-1 font-medium">
          {a.holiday_save}
        </button>
      </form>
    </section>
  );
}
