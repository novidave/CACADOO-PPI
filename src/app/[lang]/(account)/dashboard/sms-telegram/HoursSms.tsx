import Link from "next/link";
import type { Locale } from "@/i18n/config";
import { t, type Dictionary } from "@/i18n/dictionaries";
import type { requireUser } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import type { MyShop } from "@/lib/myShops";
import { PendingButton } from "@/components/PendingButton";
import { cardClass } from "@/components/owner/ui";
import { hiddenFields, inputClass } from "../shared";
import {
  connectBusiness, disconnectBusiness, pushBusiness, removePhone, selectLocation, startPhone, verifyPhone,
} from "./hoursActions";

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

interface Phone {
  id: string;
  phone: string;
  verified_at: string | null;
  created_at: string;
}
interface Message {
  id: string;
  body: string | null;
  status: string;
  reply: string | null;
  google: string | null;
  received_at: string;
}
interface Business {
  status: string;
  location_name: string | null;
  location_title: string | null;
  last_error: string | null;
  last_push_at: string | null;
}
interface Config {
  number: string | null;
  google: boolean;
  sms_live: boolean;
  reading: boolean;
}

/**
 * "SMS a Telegram" → SMS → "Otváracie hodiny cez SMS" (database update 60, CRM phase 6; Pro; the whole page that was
 * /dashboard/hours-sms until 2026-11-07): the owner's verified phones (a 6-digit code from the hours-sms function),
 * the number to text, examples, the last SMS and what happened to them, and the shop's Google Business Profile
 * (connect, choose the location, send the hours now, disconnect). Only opening hours change by SMS; the database
 * decides every rule. Its messages after a save are drawn by the page, under the tabs.
 */
