import { courierCall, type CourierDeliveries } from "@/lib/courier";
import { cardClass } from "@/components/owner/ui";
import { CourierHead, eur, hhmm, loadCourier, NotSignedIn, payLabel } from "../parts";

/** "Hotovosť na odovzdanie": the cash the courier holds since the shop's last settlement, today's deliveries. */
export default async function CourierCashPage({ params }: PageProps<"/[lang]/kurier/hotovost">) {
  const { lang: value } = await params;
  const { lang, c, me } = await loadCourier(value);
  if (!me) return <NotSignedIn c={c} />;
  const { data } = await courierCall<CourierDeliveries>("deliveries");
  const done = data?.done_today ?? [];
  const tz = me.shop.timezone;
  return (
    <>
      <CourierHead lang={lang} c={c} me={me} back={`/${lang}/kurier`} title={c.cash_to_hand} />
      <section className={`${cardClass} items-center text-center`} data-courier-cash>
        <strong className="text-[34px]">{eur(me.cash_cents, lang)}</strong>
        <span className="text-[14px] text-[#5C5C5C]">{c.cash_note}</span>
      </section>
      <section className={`${cardClass} gap-2`}>
        <strong className="text-[16px]">{c.today_done.replace("{n}", String(me.delivered_today))}</strong>
        <span className="flex justify-between text-[15px]">
          <span>{c.qr_payments}</span>
          <strong>{eur(me.qr_today_cents, lang)}</strong>
        </span>
        <span className="flex justify-between text-[15px]">
          <span>{c.card_payments}</span>
          <strong>{eur(me.card_today_cents, lang)}</strong>
        </span>
        {done.length > 0 && (
          <ul className="flex flex-col divide-y divide-[#E4E4E4] border-t border-[#E4E4E4]">
            {done.map((o) => (
              <li key={o.id} className="flex min-h-11 items-center justify-between gap-3 text-[14px]">
                <span>
                  #{o.number} · {hhmm(o.delivered_at, lang, tz)} · {payLabel(c, o.pay_method)}
                </span>
                <strong>{eur(o.total_cents, lang)}</strong>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
