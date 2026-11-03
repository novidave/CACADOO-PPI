import Link from "next/link";
import { notFound } from "next/navigation";
import { courierCall, type CourierOrder } from "@/lib/courier";
import { CourierStep } from "@/components/CourierStep";
import { buttonClass, cardClass, ghostClass, textareaClass } from "@/components/owner/ui";
import { CourierHead, CourierNotice, directionsTo, eur, hhmm, loadCourier, NotSignedIn, payLabel, stepLabels } from "../../parts";

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * One delivery (board 16): the address with "Navigovať" and "Zavolať", the items, the amount; "Na ceste"; the payment
 * (QR terminal, cash with the change, or card on the courier's own terminal — only what the shop allows its couriers);
 * "Doručené" only after a payment mark; "Problém s donáškou".
 */
export default async function CourierDeliveryPage({ params, searchParams }: PageProps<"/[lang]/kurier/d/[id]">) {
  const { lang: value, id } = await params;
  const sp = await searchParams;
  const { lang, c, f, me } = await loadCourier(value);
  if (!me) return <NotSignedIn c={c} />;
  const { data: o, error } = await courierCall<CourierOrder>("delivery", { order_id: id });
  if (error === "courier") return <NotSignedIn c={c} />;
  if (!o) notFound();
  const tz = o.timezone;
  const self = `/${lang}/kurier/d/${o.id}`;
  const list = `/${lang}/kurier/donasky`;
  const labels = stepLabels(c);
  const perms = o.perms ?? me.perms;
  const statusText = (s: string) => (f as Record<string, string>)[`st_${s}`] ?? s;
  const nav = directionsTo(o);
  const open = o.status === "new" || o.status === "preparing" || o.status === "on_the_way";
  const base = { lang, fn: "step", order_id: o.id };
  // the three payment choices: one row of 52 px buttons that never wrap their word (the chosen one black)
  const choice = (on: boolean) =>
    `flex min-h-[52px] items-center justify-center whitespace-nowrap rounded-xl border px-1 text-[16px] font-bold ${
      on ? "border-[#111] bg-[#111] text-white" : "border-[#D6D6D6] bg-white text-[#111]"
    }`;
  const cardOpen = o.pay_method === "card" || first(sp.pay) === "card";

  return (
    <>
      <CourierHead lang={lang} c={c} me={me} back={list} title={`#${o.number}${o.name ? ` · ${o.name}` : ""}`} />
      <CourierNotice c={c} err={first(sp.err)} />
      <p className="text-[15px] font-semibold" data-courier-status={o.status}>
        {statusText(o.status)} · {o.status === "delivered" ? c.delivered_at.replace("{time}", hhmm(o.delivered_at, lang, tz)) : c.deliver_by.replace("{time}", hhmm(o.ready_by, lang, tz))}
      </p>

      <section className={cardClass}>
        <strong className="text-[19px]">{o.address}</strong>
        {o.note && (
          <span className="text-[15px]">
            <span className="text-[#5C5C5C]">{c.note}: </span>
            {o.note}
          </span>
        )}
        <div className="grid grid-cols-2 gap-2">
          {nav ? (
            <a href={nav} target="_blank" rel="noopener noreferrer" className={buttonClass} data-courier-navigate>
              {f.navigate}
            </a>
          ) : (
            <span />
          )}
          {o.phone && (
            <a href={`tel:${o.phone}`} className={ghostClass} data-courier-call>
              {f.call}
            </a>
          )}
        </div>
      </section>

      <section className={`${cardClass} gap-2`} aria-label={f.total}>
        <ul className="flex flex-col gap-1.5">
          {o.lines.map((l, i) => (
            <li key={i} className="flex justify-between gap-3 text-[15px]">
              <span>
                {l.qty}× {l.name}
                {l.extras_text ? <span className="text-[#5C5C5C]"> ({l.extras_text})</span> : null}
              </span>
              <span>{eur(l.line_cents, lang)}</span>
            </li>
          ))}
          {o.delivery_cents > 0 && (
            <li className="flex justify-between gap-3 text-[15px]">
              <span>
                {c.delivery_fee}
                {o.zone_name ? ` · ${o.zone_name}` : ""}
              </span>
              <span>{eur(o.delivery_cents, lang)}</span>
            </li>
          )}
        </ul>
        <span className="flex items-baseline justify-between border-t border-[#E4E4E4] pt-2">
          <strong className="text-[16px]">{c.due}</strong>
          <strong className="text-[24px]" data-courier-total>
            {eur(o.total_cents, lang)}
          </strong>
        </span>
      </section>

      {open && (o.status === "new" || o.status === "preparing") && (
        <CourierStep hidden={{ ...base, to: "on_the_way", step_id: crypto.randomUUID() }} next={self} back={self} className={`${buttonClass} w-full`} labels={labels} data="on_the_way">
          {c.on_the_way_button}
        </CourierStep>
      )}

      {open && !o.paid && (
        <section className={cardClass} data-courier-pay>
          <span className="text-[14px] text-[#5C5C5C]">{c.customer_chose.replace("{method}", payLabel(c, o.pay_method))}</span>
          <div className="grid grid-cols-3 gap-2">
            {perms.qr && (
              <Link href={`${self}/qr`} className={choice(o.pay_method === "qr")} data-courier-pay-qr>
                {c.pay_qr}
              </Link>
            )}
            {perms.cash && (
              <Link href={`${self}/hotovost`} className={choice(o.pay_method === "cash")} data-courier-pay-cash>
                {c.pay_cash}
              </Link>
            )}
            {perms.card && (
              <Link href={`${self}?pay=card#card`} className={choice(cardOpen)} data-courier-pay-card>
                {c.pay_card}
              </Link>
            )}
          </div>
          {perms.card && cardOpen && (
            <div id="card" className="flex scroll-mt-4 flex-col gap-2 rounded-xl bg-[#F6F6F6] p-3">
              <strong className="text-[15px]">{c.card_title}</strong>
              <span className="text-[14px]">{c.card_hint.replace("{amount}", eur(o.total_cents, lang))}</span>
              <CourierStep hidden={{ ...base, pay_method: "card", step_id: crypto.randomUUID() }} next={self} back={self} className={`${ghostClass} w-full`} labels={labels} data="pay_card">
                {c.card_paid}
              </CourierStep>
            </div>
          )}
        </section>
      )}

      {o.paid && (
        <p className="rounded-xl border border-[#1E9E5A] p-3 text-[15px] font-semibold" data-courier-paid>
          {c.paid_with.replace("{method}", payLabel(c, o.pay_method))}
          {o.change_cents ? ` · ${c.change_given.replace("{amount}", eur(o.change_cents, lang))}` : ""}
        </p>
      )}

      {open && (
        <div className="flex flex-col gap-1">
          <CourierStep
            hidden={{ ...base, to: "delivered", step_id: crypto.randomUUID() }}
            next={list}
            back={self}
            className={`${buttonClass} min-h-14 w-full`}
            disabled={!o.paid || o.status !== "on_the_way"}
            labels={labels}
            data="delivered"
          >
            {c.delivered}
          </CourierStep>
          {!o.paid && <span className="text-[14px] text-[#5C5C5C]">{c.pay_first}</span>}
        </div>
      )}

      {open && (
        <details className={cardClass} data-courier-problem open={Boolean(o.problem)}>
          <summary className="flex min-h-11 cursor-pointer items-center text-[16px] font-bold">{c.problem}</summary>
          {o.problem && <p className="text-[15px]">{c.problem_shown.replace("{reason}", o.problem)}</p>}
          <CourierStep
            hidden={{ lang, fn: "problem", order_id: o.id, step_id: crypto.randomUUID() }}
            next={self}
            back={self}
            className={`${ghostClass} w-full`}
            formClassName="flex flex-col gap-2"
            labels={labels}
            data="problem"
            fields={
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-semibold">{c.problem_reason}</span>
                <textarea name="reason" required maxLength={200} rows={2} className={textareaClass} />
              </label>
            }
          >
            {c.problem_send}
          </CourierStep>
        </details>
      )}
    </>
  );
}
