import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { courierCall, type CourierOrder } from "@/lib/courier";
import { CourierCash } from "@/components/CourierCash";
import { buttonClass, cardClass, ghostClass } from "@/components/owner/ui";
import { CourierHead, CourierNotice, eur, loadCourier, NotSignedIn, stepLabels } from "../../../parts";

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** "Hotovosť · #n" (board 18): what the customer gave, the change, then "Zaplatené · Doručené" in one tap. */
export default async function CourierCashStep({ params, searchParams }: PageProps<"/[lang]/kurier/d/[id]/hotovost">) {
  const { lang: value, id } = await params;
  const sp = await searchParams;
  const { lang, c, me } = await loadCourier(value);
  if (!me) return <NotSignedIn c={c} />;
  const { data: o, error } = await courierCall<CourierOrder>("delivery", { order_id: id });
  if (error === "courier") return <NotSignedIn c={c} />;
  if (!o) notFound();
  const self = `/${lang}/kurier/d/${o.id}`;
  if (o.status === "delivered" || o.paid || !(o.perms ?? me.perms).cash) redirect(self);
  return (
    <>
      <CourierHead lang={lang} c={c} me={me} back={self} title={c.cash_title.replace("{n}", String(o.number))} />
      <CourierNotice c={c} err={first(sp.err)} />
      <section className={`${cardClass} gap-1`}>
        <span className="text-[14px] text-[#5C5C5C]">
          {o.name}
          {o.address ? ` · ${o.address}` : ""}
        </span>
        <span className="flex items-baseline justify-between">
          <strong className="text-[16px]">{c.due}</strong>
          <strong className="text-[28px]" data-courier-total>
            {eur(o.total_cents, lang)}
          </strong>
        </span>
      </section>
      {o.status !== "on_the_way" ? (
        <p className="text-[15px]">{c.err_step}</p>
      ) : (
        <CourierCash
          lang={lang}
          totalCents={o.total_cents}
          initialGiven={o.cash_given_cents}
          hidden={{ lang, fn: "step", order_id: o.id, step_id: crypto.randomUUID(), pay_method: "cash", to: "delivered" }}
          next={`/${lang}/kurier/donasky`}
          back={`${self}/hotovost`}
          labels={{ given: c.cash_given, exact: c.cash_exact, other: c.cash_other, otherShort: c.cash_other_short, change: c.cash_change, confirm: c.cash_confirm }}
          stepLabels={stepLabels(c)}
          buttonClass={buttonClass}
        />
      )}
      <p className="text-[13px] text-[#5C5C5C]">{c.cash_hint}</p>
      {(o.perms ?? me.perms).qr && (
        <Link href={`${self}/qr`} className={ghostClass}>
          {c.cash_prefers_qr}
        </Link>
      )}
    </>
  );
}
