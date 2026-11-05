import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary, t } from "@/i18n/dictionaries";
import { requireUser } from "@/lib/auth";
import { foodTab, type FoodSettings, type FoodZone } from "@/lib/foodOwner";
import { money } from "@/lib/foodRules";
import { DbError } from "@/components/DbError";
import { cardClass, Toggle } from "@/components/owner/ui";
import { chooseShop } from "../../../contacts/parts";
import { hiddenFields, inputClass, ProOnly } from "../../../shared";
import { deleteZone, saveFoodSettings, saveZone } from "../actions";
import { btn, btnGhost, FoodHead, FoodNotice } from "../parts";

export async function generateMetadata({ params }: PageProps<"/[lang]/dashboard/assistant/orders/settings">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return { title: (await getDictionary(lang)).food.s_title };
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const euros = (cents: number) => (cents / 100).toFixed(2).replace(".", ",");

/**
 * Nastavenia objednávok (board 14, database updates 73–74): the switch "Objednávky jedla v asistentovi" (the
 * Objednávky tab and the assistant's tools exist only while it is on), the menu's sources (Sklad's products with a
 * price; the menu in the Public folder for descriptions and allergens, "… nie sú v Sklade" from the menu check),
 * "Odpísať zo skladu po doručení", pickup (preparation time) and delivery (estimate, zones with a fee and a minimum),
 * the payment on receipt (QR with the IBAN from Sklad, cash, card on the shop's own terminal), the last order before
 * closing, the alerts. One form for the switches ("Uložiť"; an unticked box = off), the zones and the check their own.
 */
export default async function OrderSettingsPage({ params, searchParams }: PageProps<"/[lang]/dashboard/assistant/orders/settings">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const sp = await searchParams;
  const [dict, session] = await Promise.all([getDictionary(lang), requireUser(lang)]);
  const { supabase } = session;
  const f = dict.food;
  if (first(sp.view) === "menu") {
    const query = new URLSearchParams(Object.entries(sp).flatMap(([k, v]) => (k === "view" || v === undefined ? [] : [[k, String(first(v))]])));
    redirect(`/${lang}/dashboard/assistant/orders/menu?${query}`);
  }
  const chosen = await chooseShop(supabase, first(sp.shop));
  if (chosen.error) return <DbError message={chosen.error} dict={dict} />;
  const shop = chosen.shop;
  if (!shop) redirect(`/${lang}/dashboard`);
  const [res, foodTabRes] = await Promise.all([
    supabase.rpc("owner_food_settings", { p_shop_id: shop.id }),
    foodTab(supabase, shop.id),
  ]);
  if (res.error) return <DbError message={res.error.message} dict={dict} />;
  const s = res.data as FoodSettings;
  const hidden = (extra: Record<string, string> = {}) => hiddenFields(lang, shop)({ back: "settings", ...extra });
  const canWrite = s.has_plan;
  const quota = s.sms?.order;
  const kinds: FoodZone["kind"][] = ["town", "postcode", "radius_km"];
  const kindText = (k: FoodZone["kind"]) => (f as Record<string, string>)[`s_zone_kind_${k}`];

  const minutes = (n: number) => t(f.s_min, { n });
  // update 79: the Menu tab has its own address (an old ?view=menu link goes there with its query)
  const view = "settings" as const;
  const withCurrent = (list: number[], v: number) => (list.includes(v) ? list : [...list, v].sort((a, b) => a - b));

  return (
    <div className="flex w-full flex-col gap-5">
      <FoodHead
        dict={dict}
        lang={lang}
        shops={chosen.shops}
        shop={shop}
        current={view}
        newOrders={foodTabRes?.new ?? 0}
        switchHref={(slug) => `/${lang}/dashboard/assistant/orders/settings?${new URLSearchParams({ shop: slug })}`}
      />
      <div className="flex w-full max-w-xl flex-col gap-5" data-food-settings={view}>
      {!canWrite && <ProOnly dict={dict} href={`/${lang}/dashboard/plan?shop=${shop.slug}`} />}
      <FoodNotice f={f} ok={first(sp.ok)} err={first(sp.err)} />

      {view === "settings" && (
      <form action={saveFoodSettings} className="flex flex-col gap-5">
        {hidden()}
        <section className={`${cardClass} gap-0 py-2`}>
          <Toggle name="enabled" label={f.s_enabled} hint={f.s_enabled_hint} defaultChecked={s.enabled} />
        </section>
        <section className={`${cardClass} gap-0 py-2`}>
          <Toggle name="deduct_on_delivery" label={f.s_deduct} defaultChecked={s.deduct_on_delivery} />
        </section>

        <section className={cardClass}>
          <h2 className="text-[19px] font-bold">{f.s_pickup}</h2>
          <Toggle name="pickup_on" label={f.s_pickup_on} defaultChecked={s.pickup_on} />
          <span className="text-sm font-semibold">{f.s_prep}</span>
          <Choice name="prep_minutes" value={s.prep_minutes} options={withCurrent([20, 30, 45], s.prep_minutes)} unit={minutes} />
        </section>

        <section className={cardClass}>
          <h2 className="text-[19px] font-bold">{f.s_delivery}</h2>
          <Toggle name="delivery_on" label={f.s_delivery_on} defaultChecked={s.delivery_on} />
          <span className="text-sm font-semibold">{f.s_eta}</span>
          <Choice name="delivery_minutes" value={s.delivery_minutes} options={withCurrent([45, 60, 90], s.delivery_minutes)} unit={minutes} />
          <p className="text-sm text-muted">{f.s_zone_hint}</p>
          <p className="text-sm">
            <a href="#zones" className="font-semibold underline underline-offset-4">
              {t(f.s_zones_count, { n: s.zones.length })}
            </a>
          </p>
        </section>

        <section className={cardClass}>
          <h2 className="text-[19px] font-bold">{f.s_pay}</h2>
          <Toggle name="pay_qr" label={f.s_pay_qr} hint={`${f.s_iban}: ${s.iban_set ? f.s_iban_set : f.s_iban_missing}`} defaultChecked={s.pay_qr} />
          <Toggle name="pay_cash" label={f.s_pay_cash} defaultChecked={s.pay_cash} />
          <Toggle name="pay_card" label={f.s_pay_card} hint={f.s_pay_card_hint} defaultChecked={s.pay_card} />
          {!s.iban_set && (
            <Link href={`/${lang}/dashboard/sklad/settings?shop=${shop.slug}#payment`} className="text-sm font-semibold underline underline-offset-4">
              {f.s_iban_add}
            </Link>
          )}
          <p className="text-sm text-muted">{f.s_pay_hint}</p>
        </section>

        <section className={cardClass}>
          <h2 className="text-[19px] font-bold">{f.s_when}</h2>
          <span className="text-sm font-semibold">{f.s_last}</span>
          <Choice
            name="last_order_minutes"
            value={s.last_order_minutes}
            options={withCurrent([30, 15, 0], s.last_order_minutes).sort((a, b) => b - a)}
            unit={(n) => (n === 0 ? f.s_last_0 : t(f.s_last_n, { n }))}
          />
          <p className="text-sm text-muted">{f.s_when_hint}</p>
        </section>

        <section className={`${cardClass} gap-1`}>
          <h2 className="text-[19px] font-bold">{f.s_alerts}</h2>
          <Toggle name="alert_sound" label={f.s_alert_sound} defaultChecked={s.alert_sound} />
          <Toggle name="alert_email" label={f.s_alert_email} defaultChecked={s.alert_email} />
          <Toggle name="alert_telegram" label={f.s_alert_telegram} hint={f.s_alert_telegram_hint} defaultChecked={s.alert_telegram} />
          <Toggle name="sms_on_the_way" label={f.s_sms_way} defaultChecked={s.sms_on_the_way} />
          <p className="text-sm text-muted">
            {f.s_sms_hint}
            {quota ? ` ${t(f.s_sms_quota, { used: quota.used, limit: quota.limit })}` : ""}
          </p>
        </section>

        {canWrite && (
          <button type="submit" className={`${btn} w-full`} data-food-save>
            {f.s_save}
          </button>
        )}
      </form>
      )}

      {view === "settings" && (
      <section id="zones" className={`${cardClass} scroll-mt-4`}>
        <h2 className="text-[19px] font-bold">{f.s_zones}</h2>
        {s.zones.length === 0 && <p className="text-sm text-muted">{f.s_zones_none}</p>}
        {s.zones.map((z) => (
          <details key={z.id} className="rounded-lg border border-line p-3" data-food-zone={z.kind}>
            <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-3">
              <span className="font-semibold">{z.name}</span>
              <span className="text-sm tabular-nums">
                {money(z.fee_cents, lang)} · {f.s_minimum} {money(z.minimum_cents, lang)}
              </span>
            </summary>
            <ZoneForm f={f} hidden={hidden} zone={z} kinds={kinds} kindText={kindText} canWrite={canWrite} />
            {canWrite && (
              <form action={deleteZone} className="mt-2">
                {hidden({ zone_id: z.id })}
                <button type="submit" className="min-h-11 text-sm font-semibold text-[#D64545] underline underline-offset-4">
                  {f.s_zone_delete}
                </button>
              </form>
            )}
          </details>
        ))}
        {canWrite && (
          <details className="rounded-lg border border-dashed border-line p-3" open={s.zones.length === 0}>
            <summary className="flex min-h-11 cursor-pointer items-center font-semibold">{f.s_zone_add}</summary>
            <ZoneForm f={f} hidden={hidden} zone={null} kinds={kinds} kindText={kindText} canWrite={canWrite} />
          </details>
        )}
      </section>
      )}
      </div>
    </div>
  );
}

function Choice({ name, value, options, unit }: { name: string; value: number; options: number[]; unit: (n: number) => string }) {
  return (
    <div className="flex flex-wrap gap-2" role="radiogroup">
      {options.map((n) => (
        <label key={n} className="has-[:checked]:border-foreground has-[:checked]:bg-foreground has-[:checked]:text-white flex min-h-11 cursor-pointer items-center rounded-full border border-line px-4 text-sm font-semibold">
          <input type="radio" name={name} value={n} defaultChecked={value === n} className="sr-only" />
          {unit(n)}
        </label>
      ))}
    </div>
  );
}

function ZoneForm({
  f,
  hidden,
  zone,
  kinds,
  kindText,
  canWrite,
}: {
  f: Awaited<ReturnType<typeof getDictionary>>["food"];
  hidden: (extra?: Record<string, string>) => React.ReactNode;
  zone: FoodZone | null;
  kinds: FoodZone["kind"][];
  kindText: (k: FoodZone["kind"]) => string;
  canWrite: boolean;
}) {
  return (
    <form action={saveZone} className="mt-2 grid grid-cols-2 gap-2">
      {hidden(zone ? { zone_id: zone.id } : {})}
      <label className="col-span-2 flex flex-col gap-1 text-sm">
        {f.s_zone_name}
        <input name="name" required maxLength={80} defaultValue={zone?.name ?? ""} className={inputClass} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        {f.s_zone_kind}
        <select name="kind" defaultValue={zone?.kind ?? "town"} className={inputClass}>
          {kinds.map((k) => (
            <option key={k} value={k}>
              {kindText(k)}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        {f.s_zone_value}
        <input name="value" required maxLength={80} defaultValue={zone?.value ?? ""} className={inputClass} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        {f.s_fee_eur}
        <input name="fee" inputMode="decimal" defaultValue={zone ? euros(zone.fee_cents) : "0,00"} className={inputClass} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        {f.s_minimum_eur}
        <input name="minimum" inputMode="decimal" defaultValue={zone ? euros(zone.minimum_cents) : "0,00"} className={inputClass} />
      </label>
      {canWrite && (
        <button type="submit" className={`${btnGhost} col-span-2`}>
          {f.s_zone_save}
        </button>
      )}
    </form>
  );
}
