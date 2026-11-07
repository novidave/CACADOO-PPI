import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary, t } from "@/i18n/dictionaries";
import { requireUser } from "@/lib/auth";
import { smsTelegramTab } from "@/lib/dashboardPages";
import type { FoodSettings } from "@/lib/foodOwner";
import { loadSmsUsage } from "@/lib/smsUsage";
import { DbError } from "@/components/DbError";
import { PendingButton } from "@/components/PendingButton";
import { SmsUsage } from "@/components/SmsUsage";
import { itemTabs, PageHead } from "@/components/owner/PageHead";
import { cardClass, Toggle } from "@/components/owner/ui";
import { chooseShop } from "../contacts/parts";
import { hiddenFields, inputClass, ProOnly, ShopSwitcher } from "../shared";
import { HoursSms } from "./HoursSms";
import { saveBookingSms, saveFoodSms } from "./smsActions";
import { TelegramPart } from "./TelegramPart";

export async function generateMetadata({ params }: PageProps<"/[lang]/dashboard/sms-telegram">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return { title: (await getDictionary(lang)).nav.sms_tg };
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

interface CrmSms {
  reminder_on: boolean;
  reminder_offset: "2h" | "day_before_18";
  notify_on_owner_change: boolean;
}

/**
 * "SMS a Telegram" (2026-11-07, at the owner's request: every SMS and Telegram setting on one page; it was "Otváracie
 * hodiny cez SMS"). PageHead with two tabs — SMS (?tab=sms, the default) and Telegram (?tab=telegram) —, the shop
 * switcher the same on both, nothing tab-specific above the tabs.
 *
 * SMS, in this order: "SMS tento mesiac" (every quota of the shop: the owner's, the bookings', and a restaurant's orders
 * while it takes orders), "Otváracie hodiny cez SMS" (the whole old page), "SMS pri rezerváciách" (moved from
 * Rezervácie → Nastavenia: the reminder, the SMS when the owner moves or cancels, the code that is always on) and,
 * for a restaurant with food orders, "SMS pri objednávkach jedla" (moved from Objednávky jedla → Nastavenia). Each
 * setting lives only here; the old screens keep one line with a link. Telegram: everything of the old
 * /dashboard/ai#telegram. Old addresses forward here with their query (@/lib/dashboardPages).
 */
export default async function SmsTelegramPage({ params, searchParams }: PageProps<"/[lang]/dashboard/sms-telegram">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const sp = await searchParams;
  const [dict, session] = await Promise.all([getDictionary(lang), requireUser(lang)]);
  const { supabase } = session;
  const chosen = await chooseShop(supabase, first(sp.shop));
  if (chosen.error) return <DbError message={chosen.error} dict={dict} />;
  const shop = chosen.shop;
  if (!shop) redirect(`/${lang}/dashboard`);
  const tab = smsTelegramTab(first(sp.tab));
  const s = dict.smstg;

  const head = (
    <PageHead title={dict.nav.sms_tg} item="smstg" tabs={itemTabs(dict, lang, "smstg", shop.slug)} current={tab} tabsLabel={dict.nav.tabs_label}>
      <ShopSwitcher
        shops={chosen.shops}
        current={shop}
        label={dict.dashboard.shop}
        href={(slug) => `/${lang}/dashboard/sms-telegram?${new URLSearchParams({ shop: slug, tab })}`}
      />
      {chosen.shops.length > 1 && <p className="text-muted">{shop.name}</p>}
    </PageHead>
  );

  if (tab === "telegram") {
    return (
      <div className="flex w-full flex-col gap-5">
        {head}
        <div className="flex w-full max-w-3xl flex-col gap-5" data-tab-panel="telegram">
          <TelegramPart supabase={supabase} lang={lang} dict={dict} sp={sp} slug={shop.slug} />
        </div>
      </div>
    );
  }

  const food = shop.kind === "food";
  const [plan, sms, crmRes, foodRes] = await Promise.all([
    supabase.rpc("shop_has_plan", { p_shop_id: shop.id }),
    loadSmsUsage(supabase, shop.id),
    supabase.from("crm_settings").select("reminder_on, reminder_offset, notify_on_owner_change").eq("shop_id", shop.id).maybeSingle<CrmSms>(),
    food ? supabase.rpc("owner_food_settings", { p_shop_id: shop.id }) : Promise.resolve(null),
  ]);
  const hasPlan = !plan.error && plan.data === true;
  // update 63's defaults when the shop never saved its settings
  const crm: CrmSms = crmRes.data ?? { reminder_on: false, reminder_offset: "day_before_18", notify_on_owner_change: true };
  const foodSettings = foodRes && !foodRes.error ? (foodRes.data as FoodSettings) : null;
  // "SMS pri objednávkach jedla" only for a restaurant that takes food orders
  const orders = Boolean(foodSettings?.enabled);
  const hidden = hiddenFields(lang, shop);
  const texts = { ...(dict.hours_sms as Record<string, string>), ...(s as Record<string, string>) };
  const ok = first(sp.ok);
  const err = first(sp.err);
  const ro = !hasPlan;

  return (
    <div className="flex w-full flex-col gap-5">
      {head}
      <div className="flex w-full max-w-3xl flex-col gap-5" data-tab-panel="sms">
        {!hasPlan && <ProOnly dict={dict} href={`/${lang}/dashboard/plan?shop=${shop.slug}`} />}
        {ok && texts[ok] && (
          <p role="status" className="border border-foreground p-3 font-medium" data-sms-notice="ok">
            {texts[ok]}
          </p>
        )}
        {err && (
          <p role="alert" className="border border-line p-3" data-sms-notice="err">
            {t(texts[err] ?? dict.hours_sms.err_failed, { n: first(sp.left) ?? "" })}
          </p>
        )}

        {/* a) every quota of the shop this month */}
        {sms && <SmsUsage usage={sms} lang={lang} timeZone={shop.timezone} dict={dict} order={orders ? foodSettings?.sms?.order : null} />}

        {/* b) "Otváracie hodiny cez SMS" — the whole page it was */}
        <HoursSms supabase={supabase} shop={shop} lang={lang} dict={dict} sp={sp} hasPlan={hasPlan} />

        {/* c) "SMS pri rezerváciách" (moved from Rezervácie → Nastavenia) */}
        <section id="booking-sms" className={`${cardClass} scroll-mt-4 gap-1`} data-sms-part="bookings">
          <h2 className="text-[19px] font-bold">{s.booking_title}</h2>
          <p className="text-sm text-muted">{s.booking_intro}</p>
          <div className="flex min-h-14 items-center justify-between gap-3 text-base font-semibold">
            <span className="flex flex-col">
              {s.booking_code}
              <span className="text-[13px] font-medium text-[#5C5C5C]">{s.booking_code_hint}</span>
            </span>
            <input type="checkbox" checked disabled aria-label={s.booking_code} className="ppi-toggle" />
          </div>
          <form action={saveBookingSms} className="flex flex-col gap-1">
            {hidden()}
            <Toggle name="reminder_on" label={s.booking_reminder} defaultChecked={crm.reminder_on} disabled={ro} />
            <label className="flex flex-col gap-1 pb-2 text-[13px] text-muted">
              {s.booking_when}
              <select name="reminder_offset" defaultValue={crm.reminder_offset} disabled={ro} className={`${inputClass} min-h-11 bg-white text-[15px] text-foreground`}>
                <option value="2h">{s.booking_2h}</option>
                <option value="day_before_18">{s.booking_day_before}</option>
              </select>
            </label>
            <Toggle name="notify_on_owner_change" label={s.booking_owner_change} defaultChecked={crm.notify_on_owner_change} disabled={ro} />
            {hasPlan && (
              <div className="pt-2">
                <PendingButton pending={dict.owner.saving}>{dict.account.save}</PendingButton>
              </div>
            )}
          </form>
          <p className="pt-2 text-sm text-muted">
            {s.booking_other}{" "}
            <Link href={`/${lang}/dashboard/bookings?${new URLSearchParams({ shop: shop.slug, tab: "settings" })}`} className="font-semibold underline underline-offset-4">
              {s.booking_other_link}
            </Link>
          </p>
        </section>

        {/* d) "SMS pri objednávkach jedla" (moved from Objednávky jedla → Nastavenia; a restaurant taking orders) */}
        {orders && foodSettings && (
          <section id="food-sms" className={`${cardClass} scroll-mt-4 gap-1`} data-sms-part="food">
            <h2 className="text-[19px] font-bold">{s.food_title}</h2>
            <form action={saveFoodSms} className="flex flex-col gap-1">
              {hidden()}
              <Toggle name="sms_on_the_way" label={dict.food.s_sms_way} defaultChecked={foodSettings.sms_on_the_way} disabled={!foodSettings.has_plan} />
              <p className="text-sm text-muted">
                {dict.food.s_sms_hint}
                {foodSettings.sms?.order ? ` ${t(dict.food.s_sms_quota, { used: foodSettings.sms.order.used, limit: foodSettings.sms.order.limit })}` : ""}
              </p>
              {foodSettings.has_plan && (
                <div className="pt-2">
                  <PendingButton pending={dict.owner.saving}>{dict.account.save}</PendingButton>
                </div>
              )}
            </form>
          </section>
        )}
      </div>
    </div>
  );
}
