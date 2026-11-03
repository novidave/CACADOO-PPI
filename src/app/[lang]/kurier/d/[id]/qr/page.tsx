import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { courierCall, type CourierOrder } from "@/lib/courier";
import { payBySquareSvg } from "@/lib/payBySquare";
import { CourierStep } from "@/components/CourierStep";
import { buttonClass, ghostClass } from "@/components/owner/ui";
import { CourierHead, CourierNotice, eur, loadCourier, NotSignedIn, stepLabels } from "../../../parts";

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * "QR terminál · #n" (board 17): the phone turned to the customer, the PAY by square code of this order (the shop's
 * IBAN, the amount, the order's variable symbol — drawn on the server), "Zaplatené · Doručené" when the customer shows
 * the bank's confirmation. Cacaduu checks no bank: the shop sees the payment on its statement.
 */
export default async function CourierQr({ params, searchParams }: PageProps<"/[lang]/kurier/d/[id]/qr">) {
  const { lang: value, id } = await params;
  const sp = await searchParams;
  const { lang, c, me } = await loadCourier(value);
  if (!me) return <NotSignedIn c={c} />;
  const { data: o, error } = await courierCall<CourierOrder>("delivery", { order_id: id });
  if (error === "courier") return <NotSignedIn c={c} />;
  if (!o) notFound();
  const self = `/${lang}/kurier/d/${o.id}`;
  const perms = o.perms ?? me.perms;
  if (o.status === "delivered" || o.paid || !perms.qr) redirect(self);
  const svg = o.iban
    ? await payBySquareSvg({
        iban: o.iban,
        bic: o.bic ?? null,
        payee: o.payee ?? o.shop_name,
        amount: o.total_cents / 100,
        vs: o.vs ?? "",
        message: `${o.shop_name} #${o.number}`,
      })
    : null;
  return (
    <>
      <CourierHead lang={lang} c={c} me={me} back={self} title={c.qr_title.replace("{n}", String(o.number))} />
      <CourierNotice c={c} err={first(sp.err)} />
      <section className="flex flex-col items-center gap-3 rounded-2xl border-2 border-[#111] p-5 text-center" data-courier-qr>
        <span className="text-[14px] font-semibold">{c.qr_turn}</span>
        <span className="text-[15px] text-[#5C5C5C]">{c.qr_due.replace("{shop}", o.shop_name)}</span>
        <strong className="text-[36px] leading-none">{eur(o.total_cents, lang)}</strong>
        {svg ? (
          <div className="w-full max-w-[300px] [&>svg]:h-auto [&>svg]:w-full" role="img" aria-label={c.qr_scan} dangerouslySetInnerHTML={{ __html: svg }} />
        ) : (
          <p className="text-[15px]">{c.qr_no_iban}</p>
        )}
        <span className="text-[15px] font-semibold">{c.qr_scan}</span>
        <span className="text-[14px] text-[#5C5C5C]">{c.qr_waiting}</span>
      </section>
      <p className="text-[13px] text-[#5C5C5C]">{c.qr_hint}</p>
      {o.status === "on_the_way" ? (
        <CourierStep
          hidden={{ lang, fn: "step", order_id: o.id, step_id: crypto.randomUUID(), pay_method: "qr", to: "delivered" }}
          next={`/${lang}/kurier/donasky`}
          back={`${self}/qr`}
          className={`${buttonClass} min-h-14 w-full`}
          labels={stepLabels(c)}
          data="qr_paid"
        >
          {c.qr_paid}
        </CourierStep>
      ) : (
        <p className="text-[15px]">{c.err_step}</p>
      )}
      {perms.cash && (
        <Link href={`${self}/hotovost`} className={ghostClass}>
          {c.pay_cash}
        </Link>
      )}
      <Link href={self} className="flex min-h-11 items-center justify-center text-[15px] font-semibold underline underline-offset-4">
        {c.qr_back}
      </Link>
    </>
  );
}
