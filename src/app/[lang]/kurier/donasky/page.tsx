import Link from "next/link";
import { courierCall, type CourierDeliveries } from "@/lib/courier";
import { cardClass, ghostClass } from "@/components/owner/ui";
import { CourierHead, eur, hhmm, itemsText, loadCourier, NotSignedIn, payLabel, routeUrl } from "../parts";

/** "Moje donášky" (board 15): the courier's open deliveries in time order, the whole route, today's numbers. */
export default async function CourierDeliveriesPage({ params }: PageProps<"/[lang]/kurier/donasky">) {
  const { lang: value } = await params;
  const { lang, c, f, me } = await loadCourier(value);
  if (!me) return <NotSignedIn c={c} />;
  const { data } = await courierCall<CourierDeliveries>("deliveries");
  const open = data?.open ?? [];
  const tz = me.shop.timezone;
  const total = open.reduce((s, o) => s + o.total_cents, 0);
  const route = routeUrl(open);
  const statusText = (s: string) => (f as Record<string, string>)[`st_${s}`] ?? s;

  return (
    <>
      <CourierHead lang={lang} c={c} me={me} back={`/${lang}/kurier`} title={c.my_deliveries} />
      <p className="text-[15px] font-semibold" data-courier-count>
        {c.deliveries_count.replace("{n}", String(open.length)).replace("{total}", eur(total, lang))}
      </p>
      {route && open.length > 0 && (
        <a href={route} target="_blank" rel="noopener noreferrer" className={ghostClass} data-courier-route>
          {c.navigate_route}
        </a>
      )}
      {open.length === 0 ? (
        <p className="rounded-2xl border border-[#E4E4E4] p-[18px] text-[15px]">{c.no_deliveries}</p>
      ) : (
        <ol className="flex flex-col gap-3" data-courier-list>
          {open.map((o, i) => (
            <li key={o.id}>
              <Link href={`/${lang}/kurier/d/${o.id}`} className={`${cardClass} gap-1.5`} data-courier-delivery={o.id}>
                <span className="flex items-start gap-3">
                  <span className="inline-flex h-8 w-8 flex-none items-center justify-center rounded-full bg-[#111] text-[15px] font-bold text-white">
                    {i + 1}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <strong className="text-[17px]">{o.address}</strong>
                    <span className="text-[14px] text-[#5C5C5C]">
                      #{o.number}
                      {o.name ? ` · ${o.name}` : ""} · {c.deliver_by.replace("{time}", hhmm(o.ready_by, lang, tz))}
                    </span>
                  </span>
                  <strong className="text-[17px]">{eur(o.total_cents, lang)}</strong>
                </span>
                <span className="flex flex-wrap gap-1.5 pl-11 text-[12px] font-bold">
                  <span className="rounded-md border border-[#D6D6D6] px-2 py-0.5">{statusText(o.status)}</span>
                  <span className="rounded-md border border-[#D6D6D6] px-2 py-0.5">
                    {o.paid ? c.paid_with.replace("{method}", payLabel(c, o.pay_method)) : payLabel(c, o.pay_method)}
                  </span>
                  <span className="rounded-md border border-[#D6D6D6] px-2 py-0.5">{itemsText(c, o.items, lang)}</span>
                  {o.problem && <span className="rounded-md border border-[#D64545] px-2 py-0.5">{c.problem}</span>}
                </span>
              </Link>
            </li>
          ))}
        </ol>
      )}
      <section className={`${cardClass} gap-2`} data-courier-today>
        <strong className="text-[16px]">{c.today_done.replace("{n}", String(me.delivered_today))}</strong>
        <span className="flex justify-between text-[15px]">
          <span>{c.cash_held}</span>
          <strong>{eur(me.cash_cents, lang)}</strong>
        </span>
        <span className="flex justify-between text-[15px]">
          <span>{c.qr_payments}</span>
          <strong>{eur(me.qr_today_cents, lang)}</strong>
        </span>
        <span className="text-[13px] text-[#5C5C5C]">{c.cash_note}</span>
      </section>
    </>
  );
}
