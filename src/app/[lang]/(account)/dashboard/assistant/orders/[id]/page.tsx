import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary, t } from "@/i18n/dictionaries";
import { requireUser } from "@/lib/auth";
import { foodTab, type FoodOrder, type FoodSettings } from "@/lib/foodOwner";
import { cashChoices, money, nextSteps, type OrderStatus } from "@/lib/foodRules";
import { payBySquareSvg } from "@/lib/payBySquare";
import { formatIban } from "@/lib/sklad";
import { DbError } from "@/components/DbError";
import { PollRefresh } from "@/components/PollRefresh";
import { chooseShop } from "../../../contacts/parts";
import { hiddenFields, inputClass } from "../../../shared";
import { assignCourier, orderSms, orderStep } from "../actions";
import { btn, btnGhost, btnOrange, FoodHead, FoodNotice, hhmm, payText, statusText } from "../parts";
import { fieldClass } from "@/components/owner/ui";

export async function generateMetadata({ params }: PageProps<"/[lang]/dashboard/assistant/orders/[id]">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return { title: (await getDictionary(lang)).food.detail_title };
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const masked = (phone: string) => `${phone.slice(0, 4)} ${phone.slice(4, 7)} ··· ${phone.slice(-3)}`;

/**
 * One order (board 12, database updates 73–74): the steps (Nová → V príprave → Na ceste → Doručená, or Pripravená →
 * Vyzdvihnutá for a pickup), the lines as sold, the delivery fee and the total, the customer (the number shown in part,
 * "overené SMS", Kontakt, Zavolať), the address and the note with "Navigovať", the payment on receipt (the PAY by
 * square code drawn on the server from the shop's IBAN, "Zaplatil v hotovosti" with the quick amounts and the change,
 * "Zaplatené kartou"), the "on the way" SMS (the order quota, once), the next step and "Zrušiť objednávku". A delivered /
 * picked-up step needs a payment mark first and takes the lines off Sklad once (SQL). The page reads itself every 15 s.
 */
export default async function OrderPage({ params, searchParams }: PageProps<"/[lang]/dashboard/assistant/orders/[id]">) {
  const { lang, id } = await params;
  if (!isLocale(lang) || !UUID.test(id)) notFound();
  const sp = await searchParams;
  const [dict, session] = await Promise.all([getDictionary(lang), requireUser(lang)]);
  const { supabase } = session;
  const f = dict.food;
  const chosen = await chooseShop(supabase, first(sp.shop));
  if (chosen.error) return <DbError message={chosen.error} dict={dict} />;
  const shop = chosen.shop;
  if (!shop) redirect(`/${lang}/dashboard`);

  const [orderRes, settingsRes, smsRes, plan, couriersRes, foodTabRes] = await Promise.all([
    supabase.rpc("owner_food_order", { p_shop_id: shop.id, p_order_id: id }),
    supabase.rpc("owner_food_settings", { p_shop_id: shop.id }),
    supabase.rpc("owner_food_sms_state", { p_shop_id: shop.id, p_order_id: id }),
    supabase.rpc("shop_has_plan", { p_shop_id: shop.id }),
    // update 75: the shop's couriers for "Prideliť" (none before the update: no box)
    supabase.rpc("owner_food_couriers", { p_shop_id: shop.id }),
    foodTab(supabase, shop.id),
  ]);
  if (orderRes.error) {
    if (orderRes.error.message === "not_found") notFound();
    return <DbError message={orderRes.error.message} dict={dict} />;
  }
  const o = orderRes.data as FoodOrder;
  const s = (settingsRes.data ?? null) as FoodSettings | null;
  // update 81: without "Platby v Cacaduu" no payment section and no payment step; without the QR terminal no QR
  const payments = s?.parts?.payments ?? true;
  const qrTerminal = s?.parts?.qr_terminal ?? true;
  const sms = (smsRes.error ? null : smsRes.data) as { sent: boolean; quota: { used: number; limit: number } | null } | null;
  const canWrite = !plan.error && plan.data === true;
  const couriers = couriersRes.error
    ? null
    : ((couriersRes.data as { couriers?: { id: string; name: string; active: boolean }[] } | null)?.couriers ?? []);
  const assignable = o.kind === "delivery" && (o.status === "new" || o.status === "preparing" || o.status === "on_the_way");
  const tz = o.timezone;
  const hidden = hiddenFields(lang, shop);
  const formHidden = (extra: Record<string, string>) => hidden({ order_id: o.id, back: "detail", ...extra });
  const total = money(o.total_cents, lang, o.currency);
  const steps = nextSteps(o.kind, o.status);
  const finishing = steps.find((x) => x === "delivered" || x === "picked_up") ?? null;
  const forward = steps.find((x) => x !== "cancelled" && x !== "delivered" && x !== "picked_up") ?? null;
  const ladder: OrderStatus[] = o.kind === "delivery" ? ["new", "preparing", "on_the_way", "delivered"] : ["new", "preparing", "ready", "picked_up"];
  const reached = ladder.indexOf(o.status);
  const listHref = `/${lang}/dashboard/assistant/orders?shop=${shop.slug}`;
  const here = (q: Record<string, string>) => `/${lang}/dashboard/assistant/orders/${o.id}?${new URLSearchParams({ shop: shop.slug, ...q })}`;
  const finished = ["delivered", "picked_up", "cancelled"].includes(o.status);
  const showQr = first(sp.qr) === "1" && !o.paid_at && Boolean(o.iban) && payments && qrTerminal;
  const showCash = first(sp.cash) === "1" && !o.paid_at;
  const svg = showQr
    ? await payBySquareSvg({ iban: o.iban!, bic: o.bic ?? null, payee: o.payee ?? shop.name, amount: o.total_cents / 100, vs: o.vs, message: t(f.qr_message, { n: o.number }) }).catch(() => null)
    : null;
  const quota = sms?.quota;
  const smsBox = o.kind === "delivery" && o.phone && !sms?.sent && canWrite && !finished;
  const stepId = () => crypto.randomUUID();
  const created = new Intl.DateTimeFormat(lang, { timeZone: tz, day: "numeric", month: "numeric" }).format(new Date(o.created_at));
  const actorText = (a: string) => (f as Record<string, string>)[`actor_${a}`] ?? a;

  return (
    <div className="flex w-full flex-col gap-5">
      {/* the same head as the Objednávky tab: the order's page sits under it */}
      <FoodHead
        dict={dict}
        lang={lang}
        shops={chosen.shops}
        shop={shop}
        current="orders"
        newOrders={foodTabRes?.new ?? 0}
        couriers={foodTabRes?.parts?.courier_app ?? true}
        switchHref={(slug) => `/${lang}/dashboard/assistant/orders?shop=${slug}`}
      />
    <div className="flex w-full max-w-xl flex-col gap-4" data-food-detail={o.status}>
      {!finished && <PollRefresh seconds={15} />}
      <Link href={listHref} className="flex min-h-11 items-center gap-2 font-semibold">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="m15 18-6-6 6-6" />
        </svg>
        {f.back}
      </Link>
      <FoodNotice f={f} ok={first(sp.ok)} err={first(sp.err)} />

      <header className="flex flex-col gap-1">
        <h2 className="text-[28px] font-bold leading-tight">
          #{o.number}
          {o.name ? ` · ${o.name}` : ""}
        </h2>
        <p className="text-sm text-muted">
          {created} {hhmm(o.created_at, tz)} ·{" "}
          {o.kind === "delivery" ? t(f.delivery_by, { time: hhmm(o.ready_by, tz) }) : t(f.pickup_by, { time: hhmm(o.ready_by, tz) })} ·{" "}
          {f.from_assistant}
        </p>
      </header>

      {o.status === "cancelled" ? (
        <p className="rounded-lg border border-[#D64545] p-3 font-semibold">
          {statusText(f, "cancelled")}
          {o.cancel_reason ? ` · ${o.cancel_reason}` : ""}
        </p>
      ) : (
        <ol className="grid grid-cols-4 gap-1 text-center text-xs font-semibold" aria-label={f.steps}>
          {ladder.map((st, i) => (
            <li key={st} className="flex flex-col items-center gap-1" aria-current={st === o.status ? "step" : undefined}>
              <span className={`h-1.5 w-full rounded-full ${i <= reached ? "bg-[#F57C20]" : "bg-[#E5E7EB]"}`} />
              <span className={i <= reached ? "" : "text-muted"}>{statusText(f, st)}</span>
            </li>
          ))}
        </ol>
      )}

      <section className="flex flex-col gap-2 rounded-xl border border-line p-4" aria-label={f.items}>
        {o.lines.map((l) => (
          <div key={l.id} className="flex items-baseline justify-between gap-3">
            <span>
              {l.qty}× {l.name}
              {l.extras_text && <span className="block text-sm text-muted">{l.extras_text}</span>}
            </span>
            <span className="flex-none tabular-nums">{money(l.line_cents, lang, o.currency)}</span>
          </div>
        ))}
        {o.kind === "delivery" && (
          <div className="flex items-baseline justify-between gap-3 text-muted">
            <span>{t(f.delivery_fee, { zone: o.zone_name ?? "" })}</span>
            <span className="tabular-nums">{money(o.delivery_cents, lang, o.currency)}</span>
          </div>
        )}
        <div className="flex items-baseline justify-between gap-3 border-t border-line pt-2 text-lg font-bold">
          <span>{f.total}</span>
          <span className="tabular-nums">{total}</span>
        </div>
      </section>

      {(o.phone || o.address || o.note) && (
        <section className="flex flex-col gap-2 rounded-xl border border-line p-4" aria-label={f.customer}>
          {o.phone && (
            <p className="flex flex-wrap items-center gap-x-2">
              <span className="font-semibold">{masked(o.phone)}</span>
              {o.verified && <span className="text-sm text-[#146C37]">· {f.verified_sms}</span>}
              {o.contact_id && (
                <Link href={`/${lang}/dashboard/contacts/${o.contact_id}?shop=${shop.slug}`} className="ml-auto text-sm font-semibold underline underline-offset-4">
                  {f.contact}
                </Link>
              )}
            </p>
          )}
          {o.address && <p className="font-semibold">{o.address}</p>}
          {o.note && <p className="text-sm text-muted">{o.note}</p>}
          <div className="flex gap-2">
            {o.address && (
              <a
                href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(o.address)}`}
                target="_blank"
                rel="noopener noreferrer"
                className={`${btnGhost} flex-1`}
              >
                {f.navigate}
              </a>
            )}
            {o.phone && (
              <a href={`tel:${o.phone}`} className={`${btnGhost} flex-1`}>
                {f.call}
              </a>
            )}
          </div>
        </section>
      )}

      {/* update 75: the courier — "Prideliť" (any active courier, or none), and a problem the courier reported */}
      {o.problem && (
        <p role="alert" className="rounded-xl border border-[#D64545] p-3 font-semibold" data-order-problem>
          {t(f.cr_problem, { reason: o.problem })}
        </p>
      )}
      {couriers && o.kind === "delivery" && (o.courier_name || (assignable && couriers.length > 0) || couriers.length === 0) && (
        <section className="flex flex-col gap-2 rounded-xl border border-line p-4" aria-label={f.cr_assign} data-order-courier>
          <p className="flex flex-wrap items-baseline justify-between gap-2">
            <strong>{f.cr_assign}</strong>
            <span>{o.courier_name ?? f.cr_assign_none}</span>
          </p>
          {assignable && canWrite && couriers.length > 0 && (
            <form action={assignCourier} className="flex flex-wrap gap-2">
              {formHidden({ step_id: stepId() })}
              <select name="courier_id" defaultValue={o.courier_id ?? ""} aria-label={f.cr_assign} className={`${fieldClass} min-w-0 flex-1`}>
                <option value="">{f.cr_assign_none}</option>
                {couriers
                  .filter((c) => c.active || c.id === o.courier_id)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </select>
              <button type="submit" className={btn} data-order-assign>
                {f.cr_assign_button}
              </button>
            </form>
          )}
          {couriers.length === 0 && (
            <Link href={`/${lang}/dashboard/assistant/orders/couriers?shop=${shop.slug}`} className="self-start text-sm font-semibold underline underline-offset-4">
              {f.cr_add_courier_link}
            </Link>
          )}
        </section>
      )}

      {payments && (
      <section className="flex flex-col gap-3 rounded-xl border border-line p-4" aria-label={f.payment}>
        <p className="flex flex-wrap items-baseline justify-between gap-2">
          <strong>{t(f.pay_title, { method: payText(f, o.pay_method) })}</strong>
          {o.paid_at ? (
            <span className="font-semibold text-[#146C37]" data-food-paid>
              {t(f.pay_done, { method: payText(f, o.pay_method), time: hhmm(o.paid_at, tz) })}
            </span>
          ) : (
            <span className="font-semibold text-[#B7860B]">{f.pay_waiting}</span>
          )}
        </p>
        {o.paid_at && o.change_cents !== null && o.change_cents > 0 && (
          <p className="text-lg font-bold">{t(f.cash_change, { amount: money(o.change_cents, lang) })}</p>
        )}
        {!o.paid_at && !finished && canWrite && (
          <>
            {s?.pay_qr && qrTerminal && (
              o.iban ? (
                <Link href={showQr ? here({}) : here({ qr: "1" })} className={btnGhost} data-food-qr>
                  {showQr ? f.hide_qr : t(f.show_qr, { total })}
                </Link>
              ) : (
                <p className="text-sm text-muted">{f.qr_no_iban}</p>
              )
            )}
            {svg && (
              <figure className="flex flex-col items-center gap-2">
                <div role="img" aria-label={t(f.qr_alt, { total })} className="w-full max-w-[280px] [&>svg]:h-auto [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: svg }} />
                <figcaption className="text-center text-sm">
                  {o.payee} · <span className="font-mono">{o.iban ? formatIban(o.iban) : ""}</span> · {t(f.qr_vs, { vs: o.vs })}
                </figcaption>
              </figure>
            )}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {s?.pay_qr && o.iban && (
                <PayForm hidden={formHidden} pay="qr" to={finishing} stepId={stepId()} className={btnGhost}>
                  {f.paid_qr}
                </PayForm>
              )}
              {s?.pay_cash && (
                <Link href={showCash ? here({}) : here({ cash: "1" })} className={btnGhost} data-food-cash>
                  {f.paid_cash}
                </Link>
              )}
              {s?.pay_card && (
                <PayForm hidden={formHidden} pay="card" to={finishing} stepId={stepId()} className={btnGhost}>
                  {f.paid_card}
                </PayForm>
              )}
            </div>
            {showCash && (
              <div className="flex flex-col gap-2 rounded-lg bg-[#F6F7F9] p-3" data-food-cash-amounts>
                <strong>{f.cash_title}</strong>
                <div className="grid grid-cols-3 gap-2">
                  <PayForm hidden={formHidden} pay="cash" cash={(o.total_cents / 100).toFixed(2)} to={finishing} stepId={stepId()} className={btn}>
                    {f.cash_exact}
                  </PayForm>
                  {cashChoices(o.total_cents)
                    .filter((c) => c !== o.total_cents)
                    .map((c) => (
                      <PayForm key={c} hidden={formHidden} pay="cash" cash={(c / 100).toFixed(2)} to={finishing} stepId={stepId()} className={btnGhost}>
                        {money(c, lang)}
                        <span className="sr-only"> · {t(f.cash_change, { amount: money(c - o.total_cents, lang) })}</span>
                      </PayForm>
                    ))}
                </div>
                <form action={orderStep} className="flex items-end gap-2">
                  {formHidden({ pay: "cash", to: finishing ?? "", step_id: stepId() })}
                  <label className="flex flex-1 flex-col gap-1 text-sm">
                    {f.cash_other}
                    <input name="cash" inputMode="decimal" required className={inputClass} placeholder={(o.total_cents / 100).toFixed(2)} />
                  </label>
                  <button type="submit" className={btn}>
                    {f.cash_confirm}
                  </button>
                </form>
                <p className="text-sm text-muted">{f.cash_hint}</p>
              </div>
            )}
            <p className="text-sm text-muted">{f.qr_hint}</p>
          </>
        )}
      </section>
      )}

      {!finished && canWrite && (
        <section className="flex flex-col gap-3" aria-label={f.next}>
          {forward === "on_the_way" ? (
            <form action={orderStep} className="flex flex-col gap-3">
              {formHidden({ to: "on_the_way", step_id: stepId() })}
              {smsBox && (
                <label className="flex min-h-11 items-start gap-3 rounded-lg border border-line p-3">
                  <input type="checkbox" name="sms" value="1" defaultChecked={Boolean(o.sms_on_the_way)} className="mt-1 size-5" />
                  <span>
                    {f.sms_box}
                    {quota && (
                      <span className="block text-sm text-muted">{t(f.sms_count, { left: Math.max(quota.limit - quota.used, 0), limit: quota.limit })}</span>
                    )}
                  </span>
                </label>
              )}
              <button type="submit" className={btnOrange} data-food-step="on_the_way">
                {f.to_on_the_way_send}
              </button>
            </form>
          ) : forward ? (
            <form action={orderStep}>
              {formHidden({ to: forward, step_id: stepId() })}
              <button type="submit" className={`${o.status === "new" ? btnOrange : btn} w-full`} data-food-step={forward}>
                {(f as Record<string, string>)[`to_${forward}`]}
              </button>
            </form>
          ) : null}
          {o.status === "new" && o.kind === "delivery" && forward === "preparing" && (
            // a delivery may also go out at once (food_step_allowed: new → on_the_way)
            <form action={orderStep}>
              {formHidden({ to: "on_the_way", step_id: stepId() })}
              <button type="submit" className={`${btnGhost} w-full`} data-food-step="on_the_way">
                {f.to_on_the_way}
              </button>
            </form>
          )}
          {finishing && (
            <form action={orderStep}>
              {formHidden({ to: finishing, step_id: stepId() })}
              <button type="submit" disabled={payments && !o.paid_at} className={`${btn} w-full`} data-food-step={finishing}>
                {(f as Record<string, string>)[`to_${finishing}`]}
              </button>
              {payments && !o.paid_at && <p className="mt-1 text-sm text-muted">{f.pay_first}</p>}
            </form>
          )}
          {o.status === "on_the_way" && o.phone && !sms?.sent && (
            <form action={orderSms}>
              {formHidden({})}
              <button type="submit" className={`${btnGhost} w-full`}>
                {f.sms_send}
              </button>
            </form>
          )}
          {sms?.sent && <p className="text-sm text-muted">{f.sms_sent}</p>}
          <p className="text-sm text-muted">
            {s?.deduct_on_delivery ? (o.kind === "delivery" ? f.stock_note : f.stock_note_pickup) : f.stock_off}
          </p>
          <details className="rounded-lg border border-line p-3">
            <summary className="flex min-h-11 cursor-pointer items-center font-semibold text-[#D64545]">{f.to_cancelled}</summary>
            <form action={orderStep} className="mt-2 flex flex-col gap-2">
              {formHidden({ to: "cancelled", step_id: stepId() })}
              <label className="flex flex-col gap-1 text-sm">
                {f.cancel_reason}
                <input name="reason" maxLength={200} className={inputClass} />
              </label>
              <button type="submit" className="inline-flex min-h-11 items-center justify-center rounded-lg border border-[#D64545] px-4 font-semibold text-[#D64545]">
                {t(f.cancel_confirm, { n: o.number })}
              </button>
            </form>
          </details>
        </section>
      )}

      {o.events && o.events.length > 0 && (
        <details className="rounded-xl border border-line p-4">
          <summary className="flex min-h-11 cursor-pointer items-center font-semibold">{f.history}</summary>
          <ol className="mt-2 flex flex-col gap-1 text-sm">
            {o.events.map((e, i) => (
              <li key={i}>
                {hhmm(e.at, tz)} · {e.kind === "paid" ? t(f.ev_paid, { method: payText(f, e.detail ?? "") }) : statusText(f, (e.to ?? "new") as OrderStatus)} ·{" "}
                <span className="text-muted">{actorText(e.actor)}</span>
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
    </div>
  );
}

/** A payment mark (and, when the order can be finished now, the finishing step with it). */
function PayForm({
  hidden,
  pay,
  cash,
  to,
  stepId,
  className,
  children,
}: {
  hidden: (extra: Record<string, string>) => React.ReactNode;
  pay: "qr" | "cash" | "card";
  cash?: string;
  to: OrderStatus | null;
  stepId: string;
  className: string;
  children: React.ReactNode;
}) {
  return (
    <form action={orderStep} className="contents">
      {hidden({ pay, to: to ?? "", step_id: stepId, ...(cash ? { cash } : {}) })}
      <button type="submit" className={className} data-food-pay={pay}>
        {children}
      </button>
    </form>
  );
}
