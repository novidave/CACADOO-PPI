import Link from "next/link";
import type { Locale } from "@/i18n/config";
import { t, type Dictionary } from "@/i18n/dictionaries";
import { displayTime } from "@/lib/hours";
import { adminHref } from "@/lib/adminPages";
import { HEALTH_COLORS } from "@/lib/adminOverview";
import { buttonClass, cardClass, Field, fieldClass, ghostClass, Segmented } from "@/components/owner/ui";
import { deleteHoliday, saveHoliday } from "./actions";
import { DotText, tableBox, tdClass, thClass } from "./common";

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

/** The countries the holiday library has rows for (scripts/holidays.mjs). */
export const HOLIDAY_COUNTRIES = ["SK", "HU", "CZ"] as const;

/**
 * Admin → Sviatky (database update 27; artboard 12 since 2026-11-05): the country as a segmented row (SK · HU · CZ),
 * the year with ‹ ›, "+ Pridať dátum"; the table of the library's rows and the admin's (which always win; struck
 * through = does not count) with "Upraviť" per date; the chosen date (?hdate=, or "new") opens the edit panel on the
 * right: the names in SK / HU / EN, Druh, Zatvorené od, "Uložiť sviatok" and "Odstrániť dátum" (a library row) /
 * "Zrušiť úpravu" (the admin's own). Every read and write is checked by is_admin() in the database (admin_holidays,
 * admin_save_holiday, admin_delete_holiday).
 */
