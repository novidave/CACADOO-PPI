import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary, t } from "@/i18n/dictionaries";
import { requireUser } from "@/lib/auth";
import { money } from "@/lib/foodRules";
import { DbError } from "@/components/DbError";
import { foodTab } from "@/lib/foodOwner";
import { buttonClass, cardClass, Field, fieldClass, ghostClass, Segmented, StatusDot, Toggle } from "@/components/owner/ui";
import { chooseShop } from "../../../contacts/parts";
import { hiddenFields, ProOnly } from "../../../shared";
import { inviteCourier, logoutCourier, saveCourier, saveCourierSettings, setCourierActive, settleCourier } from "../actions";
import { FoodHead, FoodNotice } from "../parts";

export async function generateMetadata({ params }: PageProps<"/[lang]/dashboard/assistant/orders/couriers">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return { title: (await getDictionary(lang)).nav.tabs.food_couriers };
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

interface Courier {
  id: string;
  name: string;
  phone: string;
  active: boolean;
  invited_at: string | null;
  signed_in: boolean;
  open: number;
  on_the_way: number;
  delivered_today: number;
  cash_cents: number;
}

interface CourierSetup {
  couriers: Courier[];
  assign_mode: "manual" | "auto";
  courier_can_qr: boolean;
  courier_can_cash: boolean;
  courier_has_card: boolean;
  pay_qr: boolean;
  pay_cash: boolean;
  pay_card: boolean;
  delivery_on: boolean;
  has_plan: boolean;
  sms: { used: number; limit: number } | null;
  timezone: string;
}

/** "+421 915 ··· 220": enough to recognise the number on the owner's own list. */
const masked = (phone: string) => `${phone.slice(0, 4)} ${phone.slice(4, 7)} ··· ${phone.slice(-3)}`;

/**
 * Objednávky jedla → Kuriéri (database update 75; canvas "Môj obchod" artboard 6, "Asistent a CRM" board 19): the
 * shop's couriers — what each is doing, the cash each holds ("Vyúčtovať hotovosť"), "Poslať pozvánku SMS", "Odhlásiť z
 * telefónu", "Deaktivovať" — "Pridať kuriéra", and how deliveries are assigned and what couriers may mark. Every rule
 * is in SQL (owner_food_*; members read, writes also need the plan).
 */
export default async function CouriersPage({ params, searchParams }: PageProps<"/[lang]/dashboard/assistant/orders/couriers">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const sp = await searchParams;
  const [dict, session] = await Promise.all([getDictionary(lang), requireUser(lang)]);
  const { supabase } = session;
  const f = dict.food;
  const chosen = await chooseShop(supabase, first(sp.shop));
  if (chosen.error) return <DbError message={chosen.error} dict={dict} />;
  const shop = chosen.shop;
  if (!shop) redirect(`/${lang}/dashboard`);
  const [res, foodTabRes] = await Promise.all([supabase.rpc("owner_food_couriers", { p_shop_id: shop.id }), foodTab(supabase, shop.id)]);
  if (res.error) return <DbError message={res.error.message} dict={dict} />;
  const s = res.data as CourierSetup;
  const hidden = (extra: Record<string, string> = {}) => hiddenFields(lang, shop)({ back: "couriers", ...extra });
  const canWrite = s.has_plan;
  const tz = s.timezone;
  const when = (iso: string) =>
    new Intl.DateTimeFormat(lang, { timeZone: tz, day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

  return (
    <div className="flex w-full flex-col gap-5">
      <FoodHead
        dict={dict}
        lang={lang}
        shops={chosen.shops}
        shop={shop}
        current="couriers"
        newOrders={foodTabRes?.new ?? 0}
        switchHref={(slug) => `/${lang}/dashboard/assistant/orders/couriers?shop=${slug}`}
      />
      <div className="flex w-full max-w-5xl flex-col gap-5" data-food-couriers>
      {!canWrite && <ProOnly dict={dict} href={`/${lang}/dashboard/plan?shop=${shop.slug}`} />}
      <FoodNotice f={f} ok={first(sp.ok)} err={first(sp.err)} />
      {!s.delivery_on && <p className="rounded-xl bg-[#F6F6F6] p-3 text-[15px]">{f.cr_delivery_off}</p>}

      <div className="grid gap-[18px] lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:items-start">
        <div className="flex min-w-0 flex-col gap-[18px]">
          <section className={`${cardClass} gap-0`} aria-labelledby="cr-list">
            <h2 id="cr-list" className="mb-2 text-[19px] font-bold">
              {f.cr_list_title}
            </h2>
            {s.couriers.length === 0 && <p className="text-[15px] text-[#5C5C5C]">{f.cr_none}</p>}
            {s.couriers.map((c) => {
              const state = !c.active ? f.cr_off : c.on_the_way > 0 ? f.cr_on_the_way : c.open > 0 ? t(f.cr_open, { n: c.open }) : f.cr_free;
              return (
                <div key={c.id} id={`c-${c.id}`} className="flex scroll-mt-4 flex-col gap-2 border-t border-[#E4E4E4] py-3" data-courier-row={c.id}>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <strong className={`text-[17px] ${c.active ? "" : "text-[#5C5C5C]"}`}>{c.name}</strong>
                      <span className="flex flex-wrap items-center gap-x-2 text-[14px] text-[#5C5C5C]">
                        <span>{masked(c.phone)}</span>
                        <span>· {state}</span>
                        <span className="inline-flex items-center gap-1">
                          · <StatusDot color={c.signed_in ? "#1E9E5A" : "#9AA5B1"} size={9} /> {c.signed_in ? f.cr_signed_in : f.cr_signed_out}
                        </span>
                        {c.invited_at && <span>· {t(f.cr_invited, { time: when(c.invited_at) })}</span>}
                      </span>
                    </span>
                    <span className="text-[15px]" data-courier-cash={c.cash_cents}>
                      {t(f.cr_cash, { amount: money(c.cash_cents, lang) })}
                    </span>
                  </div>
                  {canWrite && (
                    <div className="flex flex-wrap gap-2">
                      {c.active && (
                        <form action={inviteCourier}>
                          {hidden({ courier_id: c.id })}
                          <button type="submit" className={`${ghostClass} min-h-12 text-[15px]`} data-courier-invite>
                            {f.cr_invite}
                          </button>
                        </form>
                      )}
                      {c.cash_cents > 0 && (
                        <form action={settleCourier}>
                          {hidden({ courier_id: c.id })}
                          <button type="submit" className={`${ghostClass} min-h-12 text-[15px]`} data-courier-settle>
                            {f.cr_settle}
                          </button>
                        </form>
                      )}
                      {c.signed_in && (
                        <form action={logoutCourier}>
                          {hidden({ courier_id: c.id })}
                          <button type="submit" className={`${ghostClass} min-h-12 text-[15px]`}>
                            {f.cr_logout}
                          </button>
                        </form>
                      )}
                      <form action={setCourierActive}>
                        {hidden({ courier_id: c.id, active: c.active ? "0" : "1" })}
                        <button type="submit" className={`${ghostClass} min-h-12 text-[15px]`} data-courier-active={c.active ? "off" : "on"}>
                          {c.active ? f.cr_deactivate : f.cr_activate}
                        </button>
                      </form>
                    </div>
                  )}
                  {canWrite && (
                    <details>
                      <summary className="flex min-h-11 cursor-pointer items-center text-[15px] font-semibold underline underline-offset-4">{f.cr_edit}</summary>
                      <form action={saveCourier} className="mt-2 grid gap-3 sm:grid-cols-2">
                        {hidden({ courier_id: c.id })}
                        <Field label={f.cr_name}>
                          <input name="name" required maxLength={60} defaultValue={c.name} className={fieldClass} />
                        </Field>
                        <Field label={f.cr_phone}>
                          <input name="phone" type="tel" required maxLength={40} defaultValue={c.phone} className={fieldClass} />
                        </Field>
                        <button type="submit" className={`${buttonClass} sm:col-span-2`}>
                          {f.cr_save}
                        </button>
                      </form>
                    </details>
                  )}
                </div>
              );
            })}
          </section>

          {canWrite && (
            <section id="add" className={`${cardClass} scroll-mt-4`} aria-labelledby="cr-add">
              <h2 id="cr-add" className="text-[19px] font-bold">
                {f.cr_add}
              </h2>
              {s.couriers.length >= 20 ? (
                <p className="text-[15px]">{f.cr_limit}</p>
              ) : (
                <form action={saveCourier} className="grid gap-3 sm:grid-cols-2">
                  {hidden()}
                  <Field label={f.cr_name}>
                    <input name="name" required maxLength={60} placeholder={f.cr_name_ph} className={fieldClass} />
                  </Field>
                  <Field label={f.cr_phone}>
                    <input name="phone" type="tel" required maxLength={40} placeholder="+421 …" className={fieldClass} />
                  </Field>
                  <button type="submit" className={`${buttonClass} sm:col-span-2`} data-courier-add>
                    {f.cr_add_button}
                  </button>
                </form>
              )}
              <p className="text-[14px] text-[#5C5C5C]">{f.cr_add_hint}</p>
              {s.sms && <p className="text-[13px] text-[#5C5C5C]">{t(f.cr_sms_quota, { used: s.sms.used, limit: s.sms.limit })}</p>}
            </section>
          )}
        </div>

        <section id="assign" className={`${cardClass} scroll-mt-4`} aria-labelledby="cr-assign">
          <h2 id="cr-assign" className="text-[19px] font-bold">
            {f.cr_assign_title}
          </h2>
          <form action={saveCourierSettings} className="flex flex-col gap-1">
            {hidden()}
            <Segmented
              name="assign_mode"
              label={f.cr_assign_label}
              value={s.assign_mode}
              options={[
                { value: "manual", label: f.cr_assign_manual },
                { value: "auto", label: f.cr_assign_auto },
              ]}
            />
            <p className="pt-1 text-[13px] text-[#5C5C5C]">{f.cr_assign_auto_hint}</p>
            <Toggle name="courier_can_qr" label={f.cr_can_qr} hint={s.pay_qr ? undefined : f.cr_method_off} defaultChecked={s.courier_can_qr} />
            <Toggle name="courier_can_cash" label={f.cr_can_cash} hint={s.pay_cash ? undefined : f.cr_method_off} defaultChecked={s.courier_can_cash} />
            <Toggle name="courier_has_card" label={f.cr_has_card} hint={s.pay_card ? undefined : f.cr_method_off} defaultChecked={s.courier_has_card} />
            <p className="pb-2 text-[14px] text-[#5C5C5C]">{f.cr_settings_hint}</p>
            {canWrite && (
              <button type="submit" className={`${buttonClass} self-start min-w-[180px]`}>
                {f.cr_save}
              </button>
            )}
          </form>
        </section>
      </div>
      </div>
    </div>
  );
}
