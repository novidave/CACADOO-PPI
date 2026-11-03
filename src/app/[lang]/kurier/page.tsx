import Link from "next/link";
import { courierCall, type CourierDeliveries } from "@/lib/courier";
import { buttonClass, cardClass } from "@/components/owner/ui";
import { CourierHead, eur, hhmm, itemsText, loadCourier, NotSignedIn, payLabel, SignOut } from "./parts";

/**
 * The courier's start (artboard 20, "Telefón – režim kuriéra"): the next delivery and only three parts — Moje donášky,
 * QR terminál, Hotovosť na odovzdanie. No menu, nothing else of the shop.
 */
export default async function CourierHome({ params }: PageProps<"/[lang]/kurier">) {
  const { lang: value } = await params;
  const { lang, c, f, me } = await loadCourier(value);
  if (!me) return <NotSignedIn c={c} />;
  const { data } = await courierCall<CourierDeliveries>("deliveries");
  const open = data?.open ?? [];
  const next = open.find((o) => o.status === "on_the_way") ?? open[0] ?? null;
  const tz = me.shop.timezone;
  const statusText = (s: string) => (f as Record<string, string>)[`st_${s}`] ?? s;

  return (
    <>
      <CourierHead lang={lang} c={c} me={me} />
      <span className="flex items-center gap-2 text-[15px] font-semibold" data-courier-shift>
        <span aria-hidden="true" className="h-3 w-3 rounded-full bg-[#1E9E5A] shadow-[0_0_0_2px_#fff,0_0_0_3px_rgba(0,0,0,.25)]" />
        {c.on_shift}
      </span>

      {next ? (
        <section className={cardClass} data-courier-next>
          <span className="text-[12px] font-bold uppercase tracking-wide text-[#5C5C5C]">{c.next}</span>
          <div className="flex items-baseline justify-between gap-3">
            <strong className="text-[19px]">
              #{next.number}
              {next.name ? ` · ${next.name}` : ""}
            </strong>
            <strong className="text-[19px]">{eur(next.total_cents, lang)}</strong>
          </div>
          <span className="text-[15px]">
            {next.address} · {c.deliver_by.replace("{time}", hhmm(next.ready_by, lang, tz))}
          </span>
          <span className="text-[14px] text-[#5C5C5C]">
            {statusText(next.status)} · {payLabel(c, next.pay_method)} · {itemsText(c, next.items, lang)}
          </span>
          <Link href={`/${lang}/kurier/d/${next.id}`} className={buttonClass} data-courier-open>
            {c.open_delivery}
          </Link>
        </section>
      ) : (
        <p className="rounded-2xl border border-[#E4E4E4] p-[18px] text-[15px]" data-courier-none>
          {c.no_deliveries}
        </p>
      )}

      <nav className="grid grid-cols-1 gap-3" aria-label={c.title}>
        <Link href={`/${lang}/kurier/donasky`} className={`${cardClass} min-h-[92px] justify-center`} data-courier-tile="deliveries">
          <span className="flex items-center justify-between text-[18px] font-bold">
            {c.my_deliveries}
            <span className="inline-flex h-[26px] min-w-[26px] items-center justify-center rounded-full bg-[#111] px-2 text-[14px] text-white">
              {me.open}
            </span>
          </span>
        </Link>
        <Link href={`/${lang}/kurier/qr`} className={`${cardClass} min-h-[92px] justify-center`} data-courier-tile="qr">
          <span className="text-[18px] font-bold">{c.qr_terminal}</span>
        </Link>
        <Link href={`/${lang}/kurier/hotovost`} className={`${cardClass} min-h-[92px] justify-center`} data-courier-tile="cash">
          <span className="flex items-center justify-between text-[18px] font-bold">
            {c.cash_to_hand}
            <span>{eur(me.cash_cents, lang)}</span>
          </span>
        </Link>
      </nav>
      <SignOut lang={lang} c={c} />
    </>
  );
}