export function HolidaysAdmin({
  rows,
  country,
  year,
  editing,
  lang,
  dict,
  hidden,
}: {
  rows: AdminHoliday[] | null;
  country: string;
  year: number;
  /** The date being edited (YYYY-MM-DD), "new" for a new one, or null. */
  editing: string | null;
  lang: Locale;
  dict: Dictionary;
  hidden: React.ReactNode;
}) {
  const a = dict.admin_domains;
  const h = dict.holidays;
  const countryName = (code: string) => {
    try {
      return new Intl.DisplayNames([lang], { type: "region" }).of(code) ?? code;
    } catch {
      return code;
    }
  };
  const href = (q: Record<string, string | number>, hash = "holidays") =>
    adminHref(lang, "holidays", Object.fromEntries(Object.entries({ hcountry: country, hyear: year, ...q }).map(([k, v]) => [k, String(v)])), hash);
  const day = (date: string, withYear = false) =>
    new Intl.DateTimeFormat(lang, { day: "numeric", month: "numeric", ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
  const nameOf = (row: AdminHoliday) => (lang === "hu" ? row.name_hu : lang === "en" ? row.name_en : row.name_sk) || row.name_sk || row.name_en || "";
  const kindText = (row: { kind: AdminHoliday["kind"]; closed_from: string | null }) =>
    row.kind === "removed"
      ? a.holiday_removed
      : row.kind === "day_off"
        ? a.holiday_day_off
        : row.closed_from
          ? t(a.holiday_closed_at, { time: displayTime(row.closed_from.slice(0, 5)) })
          : a.holiday_closed;
  const kindColor = (kind: AdminHoliday["kind"]) => (kind === "shops_closed" ? HEALTH_COLORS.bad : kind === "day_off" ? HEALTH_COLORS.warn : HEALTH_COLORS.off);
  // the admin's row wins over the library's of the same date
  const chosen = editing && editing !== "new" ? (rows?.find((r) => r.date === editing && r.source === "admin") ?? rows?.find((r) => r.date === editing)) : null;
  const square = "inline-flex size-11 items-center justify-center rounded-xl border border-[#D6D6D6] bg-white text-[#111] no-underline hover:border-[#111]";

  return (
    <section id="holidays" className="flex scroll-mt-4 flex-col gap-4" aria-label={a.holidays_title} data-admin-holidays>
      <div className="flex flex-wrap items-center gap-2.5" data-holiday-controls>
        <nav aria-label={a.holiday_country} className="flex max-w-full gap-1 overflow-x-auto rounded-xl border border-[#D6D6D6] p-1 [scrollbar-width:none]" data-holiday-country>
          {HOLIDAY_COUNTRIES.map((c) => (
            <Link
              key={c}
              href={href({ hcountry: c })}
              aria-current={country === c ? "true" : undefined}
              className={`flex min-h-11 flex-none items-center whitespace-nowrap rounded-[10px] px-3.5 text-[15px] font-bold no-underline ${country === c ? "bg-[#111] text-white" : "text-[#3D3D3D] hover:bg-[#F4F4F4]"}`}
              data-country={c}
            >
              {countryName(c)}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-2" data-holiday-year={year}>
          <Link href={href({ hyear: year - 1 })} aria-label={a.holiday_prev_year} className={square}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M15 6l-6 6 6 6" />
            </svg>
          </Link>
          <strong className="min-w-14 text-center text-lg tabular-nums">{year}</strong>
          <Link href={href({ hyear: year + 1 })} aria-label={a.holiday_next_year} className={square}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M9 6l6 6-6 6" />
            </svg>
          </Link>
        </div>
        <Link href={href({ hdate: "new" }, "holiday-edit")} className={`${ghostClass} !min-h-11 !px-4 !text-[15px] md:ml-auto`} data-holiday-add>
          {a.holiday_add}
        </Link>
      </div>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className={`${cardClass} min-w-0`}>
          {rows === null ? (
            <p className="text-sm text-[#5C5C5C]">{h.unavailable}</p>
          ) : (
            <div className={tableBox}>
              <table className="w-full min-w-[29rem] border-collapse text-[15px]">
                <thead>
                  <tr>
                    <th className={`${thClass} w-20`}>{a.holiday_date}</th>
                    <th className={thClass}>{a.holiday_name}</th>
                    <th className={thClass}>{a.holiday_kind}</th>
                    <th className={thClass}>
                      <span className="sr-only">{a.holiday_edit}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const on = editing === row.date;
                    return (
                      <tr
                        key={`${row.date}-${row.source}`}
                        aria-current={on ? "true" : undefined}
                        className={`${on ? "bg-[#F4F4F4]" : ""} ${row.counts ? "" : "text-[#8A8A8A] line-through"}`}
                        data-holiday-row={`${row.date}:${row.source}`}
                      >
                        <td className={`${tdClass} whitespace-nowrap ${on ? "font-bold" : ""}`}>{day(row.date)}</td>
                        <td className={tdClass}>
                          <span className="flex flex-col gap-0.5">
                            <span className={on ? "font-bold" : ""}>{nameOf(row)}</span>
                            <span className="text-[13px] text-[#5C5C5C]">{row.source === "admin" ? <strong className="text-[#111]">{a.holiday_admin}</strong> : a.holiday_library}</span>
                          </span>
                        </td>
                        <td className={tdClass}>
                          <DotText color={kindColor(row.kind)}>
                            <span className="font-medium">{kindText(row)}</span>
                          </DotText>
                        </td>
                        <td className={`${tdClass} text-right`}>
                          <Link href={href({ hdate: row.date }, "holiday-edit")} className={`${on ? buttonClass : ghostClass} !min-h-11 !px-4 !text-[15px] no-underline`} data-holiday-edit={row.date}>
                            {on ? a.holiday_editing : a.holiday_edit}
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-sm text-[#5C5C5C]">{a.holidays_note}</p>
        </div>

        <section id="holiday-edit" className={`${cardClass} min-w-0 scroll-mt-4`} aria-labelledby="holiday-edit-heading" data-holiday-panel={editing ?? ""}>
          {!editing ? (
            <>
              <h2 id="holiday-edit-heading" className="text-[19px] font-bold">
                {a.holiday_panel_title}
              </h2>
              <p className="text-sm text-[#5C5C5C]">{a.holiday_pick}</p>
            </>
          ) : (
            <>
              <h2 id="holiday-edit-heading" className="text-[19px] font-bold">
                {chosen ? `${nameOf(chosen) || a.holiday_name} · ${day(chosen.date, true)}` : a.holiday_new}
              </h2>
              <form action={saveHoliday} className="flex flex-col gap-3.5" data-holiday-form>
                {hidden}
                <input type="hidden" name="country" value={country} />
                {chosen ? (
                  <input type="hidden" name="date" value={chosen.date} />
                ) : (
                  <Field label={a.holiday_date}>
                    <input type="date" name="date" required min={`${year}-01-01`} max={`${year}-12-31`} className={fieldClass} />
                  </Field>
                )}
                {(["sk", "hu", "en"] as const).map((l) => (
                  <Field key={l} label={t(a.holiday_name_in, { lang: l.toUpperCase() })}>
                    <input name={`name_${l}`} maxLength={120} defaultValue={chosen?.[`name_${l}`] ?? ""} className={fieldClass} />
                  </Field>
                ))}
                <Segmented
                  name="kind"
                  label={a.holiday_kind}
                  value={chosen?.kind === "shops_closed" ? "shops_closed" : "day_off"}
                  options={[
                    { value: "day_off", label: a.holiday_day_off },
                    { value: "shops_closed", label: a.holiday_closed },
                  ]}
                />
                <Field label={a.holiday_closed_from}>
                  <input type="time" name="closed_from" defaultValue={chosen?.closed_from ? chosen.closed_from.slice(0, 5) : ""} className={fieldClass} />
                </Field>
                <p className="text-[13px] text-[#5C5C5C]">{a.holiday_kind_hint}</p>
                <button type="submit" className={buttonClass}>
                  {a.holiday_save}
                </button>
              </form>
              {chosen?.source === "admin" ? (
                <form action={deleteHoliday}>
                  {hidden}
                  <input type="hidden" name="country" value={country} />
                  <input type="hidden" name="date" value={chosen.date} />
                  <button type="submit" className={`${ghostClass} w-full`} data-undo-holiday={chosen.date}>
                    {a.holiday_undo}
                  </button>
                </form>
              ) : chosen ? (
                <form action={saveHoliday}>
                  {hidden}
                  <input type="hidden" name="country" value={country} />
                  <input type="hidden" name="date" value={chosen.date} />
                  <input type="hidden" name="kind" value="removed" />
                  <button type="submit" className={`${ghostClass} w-full`} data-remove-holiday={chosen.date}>
                    {a.holiday_remove}
                  </button>
                </form>
              ) : null}
              <Link href={href({})} className="self-start text-sm font-semibold underline underline-offset-4">
                {dict.admin_home.close}
              </Link>
            </>
          )}
        </section>
      </div>
    </section>
  );
}
