import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { isLocale, type Locale } from "@/i18n/config";
import { getDictionary, t } from "@/i18n/dictionaries";
import { requireUser } from "@/lib/auth";
import { localMidnight, shopToday } from "@/lib/bookingTools";
import { assistantTabUrl } from "@/lib/dashboardPages";
import { formatDate, utcToLocalInput } from "@/lib/format";
import { addDays, displayTime, rangesFor, validRanges, weekdayOf } from "@/lib/hours";
import { loadSmsUsage, quotaLeft } from "@/lib/smsUsage";
import { DbError } from "@/components/DbError";
import { PendingButton } from "@/components/PendingButton";
import { AssistantTabs, waitingCount } from "../AssistantTabs";
import type { BookingSetup } from "../AssistantSettings";
import { chooseShop } from "../contacts/parts";
import { hiddenFields, inputClass, ProOnly, ShopSwitcher } from "../shared";
import { cancelBooking, createBooking, markBooking, moveBooking } from "./actions";

export async function generateMetadata({ params }: PageProps<"/[lang]/dashboard/bookings">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return { title: (await getDictionary(lang)).bookings.title };
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Booking {
  id: string;
  starts_at: string;
  ends_at: string;
  status: "confirmed" | "done" | "no_show" | "cancelled";
  service_name: string | null;
  resource_name: string | null;
  people: number;
  name: string | null;
  phone: string | null;
  note: string | null;
  contact_id: string | null;
  conversation_id: string | null;
  source: string;
  google_status: string | null;
}

interface CalendarRow {
  special_closed: boolean | null;
  special_ranges: unknown;
  holiday_kind: "day_off" | "shops_closed" | null;
}

/** "+421 911 ··· 207": enough to recognise a number in a list (the contact's page shows it whole). */
const masked = (phone: string | null) => (phone ? `${phone.slice(0, 4)} ${phone.slice(4, 7)} ··· ${phone.slice(-3)}` : "");
const time = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
const minutes = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 60_000);

/**
 * Asistent → Rezervácie (update 63, the Rezervacie screen): Cacaduu's own bookings — they work without any outside
 * calendar. A week strip, the chosen day's opening hours and bookings (service · length · resource, the contact, where it
 * came from), "Presunúť" / "Zrušiť" / "Prišiel" / "Neprišiel" per booking, and "+ Rezervácia": a service and a day → the
 * free times from booking_free_slots (the same rule as the assistant), then a contact or a name and phone. Old addresses
 * (?view=list|calendar) show the day view; ?view=settings goes to Nastavenia.
 */