export async function HoursSms({
  supabase,
  shop,
  lang,
  dict,
  sp,
  hasPlan,
}: {
  supabase: Awaited<ReturnType<typeof requireUser>>["supabase"];
  shop: MyShop;
  lang: Locale;
  dict: Dictionary;
  sp: Record<string, string | string[] | undefined>;
  hasPlan: boolean;
}) {
  const h = dict.hours_sms;
  const tz = shop.timezone;
  const [phonesRes, messagesRes, businessRes, configRes] = await Promise.all([
    supabase.from("shop_owner_phones").select("id, phone, verified_at, created_at").eq("shop_id", shop.id).order("created_at"),
    supabase.from("hours_sms_messages").select("id, body, status, reply, google, received_at").eq("shop_id", shop.id).order("received_at", { ascending: false }).limit(20),
    supabase.from("business_profile_connections").select("status, location_name, location_title, last_error, last_push_at").eq("shop_id", shop.id).maybeSingle<Business>(),
    supabase.functions.invoke<Config>("hours-sms", { body: { action: "config" } }),
  ]);
  // Before update 60 the tables are missing: the part says so instead of failing.
  if (phonesRes.error) {
    return (
      <section id="hours-sms" className={`${cardClass} scroll-mt-4`} data-sms-part="hours">
        <h2 className="text-[19px] font-bold">{h.title}</h2>
        <p className="text-sm text-muted">{h.unavailable}</p>
      </section>
    );
  }
  const phones = (phonesRes.data ?? []) as Phone[];
  const messages = (messagesRes.data ?? []) as Message[];
  const business = businessRes.error ? null : businessRes.data;
  const config = configRes.error ? null : configRes.data;
  const verifying = first(sp.verify);
  const testCode = first(sp.test_code);
  const hidden = hiddenFields(lang, shop);
  const texts = h as Record<string, string>;

  // The Google locations are read only while one is to be chosen (connected, none chosen yet, or "Zmeniť").
  const pick = Boolean(business && business.status === "ok" && (!business.location_name || first(sp.pick) === "1"));
  const locations = pick
    ? await supabase.functions
        .invoke<{ locations: { name: string; title: string; address: string }[] }>("hours-sms", { body: { action: "google_locations", shop_id: shop.id } })
        .then((r) => (r.error ? null : r.data?.locations ?? []))
    : null;

  return (
    <section id="hours-sms" className={`${cardClass} scroll-mt-4 gap-5`} data-sms-part="hours">
      <div className="flex flex-col gap-2">
        <h2 className="text-[19px] font-bold">{h.title}</h2>
        <p className="text-sm">{h.intro}</p>
        {testCode && (
          <p className="border border-line p-3 text-sm" data-test-code>
            {t(h.test_code, { code: testCode })}
          </p>
        )}
      </div>

      <section className="flex flex-col gap-3" data-hours-number>
        <h3 className="font-semibold">{h.number_title}</h3>
        {config?.number ? (
          <p className="text-lg font-semibold">
            <a href={`sms:${config.number}`} className="underline underline-offset-4">
              {config.number}
            </a>
          </p>
        ) : (
          <p className="text-sm text-muted">{h.number_missing}</p>
        )}
        {config && !config.reading && <p className="text-sm text-muted">{h.reading_off}</p>}
        <p className="text-sm">{h.examples_title}</p>
        <ul className="flex flex-col gap-1 text-sm" data-hours-examples>
          {[h.example_1, h.example_2, h.example_3, h.example_4].map((e) => (
            <li key={e} className="border-l-2 border-line pl-3 font-mono">
              {e}
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted">{h.only_hours}</p>
      </section>

      <section className="flex flex-col gap-3 border-t border-line pt-4" data-hours-phones>
        <h3 className="font-semibold">{h.phones_title}</h3>
        <p className="text-sm">{h.phones_intro}</p>
        {phones.length === 0 ? (
          <p className="text-sm text-muted">{h.phones_none}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line border-y border-line">
            {phones.map((p) => (
              <li key={p.id} className="flex flex-col gap-2 py-3" data-phone={p.verified_at ? "verified" : "waiting"}>
                <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
                  <span className="font-semibold">{p.phone}</span>
                  <span className={p.verified_at ? "font-semibold" : "text-muted"}>
                    {p.verified_at ? t(h.verified, { date: formatDateTime(p.verified_at, lang, tz) }) : h.waiting}
                  </span>
                </span>
                {!p.verified_at && hasPlan && (
                  <form action={verifyPhone} className="flex flex-wrap items-end gap-2">
                    {hidden({ phone_id: p.id })}
                    <label className="flex flex-col gap-1">
                      <span className="text-sm">{h.code}</span>
                      <input
                        name="code"
                        required
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        pattern="[0-9 ]{6,8}"
                        maxLength={8}
                        autoFocus={verifying === p.id}
                        className={`${inputClass} w-36 text-base`}
                      />
                    </label>
                    <PendingButton pending={dict.owner.saving}>{h.verify}</PendingButton>
                  </form>
                )}
                <div className="flex flex-wrap gap-3">
                  {!p.verified_at && hasPlan && (
                    <form action={startPhone}>
                      {hidden({ phone: p.phone })}
                      <button type="submit" className="min-h-11 text-sm underline underline-offset-4">
                        {h.resend}
                      </button>
                    </form>
                  )}
                  <form action={removePhone}>
                    {hidden({ phone_id: p.id })}
                    <button type="submit" className="min-h-11 text-sm underline underline-offset-4" data-remove-phone>
                      {h.remove}
                    </button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        )}
        {hasPlan && (
          <form action={startPhone} className="flex flex-wrap items-end gap-2" data-add-phone>
            {hidden()}
            <label className="flex flex-col gap-1">
              <span className="text-sm">{h.add_phone}</span>
              <input name="phone" type="tel" required autoComplete="tel" maxLength={40} className={`${inputClass} w-56 text-base`} />
            </label>
            <PendingButton pending={dict.owner.saving}>{h.send_code}</PendingButton>
          </form>
        )}
        <p className="text-xs text-muted">{h.code_hint}</p>
      </section>

      <section className="flex flex-col gap-3 border-t border-line pt-4" data-business>
        <h3 className="font-semibold">{h.google_title}</h3>
        <p className="text-sm">{h.google_intro}</p>
        {config && !config.google ? (
          <p className="text-sm text-muted">{h.google_off}</p>
        ) : business ? (
          <>
            <p className="text-sm font-medium" data-business-status={business.status}>
              {business.status === "ok"
                ? business.location_title
                  ? t(h.google_location, { name: business.location_title })
                  : h.google_choose
                : t(h.google_problem, { reason: business.last_error ?? "–" })}
            </p>
            {business.last_push_at && (
              <p className="text-xs text-muted">{t(h.google_last_push, { date: formatDateTime(business.last_push_at, lang, tz) })}</p>
            )}
            {pick &&
              (locations === null ? (
                <p className="text-sm text-muted">{h.google_list_failed}</p>
              ) : locations.length === 0 ? (
                <p className="text-sm text-muted">{h.google_no_locations}</p>
              ) : (
                <form action={selectLocation} className="flex flex-col gap-2" data-business-locations>
                  {hidden()}
                  <fieldset className="flex flex-col gap-1">
                    <legend className="text-sm">{h.google_pick}</legend>
                    {locations.map((l) => (
                      <label key={l.name} className="flex min-h-11 items-center gap-2 text-sm">
                        <input
                          type="radio"
                          name="location"
                          required
                          value={`${l.name}|${l.title}`}
                          defaultChecked={l.name === business.location_name}
                          className="h-4 w-4 accent-foreground"
                        />
                        <span>
                          <span className="font-medium">{l.title || l.name}</span>
                          {l.address && <span className="text-muted"> · {l.address}</span>}
                        </span>
                      </label>
                    ))}
                  </fieldset>
                  <PendingButton pending={dict.owner.saving}>{dict.account.save}</PendingButton>
                </form>
              ))}
            <div className="flex flex-wrap gap-3">
              {business.status === "ok" && business.location_name && hasPlan && (
                <form action={pushBusiness}>
                  {hidden()}
                  <PendingButton pending={dict.owner.saving}>{h.google_push}</PendingButton>
                </form>
              )}
              {business.status === "ok" && business.location_name && !pick && (
                <Link href={`/${lang}/dashboard/sms-telegram?${new URLSearchParams({ shop: shop.slug, tab: "sms", pick: "1" })}#hours-sms`} className="flex min-h-11 items-center text-sm underline underline-offset-4">
                  {h.google_change}
                </Link>
              )}
              {business.status !== "ok" && hasPlan && (
                <form action={connectBusiness}>
                  {hidden()}
                  <PendingButton pending={dict.owner.saving}>{h.google_connect}</PendingButton>
                </form>
              )}
              <form action={disconnectBusiness}>
                {hidden()}
                <button type="submit" className="min-h-11 text-sm underline underline-offset-4">
                  {h.google_disconnect}
                </button>
              </form>
            </div>
          </>
        ) : (
          hasPlan && (
            <form action={connectBusiness}>
              {hidden()}
              <PendingButton pending={dict.owner.saving}>{h.google_connect}</PendingButton>
            </form>
          )
        )}
        <p className="text-xs text-muted">{h.google_hint}</p>
      </section>

      <section className="flex flex-col gap-3 border-t border-line pt-4" data-hours-log>
        <h3 className="font-semibold">{h.log_title}</h3>
        {messages.length === 0 ? (
          <p className="text-sm text-muted">{h.log_none}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line border-y border-line">
            {messages.map((m) => (
              <li key={m.id} className="flex flex-col gap-1 py-3 text-sm" data-hours-sms={m.status}>
                <span className="flex flex-wrap gap-x-3">
                  <span className="text-muted">{formatDateTime(m.received_at, lang, tz)}</span>
                  <span className={m.status === "applied" ? "font-semibold" : ""}>{texts[`status_${m.status}`] ?? m.status}</span>
                  {m.google && m.google !== "none" && <span className="text-muted">{texts[`log_google_${m.google}`] ?? ""}</span>}
                </span>
                {m.body && <span className="whitespace-pre-line break-words">{m.body}</span>}
                {m.reply && <span className="whitespace-pre-line break-words text-muted">{t(h.reply, { text: m.reply })}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
