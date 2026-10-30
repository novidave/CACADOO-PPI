import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { isLocale, type Locale } from "@/i18n/config";
import { getDictionary, t, type Dictionary } from "@/i18n/dictionaries";
import { requireUser } from "@/lib/auth";
import { DbError } from "@/components/DbError";
import { PendingButton } from "@/components/PendingButton";
import { SmsUsage } from "@/components/SmsUsage";
import { formatDate } from "@/lib/format";
import { loadSmsUsage, quotaLeft } from "@/lib/smsUsage";
import { hiddenFields, inputClass, ProOnly, ShopSwitcher } from "../shared";
import { chooseShop } from "../contacts/parts";
import { connectGoogle, disconnectGoogle, saveBookingSettings, setBookingStatus } from "./actions";

export async function generateMetadata({ params }: PageProps<"/[lang]/dashboard/bookings">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return { title: (await getDictionary(lang)).bookings.title };
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const VIEWS = ["list", "calendar", "settings"] as const;
type View = (typeof VIEWS)[number];
const STATUSES = ["confirmed", "cancelled", "no_show"] as const;

interface Booking {
  id: string;
  starts_at: string;
  ends_at: string;
  status: "confirmed" | "cancelled" | "no_show";
  service_name: string | null;
  name: string;
  phone: string;
  email: string | null;
  address: string | null;
  note: string | null;
  contact_id: string | null;
  conversation_id: string | null;
  google_status: "none" | "created" | "failed";
  reminder_sent_at: string | null;
}

interface Settings {
  enabled: boolean;
  service_name: string | null;
  duration_minutes: number;
  step_minutes: number;
  buffer_minutes: number;
  lead_minutes: number;
  horizon_days: number;
  reminder: boolean;
}

/** "2026-11-10" of an instant in the shop's time zone. */
const localDay = (date: Date, timeZone: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** The Monday of a day's week. */
const monday = (day: string) => {
  const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
  return addDays(day, -((dow + 6) % 7));
};

/**
 * "Rezervácie" (database update 57, CRM phase 3; Pro): the bookings made through the shop assistant — a list (from today
 * on, by status), a week calendar, and the settings (on/off, what and how long, the Google Calendar, the day-before
 * reminder SMS). Potvrdená / Zrušená / Neprišiel per booking; the database decides every rule.
 */
export default async function BookingsPage({ params, searchParams }: PageProps<"/[lang]/dashboard/bookings">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const sp = await searchParams;
  const [dict, session] = await Promise.all([getDictionary(lang), requireUser(lang)]);
  const { supabase } = session;
  const b = dict.bookings;
  const chosen = await chooseShop(supabase, first(sp.shop));
  if (chosen.error) return <DbError message={chosen.error} dict={dict} />;
  const shop = chosen.shop;
  if (!shop) redirect(`/${lang}/dashboard`);
  const view: View = VIEWS.includes(first(sp.view) as View) ? (first(sp.view) as View) : "list";
  const tz = shop.timezone;
  const today = localDay(new Date(), tz);
  const week = monday(DAY.test(first(sp.week) ?? "") ? first(sp.week)! : today);
  const status = STATUSES.includes(first(sp.status) as (typeof STATUSES)[number]) ? first(sp.status)! : "";

  const [plan, settingsRes, googleRes, list, sms] = await Promise.all([
    supabase.rpc("shop_has_plan", { p_shop_id: shop.id }),
    supabase.from("shop_booking_settings").select("*").eq("shop_id", shop.id).maybeSingle<Settings>(),
    supabase.from("booking_google_connections").select("status, last_error, connected_at").eq("shop_id", shop.id).maybeSingle(),
    view === "settings"
      ? Promise.resolve({ data: [], error: null })
      : supabase.rpc("owner_bookings", {
          p_shop_id: shop.id,
          p_from: view === "calendar" ? week : today,
          p_to: view === "calendar" ? addDays(week, 6) : null,
          p_status: view === "calendar" ? null : status || null,
          p_limit: 300,
          p_offset: 0,
        }),
    // The booking's SMS this month (database update 58): at the limit the assistant offers no times.
    loadSmsUsage(supabase, shop.id),
  ]);
  const hasPlan = !plan.error && plan.data === true;
  const unavailable = Boolean(settingsRes.error || list.error);
  const bookings = (list.data ?? []) as Booking[];
  const settings = settingsRes.data ?? null;
  const google = googleRes.error ? null : (googleRes.data as { status: string; last_error: string | null; connected_at: string } | null);
  const hidden = hiddenFields(lang, shop);
  const url = (query: Record<string, string>) => `/${lang}/dashboard/bookings?${new URLSearchParams({ shop: shop.slug, ...query })}`;
  const labels: Record<View, string> = { list: b.tab_list, calendar: b.tab_calendar, settings: b.tab_settings };
  const notice = (() => {
    const texts = b as Record<string, string>;
    const ok = first(sp.ok);
    const err = first(sp.err);
    if (ok && texts[ok]) return <p role="status" className="border border-foreground p-3 font-medium">{texts[ok]}</p>;
    if (err) return <p className="border border-line p-3">{texts[err] ?? texts.err_failed}</p>;
    return null;
  })();

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{b.title}</h1>
        <ShopSwitcher shops={chosen.shops} current={shop} label={dict.dashboard.shop} href={(slug) => `/${lang}/dashboard/bookings?shop=${slug}`} />
        <p className="text-muted">{shop.name}</p>
        <p className="text-sm">{b.intro}</p>
        {!hasPlan && <ProOnly dict={dict} href={`/${lang}/dashboard/plan?shop=${shop.slug}`} />}
        {settings && !settings.enabled && hasPlan && view !== "settings" && (
          <p className="border border-line p-3 text-sm">
            {b.off}{" "}
            <Link href={url({ view: "settings" })} className="underline underline-offset-4">
              {b.tab_settings}
            </Link>
          </p>
        )}
        {hasPlan && settings?.enabled && sms && quotaLeft(sms.booking) === 0 && (
          <p role="alert" className="border border-foreground p-3 text-sm font-semibold" data-booking-paused>
            {t(b.sms_paused, { date: formatDate(sms.resets_at, lang, tz) })}
          </p>
        )}
        {notice}
        {hasPlan && sms && view === "settings" && <SmsUsage usage={sms} lang={lang} timeZone={tz} dict={dict} only="booking" />}
      </header>

      <nav aria-label={b.tabs} className="flex flex-wrap gap-1 border-b border-line" data-booking-tabs>
        {VIEWS.map((to) => (
          <Link
            key={to}
            href={url(to === "list" ? {} : { view: to })}
            aria-current={view === to ? "page" : undefined}
            className={`-mb-px flex min-h-11 items-center border-b-2 px-3 text-sm ${view === to ? "border-foreground font-semibold" : "border-transparent text-muted"}`}
            data-tab={to}
          >
            {labels[to]}
          </Link>
        ))}
      </nav>

      {unavailable ? (
        <p className="text-sm text-muted">{b.unavailable}</p>
      ) : view === "settings" ? (
        <SettingsView dict={dict} settings={settings} google={google} hidden={hidden} hasPlan={hasPlan} />
      ) : view === "calendar" ? (
        <section className="flex flex-col gap-3" data-tab-panel="calendar">
          <nav className="flex items-center justify-between text-sm">
            <Link href={url({ view: "calendar", week: addDays(week, -7) })} className="min-h-11 py-2 underline underline-offset-4">
              {b.prev_week}
            </Link>
            <span className="font-medium">
              {formatDay(week, lang)} – {formatDay(addDays(week, 6), lang)}
            </span>
            <Link href={url({ view: "calendar", week: addDays(week, 7) })} className="min-h-11 py-2 underline underline-offset-4">
              {b.next_week}
            </Link>
          </nav>
          <ol className="grid grid-cols-1 gap-2 sm:grid-cols-7" data-week={week}>
            {Array.from({ length: 7 }, (_, i) => addDays(week, i)).map((day) => {
              const items = bookings.filter((x) => localDay(new Date(x.starts_at), tz) === day);
              return (
                <li key={day} className={`flex min-h-24 flex-col gap-1 border p-2 ${day === today ? "border-foreground" : "border-line"}`} data-day={day}>
                  <span className={`text-xs ${day === today ? "font-semibold" : "text-muted"}`}>{formatDay(day, lang, true)}</span>
                  {items.length === 0 ? (
                    <span className="text-xs text-muted">–</span>
                  ) : (
                    items.map((x) => (
                      <span key={x.id} className={`text-xs ${x.status === "confirmed" ? "" : "text-muted line-through"}`} data-calendar-booking={x.status}>
                        <span className="font-semibold">{time(x.starts_at, tz)}</span> {x.name}
                        <span className="sr-only"> · {statusText(x.status, dict)}</span>
                      </span>
                    ))
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      ) : (
        <section className="flex flex-col gap-3" data-tab-panel="list">
          <nav className="flex flex-wrap gap-x-3 gap-y-1 text-sm" aria-label={b.status}>
            {(["", ...STATUSES] as const).map((s) => (
              <Link key={s || "all"} href={url(s ? { status: s } : {})} aria-current={status === s ? "page" : undefined} className={status === s ? "font-semibold underline underline-offset-4" : "text-muted"}>
                {s ? statusText(s, dict) : b.status_all}
              </Link>
            ))}
          </nav>
          {bookings.length === 0 ? (
            <p className="text-sm text-muted">{b.none}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line border-y border-line" data-booking-list>
              {bookings.map((x) => (
                <li key={x.id} className="flex flex-col gap-2 py-3" data-booking={x.status}>
                  <span className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
                    <span className="font-semibold">
                      {formatDay(localDay(new Date(x.starts_at), tz), lang, true)} {time(x.starts_at, tz)}–{time(x.ends_at, tz)}
                    </span>
                    <span className={x.status === "confirmed" ? "font-semibold" : "text-muted"}>{statusText(x.status, dict)}</span>
                    {x.service_name && <span className="text-muted">{x.service_name}</span>}
                  </span>
                  <span className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
                    {x.contact_id ? (
                      <Link href={`/${lang}/dashboard/contacts/${x.contact_id}?tab=bookings`} className="underline underline-offset-4">
                        {x.name}
                      </Link>
                    ) : (
                      <span>{x.name}</span>
                    )}
                    <a href={`tel:${x.phone}`} className="underline underline-offset-4">
                      {x.phone}
                    </a>
                    {x.email && <span className="break-all">{x.email}</span>}
                    {x.conversation_id && (
                      <Link href={`/${lang}/dashboard/conversations/${x.conversation_id}`} className="text-muted underline underline-offset-4">
                        {b.conversation}
                      </Link>
                    )}
                  </span>
                  {x.note && <span className="whitespace-pre-line break-words text-sm text-muted">{x.note}</span>}
                  <span className="text-xs text-muted">
                    {x.google_status === "created" ? b.google_created : x.google_status === "failed" ? b.google_failed : b.google_none}
                    {x.reminder_sent_at && ` · ${b.reminder_sent}`}
                  </span>
                  <div className="flex flex-wrap gap-2">
                    {STATUSES.filter((s) => s !== x.status).map((s) => (
                      <form key={s} action={setBookingStatus}>
                        {hidden({ booking_id: x.id, status: s, view: "list" })}
                        <button type="submit" className="min-h-11 rounded border border-line px-3 text-sm" data-set-status={s}>
                          {(b as Record<string, string>)[`set_${s}`]}
                        </button>
                      </form>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted">{b.cancel_hint}</p>
        </section>
      )}
    </div>
  );
}

function formatDay(day: string, lang: string, weekday = false) {
  return new Intl.DateTimeFormat(lang as Locale, { timeZone: "UTC", day: "numeric", month: "numeric", ...(weekday ? { weekday: "short" } : {}) }).format(
    new Date(`${day}T12:00:00Z`),
  );
}

const time = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));

function statusText(s: string, dict: Dictionary) {
  return (dict.bookings as Record<string, string>)[`status_${s}`] ?? s;
}

/** "Nastavenia": on/off, what is booked, the times, the reminder, the Google Calendar. */
function SettingsView({
  dict,
  settings,
  google,
  hidden,
  hasPlan,
}: {
  dict: Dictionary;
  settings: Settings | null;
  google: { status: string; last_error: string | null; connected_at: string } | null;
  hidden: (extra?: Record<string, string>) => React.ReactNode;
  hasPlan: boolean;
}) {
  const b = dict.bookings;
  const s = settings ?? { enabled: false, service_name: null, duration_minutes: 30, step_minutes: 30, buffer_minutes: 0, lead_minutes: 120, horizon_days: 30, reminder: false };
  const number = (name: string, label: string, value: number, min: number, max: number, hint?: string) => (
    <label className="flex flex-col gap-1">
      <span className="text-sm">{label}</span>
      <input type="number" name={name} required min={min} max={max} defaultValue={value} className={`${inputClass} w-32`} />
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </label>
  );
  return (
    <section className="flex flex-col gap-6" data-tab-panel="settings">
      <form action={saveBookingSettings} className="flex flex-col gap-3" data-booking-settings>
        {hidden({ view: "settings" })}
        <label className="flex min-h-11 items-center gap-2 font-medium">
          <input type="checkbox" name="enabled" defaultChecked={s.enabled} className="h-4 w-4 accent-foreground" />
          {b.enabled}
        </label>
        <p className="text-xs text-muted">{b.enabled_hint}</p>
        <label className="flex flex-col gap-1">
          <span className="text-sm">{b.service_name}</span>
          <input name="service_name" maxLength={80} defaultValue={s.service_name ?? ""} className={inputClass} />
        </label>
        <div className="flex flex-wrap gap-4">
          {number("duration", b.duration, s.duration_minutes, 5, 480)}
          {number("step", b.step, s.step_minutes, 5, 240)}
          {number("buffer", b.buffer, s.buffer_minutes, 0, 120)}
          {number("lead_hours", b.lead_hours, Math.round(s.lead_minutes / 60), 0, 168)}
          {number("horizon", b.horizon, s.horizon_days, 1, 180)}
        </div>
        <p className="text-xs text-muted">{b.hours_hint}</p>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" name="reminder" defaultChecked={s.reminder} className="h-4 w-4 accent-foreground" />
          {b.reminder}
        </label>
        <p className="text-xs text-muted">{b.reminder_hint}</p>
        {hasPlan && <PendingButton pending={dict.owner.saving}>{dict.account.save}</PendingButton>}
      </form>

      <div className="flex flex-col gap-2 border-t border-line pt-4" data-google>
        <h2 className="font-semibold">{b.google_title}</h2>
        <p className="text-sm">{b.google_intro}</p>
        {google ? (
          <>
            <p className="text-sm font-medium" data-google-status={google.status}>
              {google.status === "ok" ? b.google_ok : t(b.google_problem, { reason: google.last_error ?? "–" })}
            </p>
            <form action={disconnectGoogle}>
              {hidden({ view: "settings" })}
              <button type="submit" className="min-h-11 text-sm underline underline-offset-4">
                {b.google_disconnect}
              </button>
            </form>
          </>
        ) : (
          hasPlan && (
            <form action={connectGoogle}>
              {hidden({ view: "settings" })}
              <PendingButton pending={dict.owner.saving}>{b.google_connect}</PendingButton>
            </form>
          )
        )}
        {google && google.status !== "ok" && hasPlan && (
          <form action={connectGoogle}>
            {hidden({ view: "settings" })}
            <PendingButton pending={dict.owner.saving}>{b.google_connect}</PendingButton>
          </form>
        )}
        <p className="text-xs text-muted">{b.google_hint}</p>
      </div>
    </section>
  );
}