export default async function BookingsPage({ params, searchParams }: PageProps<"/[lang]/dashboard/bookings">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const sp = await searchParams;
  if (first(sp.view) === "settings") {
    const q = new URLSearchParams({ at: "settings", part: "calendar" });
    for (const k of ["shop", "ok", "err"]) if (first(sp[k])) q.set(k, first(sp[k])!);
    redirect(`/${lang}/dashboard/assistant?${q}#calendar`);
  }
  const [dict, session] = await Promise.all([getDictionary(lang), requireUser(lang)]);
  const { supabase } = session;
  const a = dict.asst;
  const chosen = await chooseShop(supabase, first(sp.shop));
  if (chosen.error) return <DbError message={chosen.error} dict={dict} />;
  const shop = chosen.shop;
  if (!shop) redirect(`/${lang}/dashboard`);
  const tz = shop.timezone;
  const today = shopToday(tz);
  const day = DAY.test(first(sp.day) ?? "") ? first(sp.day)! : today;
  const dow = (new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7;
  const monday = addDays(day, -dow);
  const from = localMidnight(day, tz);
  const to = localMidnight(addDays(day, 1), tz);
  const adding = first(sp.new) === "1";
  const newService = UUID.test(first(sp.service) ?? "") ? first(sp.service)! : "";
  const newDay = DAY.test(first(sp.on) ?? "") ? first(sp.on)! : day;
  const contactId = UUID.test(first(sp.contact) ?? "") ? first(sp.contact)! : "";

  const [plan, list, setupRes, calendarRes, sms, waiting, free] = await Promise.all([
    supabase.rpc("shop_has_plan", { p_shop_id: shop.id }),
    supabase.rpc("owner_booking_list", { p_shop_id: shop.id, p_from: from.toISOString(), p_to: to.toISOString(), p_status: null }),
    supabase.rpc("owner_booking_setup", { p_shop_id: shop.id }),
    supabase.rpc("shop_calendar", { p_shop_ids: [shop.id], p_from: day, p_to: day }),
    loadSmsUsage(supabase, shop.id),
    waitingCount(supabase, shop.id),
    adding && newService
      ? supabase.rpc("owner_booking_free_slots", {
          p_shop_id: shop.id,
          p_service_id: newService,
          p_from: localMidnight(newDay, tz).toISOString(),
          p_to: localMidnight(addDays(newDay, 1), tz).toISOString(),
          p_resource_id: null,
          p_people: 1,
        })
      : Promise.resolve({ data: null, error: null }),
  ]);
  const hasPlan = !plan.error && plan.data === true;
  const setup = setupRes.error ? null : (setupRes.data as BookingSetup);
  const bookings = (list.data ?? []) as Booking[];
  const hidden = hiddenFields(lang, shop);
  const url = (query: Record<string, string>) => `/${lang}/dashboard/bookings?${new URLSearchParams({ shop: shop.slug, ...query })}`;
  const settings = (part: string) => `${assistantTabUrl(lang, "settings", shop.slug, { part })}#${part}`;
  const texts = a as Record<string, string>;
  const ok = first(sp.ok);
  const err = first(sp.err);
  const dayName = (d: string, style: "short" | "long") =>
    new Intl.DateTimeFormat(lang as Locale, { timeZone: "UTC", weekday: style }).format(new Date(`${d}T12:00:00Z`));
  const month = new Intl.DateTimeFormat(lang as Locale, { timeZone: "UTC", month: "long", year: "numeric" }).format(new Date(`${day}T12:00:00Z`));

  // the day's opening hours: a special day > a holiday > the regular hours
  const cal = ((calendarRes.data ?? []) as CalendarRow[])[0];
  const ranges: [string, string][] =
    cal?.special_closed === true
      ? []
      : cal?.special_closed === false
        ? validRanges(cal.special_ranges)
        : cal?.holiday_kind === "shops_closed"
          ? []
          : rangesFor(shop.opening_hours, weekdayOf(day));
  const hoursLine = ranges.length ? t(a.open_ranges, { ranges: ranges.map(([s, e]) => `${displayTime(s)}–${displayTime(e)}`).join(", ") }) : a.closed_day;
  const services = (setup?.services ?? []).filter((s) => s.active);
  const freeSlots = (free.data ?? []) as { starts_at: string; resource_id: string | null; seats_left: number }[];
  const resourceName = (id: string | null) => setup?.resources.find((r) => r.id === id)?.name ?? null;

  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <AssistantTabs lang={lang} dict={dict} shop={shop.slug} current="bookings" waiting={waiting}>
        <ShopSwitcher shops={chosen.shops} current={shop} label={dict.dashboard.shop} href={(slug) => `/${lang}/dashboard/bookings?shop=${slug}`} />
        {chosen.shops.length > 1 && <p className="text-muted">{shop.name}</p>}
        {!hasPlan && <ProOnly dict={dict} href={`/${lang}/dashboard/plan?shop=${shop.slug}`} />}
      </AssistantTabs>

      <section className="flex flex-col gap-3.5" data-tab-panel="bookings">
        <div className="flex items-center justify-between gap-2 rounded-xl border border-line px-3 py-2.5 text-sm">
          <span>
            <strong>{a.bookings_source}</strong>{" "}
            <span className="text-muted">· {setup?.google?.status === "ok" ? a.bookings_google_on : a.bookings_google_optional}</span>
          </span>
          <Link href={settings("calendar")} className="flex min-h-11 flex-none items-center underline underline-offset-4">
            {a.set_up}
          </Link>
        </div>
        {hasPlan && setup && !setup.rules.enabled && (
          <p className="border border-line p-3 text-sm">
            {a.bookings_off}{" "}
            <Link href={settings("rules")} className="underline underline-offset-4">
              {a.tab_settings}
            </Link>
          </p>
        )}
        {hasPlan && setup?.rules.enabled && sms && quotaLeft(sms.booking) === 0 && (
          <p role="alert" className="border border-foreground p-3 text-sm font-semibold" data-booking-paused>
            {t(dict.bookings.sms_paused, { date: formatDate(sms.resets_at, lang, tz) })}
          </p>
        )}
        {ok && texts[ok] && <p role="status" className="border border-foreground p-3 font-medium">{texts[ok]}</p>}
        {err && <p role="alert" className="border border-line p-3">{texts[err] ?? (dict.bookings as Record<string, string>)[err] ?? a.err_failed}</p>}

        <div className="flex items-center justify-between gap-2">
          <h2 className="text-[17px] font-bold first-letter:uppercase">{month}</h2>
          {hasPlan && (
            <Link href={url({ day, new: "1", on: day })} className="flex min-h-11 items-center rounded-[10px] border border-foreground bg-foreground px-4 text-[15px] font-semibold text-white" data-booking-add>
              {a.booking_add}
            </Link>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          <Link href={url({ day: addDays(monday, -7) })} aria-label={dict.bookings.prev_week} className="flex h-14 w-8 flex-none items-center justify-center">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
          </Link>
          <nav aria-label={a.day_picker} className="flex flex-1 gap-1.5">
            {Array.from({ length: 7 }, (_, i) => addDays(monday, i)).map((d) => (
              <Link
                key={d}
                href={url({ day: d })}
                aria-current={d === day ? "date" : undefined}
                className={`flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 rounded-[10px] border text-[13px] font-semibold ${
                  d === day ? "border-foreground bg-foreground text-white" : d === today ? "border-foreground" : "border-line"
                }`}
              >
                <span>{dayName(d, "short")}</span>
                <span className="text-base">{Number(d.slice(8))}</span>
              </Link>
            ))}
          </nav>
          <Link href={url({ day: addDays(monday, 7) })} aria-label={dict.bookings.next_week} className="flex h-14 w-8 flex-none items-center justify-center">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M9 18l6-6-6-6" /></svg>
          </Link>
        </div>
        <p className="text-[13px] text-muted">
          <span className="first-letter:uppercase">{dayName(day, "long")}</span> {formatDate(`${day}T12:00:00Z`, lang, "UTC")} · {hoursLine}
        </p>

        {adding && hasPlan && (
          <section className="flex flex-col gap-3 rounded-xl border-2 border-foreground p-4" data-booking-new>
            <h3 className="text-[17px] font-bold">{a.booking_new_title}</h3>
            {services.length === 0 ? (
              <p className="text-sm">
                {a.services_none}{" "}
                <Link href={settings("services")} className="underline underline-offset-4">
                  {a.tab_settings}
                </Link>
              </p>
            ) : (
              <>
                <form method="get" action={`/${lang}/dashboard/bookings`} className="flex flex-col gap-3">
                  <input type="hidden" name="shop" value={shop.slug} />
                  <input type="hidden" name="day" value={day} />
                  <input type="hidden" name="new" value="1" />
                  {contactId && <input type="hidden" name="contact" value={contactId} />}
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <label className="flex flex-col gap-1 text-sm">
                      {a.booking_service}
                      <select name="service" defaultValue={newService} required className={`${inputClass} min-h-11 bg-white text-[15px]`}>
                        <option value="" disabled>
                          {a.choose}
                        </option>
                        {services.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name} · {t(a.minutes, { n: s.duration })}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                      {a.booking_day}
                      <input type="date" name="on" defaultValue={newDay} required className={`${inputClass} min-h-11 text-[15px]`} />
                    </label>
                  </div>
                  <button type="submit" className="min-h-11 self-start rounded-[10px] border border-line bg-white px-4 text-[15px] font-semibold">
                    {a.booking_show_times}
                  </button>
                </form>
                {newService && (
                  <form action={createBooking} className="flex flex-col gap-3 border-t border-line pt-3">
                    {hidden({ day, service_id: newService, ...(contactId ? { contact_id: contactId } : {}) })}
                    {free.error ? (
                      <p className="text-sm">{a.err_failed}</p>
                    ) : freeSlots.length === 0 ? (
                      <p className="text-sm font-semibold">{a.booking_no_times}</p>
                    ) : (
                      <fieldset className="flex flex-col gap-2">
                        <legend className="mb-1 text-sm">{a.booking_time}</legend>
                        <div className="flex flex-wrap gap-2">
                          {freeSlots.slice(0, 60).map((s, i) => (
                            <label key={`${s.starts_at}-${s.resource_id ?? ""}`} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-[10px] border border-line px-3 text-[15px] has-[:checked]:border-foreground has-[:checked]:font-semibold">
                              <input type="radio" name="starts_at" value={s.starts_at} required defaultChecked={i === 0} className="accent-foreground" />
                              {time(s.starts_at, tz)}
                              {resourceName(s.resource_id) && <span className="text-[13px] text-muted">· {resourceName(s.resource_id)}</span>}
                            </label>
                          ))}
                        </div>
                      </fieldset>
                    )}
                    {!contactId && (
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <label className="flex flex-col gap-1 text-sm">
                          {a.booking_name}
                          <input name="name" required maxLength={120} autoComplete="off" className={`${inputClass} min-h-11 text-[15px]`} />
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                          {a.booking_phone}
                          <input name="phone" type="tel" maxLength={40} autoComplete="off" className={`${inputClass} min-h-11 text-[15px]`} />
                        </label>
                      </div>
                    )}
                    {contactId && <p className="text-sm text-muted">{a.booking_for_contact}</p>}
                    <label className="flex flex-col gap-1 text-sm">
                      {a.booking_note}
                      <input name="note" maxLength={500} className={`${inputClass} min-h-11 text-[15px]`} />
                    </label>
                    {freeSlots.length > 0 && <PendingButton pending={dict.owner.saving}>{a.booking_save}</PendingButton>}
                  </form>
                )}
              </>
            )}
            <Link href={url({ day })} className="flex min-h-11 items-center self-start text-sm underline underline-offset-4">
              {a.cancel}
            </Link>
          </section>
        )}

        {list.error ? (
          <p className="text-sm text-muted">{dict.bookings.unavailable}</p>
        ) : bookings.length === 0 ? (
          <p className="border-t border-line pt-3 text-sm text-muted">{a.day_none}</p>
        ) : (
          <ul className="flex flex-col border-t border-line" data-booking-list>
            {bookings.map((x) => {
              const live = x.status === "confirmed";
              return (
                <li key={x.id} className={`grid grid-cols-[56px_1fr] gap-3 border-b border-line py-3 ${live ? "" : "text-muted"}`} data-booking={x.status}>
                  <strong className={`text-[15px] ${live ? "" : "line-through"}`}>{time(x.starts_at, tz)}</strong>
                  <div className="flex min-w-0 flex-col gap-1">
                    <strong className="text-[15px]">
                      {[x.service_name ?? dict.bookings.title, t(a.minutes, { n: minutes(x.starts_at, x.ends_at) }), x.resource_name].filter(Boolean).join(" · ")}
                      {x.people > 1 ? ` · ${t(a.people_n, { n: x.people })}` : ""}
                    </strong>
                    {x.contact_id ? (
                      <Link href={`/${lang}/dashboard/contacts/${x.contact_id}?tab=bookings`} className="text-sm underline underline-offset-4">
                        {[x.name, masked(x.phone)].filter(Boolean).join(" · ")}
                      </Link>
                    ) : (
                      <span className="text-sm">{[x.name, masked(x.phone)].filter(Boolean).join(" · ")}</span>
                    )}
                    {x.note && <span className="whitespace-pre-line break-words text-[13px] text-muted">{x.note}</span>}
                    <div className="flex flex-wrap gap-1.5">
                      <span className="inline-flex h-[22px] items-center rounded-md border border-line px-2 text-xs font-semibold">
                        {x.source === "assistant" ? a.source_assistant : x.source === "api" ? a.source_api : x.source === "app" ? a.source_app : a.source_owner}
                      </span>
                      {!live && <span className="inline-flex h-[22px] items-center rounded-md border border-foreground px-2 text-xs font-bold">{texts[`status_${x.status}`] ?? x.status}</span>}
                      {x.google_status === "failed" && <span className="inline-flex h-[22px] items-center rounded-md border border-line px-2 text-xs font-semibold">{dict.bookings.google_failed}</span>}
                      {x.conversation_id && (
                        <Link href={`/${lang}/dashboard/conversations/${x.conversation_id}`} className="inline-flex h-[22px] items-center text-xs underline underline-offset-4">
                          {dict.bookings.conversation}
                        </Link>
                      )}
                    </div>
                    {live && hasPlan && (
                      <div className="mt-1 flex flex-wrap gap-2">
                        <details className="w-full" data-booking-move>
                          <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold underline underline-offset-4">{a.move}</summary>
                          <form action={moveBooking} className="mt-2 flex flex-wrap items-end gap-2">
                            {hidden({ day, booking_id: x.id, timezone: tz })}
                            <label className="flex flex-col gap-1 text-sm">
                              {a.move_to}
                              <input type="datetime-local" name="to" required defaultValue={utcToLocalInput(x.starts_at, tz)} className={`${inputClass} min-h-11`} />
                            </label>
                            <PendingButton pending={dict.owner.saving}>{a.move_save}</PendingButton>
                          </form>
                          <p className="mt-1 text-[13px] text-muted">{a.move_hint}</p>
                        </details>
                        {(
                          [
                            { action: markBooking, label: a.mark_done, extra: { status: "done" } },
                            { action: markBooking, label: a.mark_no_show, extra: { status: "no_show" } },
                            { action: cancelBooking, label: a.cancel_booking, extra: {} },
                          ] as { action: (f: FormData) => Promise<void>; label: string; extra: Record<string, string> }[]
                        ).map((b) => (
                          <form key={b.label} action={b.action}>
                            {hidden({ day, booking_id: x.id, ...b.extra })}
                            <button type="submit" className="min-h-11 rounded-[10px] border border-line bg-white px-3 text-sm font-semibold">
                              {b.label}
                            </button>
                          </form>
                        ))}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <p className="text-[13px] text-muted">{a.bookings_footer}</p>
      </section>
    </div>
  );
}

