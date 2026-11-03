"use client";

import { useMemo, useRef, useState } from "react";
import type { Dictionary } from "@/i18n/dictionaries";
import type { CartLine, PayMethod } from "@/lib/foodRules";
import type { ChatOrder } from "@/lib/shopChat";
import type { Quote } from "@/lib/food";

type Labels = Dictionary["chat"];

interface Conversation {
  id: string;
  token: string;
}

type Step =
  | { kind: "cart" }
  | { kind: "form" }
  | { kind: "code"; id: string; phone: string; testCode: string | null; sentAt: number }
  | { kind: "done"; number: number; readyBy: string; timezone: string; total: number; pay: PayMethod; address: string | null };

const fill = (text: string, values: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (all, key: string) => (key in values ? String(values[key]) : all));

/**
 * A food order in the shop assistant (database update 73, boards 9 and 10): the cart card the answer offered (built
 * on the server from the menu's own results, priced by Sklad), pickup or delivery, the payment on receipt, then this
 * page's own form — name, phone, the delivery address, a note for the courier, the consent — and the SMS code. The
 * AI never sees any of it. Every price, zone, minimum and time is decided again on the server (food_quote); the order
 * is placed the moment the right code is typed (food_order_create; a retry is the same order).
 */
export default function OrderPanel({
  base,
  lang,
  shopName,
  order,
  conversation,
  privacyHref,
  labels,
}: {
  base: string;
  lang: string;
  shopName: string;
  order: ChatOrder;
  conversation: () => Conversation | null;
  privacyHref: string;
  labels: Labels;
}) {
  const state = order.state;
  const [quote, setQuote] = useState<Quote>(order.quote);
  const [cart, setCart] = useState<CartLine[]>(() =>
    order.quote.lines.map((l) => ({ item_id: l.item_id, qty: l.qty, extras: l.extras.map((x) => x.item_id) })),
  );
  const [kind, setKind] = useState<"pickup" | "delivery">(order.kind);
  const firstPay: PayMethod = state.pay?.qr ? "qr" : state.pay?.cash ? "cash" : "card";
  const [pay, setPay] = useState<PayMethod>(firstPay);
  const [address, setAddress] = useState("");
  const [step, setStep] = useState<Step>({ kind: "cart" });
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const latest = useRef(0);
  const noteRef = useRef("");
  const euro = useMemo(() => new Intl.NumberFormat(lang, { style: "currency", currency: "EUR" }), [lang]);
  const money = (cents: number) => euro.format(cents / 100);

  const errorText = (reason: string | undefined, attempts?: number | null, min?: number | null) => {
    const key = `order_err_${reason ?? "failed"}` as keyof Labels;
    const text = (labels[key] as string | undefined) ?? labels.order_err_failed;
    return fill(text, { n: attempts ?? 0, min: min ? money(min) : "" });
  };

  async function post(body: Record<string, unknown>) {
    const res = await fetch(`${base}/order`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, data };
  }

  /** The price rule again (only the newest answer counts). */
  async function requote(next: { cart?: CartLine[]; kind?: "pickup" | "delivery"; address?: string }) {
    const lines = next.cart ?? cart;
    if (!lines.length) return;
    const ticket = ++latest.current;
    setBusy(true);
    try {
      const k = next.kind ?? kind;
      const { ok, data } = await post({ action: "quote", lines, kind: k, address: k === "delivery" ? (next.address ?? address) : null });
      if (ticket !== latest.current) return;
      if (ok && data.quote) {
        const q = data.quote as Quote;
        setQuote(q);
        setError(q.problem && !(q.problem === "no_address" && !(next.address ?? address)) ? errorText(q.problem, null, q.minimum_cents) : null);
      } else {
        setError(errorText(String(data.error ?? "failed")));
      }
    } catch {
      setError(labels.order_err_failed);
    } finally {
      if (ticket === latest.current) setBusy(false);
    }
  }

  function changeQty(i: number, delta: number) {
    const next = cart.map((l, j) => (j === i ? { ...l, qty: Math.min(50, l.qty + delta) } : l)).filter((l) => l.qty > 0);
    setCart(next);
    if (next.length) void requote({ cart: next });
    else setQuote({ ...quote, lines: [], subtotal_cents: 0, total_cents: 0, delivery_cents: 0 });
  }

  function chooseKind(k: "pickup" | "delivery") {
    setKind(k);
    void requote({ kind: k });
  }

  async function sendCode(form: FormData) {
    const conv = conversation();
    if (!conv) {
      setError(errorText("conversation"));
      return;
    }
    if (form.get("consent") !== "on") {
      setError(errorText("consent"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (kind === "delivery") {
        const typed = String(form.get("address") ?? "").trim();
        setAddress(typed);
        const { ok, data } = await post({ action: "quote", lines: cart, kind, address: typed });
        const q = data.quote as Quote | undefined;
        if (!ok || !q) {
          setError(errorText(String(data.error ?? "failed")));
          return;
        }
        setQuote(q);
        if (!q.orderable) {
          setError(errorText(q.problem ?? "failed", null, q.minimum_cents));
          return;
        }
      } else if (!quote.orderable) {
        setError(errorText(quote.problem ?? "failed", null, quote.minimum_cents));
        return;
      }
      const { ok, data } = await post({
        action: "code",
        name: form.get("name"),
        phone: form.get("phone"),
        consent: true,
        conversation: conv,
        lang,
      });
      if (!ok) {
        setError(errorText(String(data.error ?? "failed")));
        return;
      }
      noteRef.current = String(form.get("note") ?? "");
      setStep({
        kind: "code",
        id: String(data.id),
        phone: String(data.phone ?? ""),
        testCode: typeof data.test_code === "string" ? data.test_code : null,
        sentAt: Date.now(),
      });
    } catch {
      setError(labels.order_err_failed);
    } finally {
      setBusy(false);
    }
  }

  async function place(form: FormData, s: Extract<Step, { kind: "code" }>) {
    const conv = conversation();
    setBusy(true);
    setError(null);
    try {
      const { ok, data } = await post({
        action: "place",
        code_id: s.id,
        code: form.get("code"),
        order_id: order.order_id,
        lines: cart,
        kind,
        pay_method: pay,
        address: kind === "delivery" ? address : null,
        note: noteRef.current,
        conversation: conv,
        lang,
      });
      if (ok && data.order) {
        const o = data.order as { number: number; ready_by: string; timezone: string; total_cents: number; pay_method: PayMethod; address: string | null };
        setStep({ kind: "done", number: o.number, readyBy: o.ready_by, timezone: o.timezone, total: o.total_cents, pay: o.pay_method, address: o.address });
        return;
      }
      setError(errorText(String(data.error ?? "failed"), typeof data.attempts_left === "number" ? data.attempts_left : null,
        (data.quote as Quote | undefined)?.minimum_cents ?? null));
      if (data.error === "expired" || data.error === "too_many_attempts" || data.error === "not_found") setStep({ kind: "form" });
      else if (data.error !== "wrong_code") setStep({ kind: "cart" });
    } catch {
      setError(labels.order_err_failed);
    } finally {
      setBusy(false);
    }
  }

  const payLabel = (m: PayMethod) => ({ qr: labels.order_pay_qr, cash: labels.order_pay_cash, card: labels.order_pay_card })[m];
  const methods = (["qr", "cash", "card"] as PayMethod[]).filter((m) => state.pay?.[m]);
  const seg = (on: boolean) =>
    `flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-[10px] bg-white px-2 text-sm font-semibold ${
      on ? "border-2 border-foreground" : "border border-[#D6D6D6]"
    }`;
  const primary = "inline-flex min-h-12 w-full items-center justify-center rounded-[10px] border border-foreground bg-foreground px-4 font-semibold text-white disabled:opacity-60";
  const field = "min-h-12 w-full rounded-[10px] border border-[#D6D6D6] px-3 text-base";

  if (step.kind === "done") {
    const time = new Intl.DateTimeFormat(lang, { timeZone: step.timezone, hour: "2-digit", minute: "2-digit" }).format(new Date(step.readyBy));
    return (
      <section aria-live="polite" className="flex flex-col gap-2 rounded-[14px] bg-[#F5F5F5] p-3.5" data-order-done>
        <strong className="flex items-center gap-2 text-lg">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M8 12.5l2.5 2.5L16 9.5" />
          </svg>
          {fill(labels.order_done, { n: step.number })}
        </strong>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[15px]">
          <dt className="text-muted">{kind === "delivery" ? labels.order_done_delivery : labels.order_done_pickup}</dt>
          <dd className="font-bold">{fill(labels.order_done_by, { time })}</dd>
          {step.address && (
            <>
              <dt className="text-muted">{labels.order_done_address}</dt>
              <dd>{step.address}</dd>
            </>
          )}
          <dt className="text-muted">{labels.order_done_pay}</dt>
          <dd>{fill(labels.order_done_pay_line, { method: payLabel(step.pay), total: money(step.total) })}</dd>
        </dl>
        <p className="text-[13px] text-muted">{labels.order_done_note}</p>
      </section>
    );
  }

  return (
    <section aria-label={labels.order_title} className="flex flex-col gap-2.5 rounded-[14px] border border-[#D6D6D6] p-3.5" data-order-panel>
      <div className="flex items-baseline justify-between">
        <h3 className="text-[17px] font-bold">{labels.order_title}</h3>
        {step.kind === "cart" && (
          <button type="button" onClick={() => setEditing((e) => !e)} className="min-h-11 text-sm underline underline-offset-4" data-order-edit>
            {editing ? labels.order_edit_done : labels.order_edit}
          </button>
        )}
      </div>
      <ul className="flex flex-col border-t border-line">
        {quote.lines.map((line, i) => (
          <li key={`${line.item_id}-${i}`} className="grid grid-cols-[1fr_auto] gap-x-3 border-b border-line py-2 text-[15px]">
            <span>
              {line.qty}× {line.name}
              {line.extras.map((x) => (
                <span key={x.item_id} className="block text-[13px] text-muted">
                  {fill(labels.order_extra_line, { name: x.name, price: money(x.unit_cents) })}
                </span>
              ))}
            </span>
            <span className="text-right">{money(line.line_cents)}</span>
            {editing && step.kind === "cart" && (
              <span className="col-span-2 mt-1 flex items-center gap-2">
                <button type="button" onClick={() => changeQty(i, -1)} aria-label={`${labels.order_less}: ${line.name}`}
                  className="flex size-11 items-center justify-center rounded-[10px] border border-[#D6D6D6] text-lg font-bold">
                  −
                </button>
                <span className="min-w-6 text-center font-semibold tabular-nums">{line.qty}</span>
                <button type="button" onClick={() => changeQty(i, 1)} aria-label={`${labels.order_more}: ${line.name}`}
                  className="flex size-11 items-center justify-center rounded-[10px] border border-[#D6D6D6] text-lg font-bold">
                  +
                </button>
                <button type="button" onClick={() => changeQty(i, -line.qty)} className="ml-auto min-h-11 text-sm underline underline-offset-4">
                  {labels.order_remove}
                </button>
              </span>
            )}
          </li>
        ))}
        {kind === "delivery" && quote.zone && (
          <li className="grid grid-cols-[1fr_auto] gap-x-3 border-b border-line py-2 text-[15px]">
            <span>{fill(labels.order_delivery_line, { zone: quote.zone.name })}</span>
            <span className="text-right">{money(quote.delivery_cents)}</span>
          </li>
        )}
        <li className="grid grid-cols-[1fr_auto] gap-x-3 py-2 text-[17px] font-bold">
          <span>{labels.order_total}</span>
          <span className="text-right" data-order-total>{money(quote.total_cents)}</span>
        </li>
      </ul>
      {quote.refused.length > 0 && (
        <p className="text-sm" role="status">{fill(labels.order_refused, { names: quote.refused.map((r) => r.name ?? "–").join(", ") })}</p>
      )}
      <p className="text-[13px] text-muted">
        {kind === "delivery"
          ? fill(labels.order_times, { prep: state.prep_minutes ?? 20, delivery: state.delivery_minutes ?? 45 })
          : fill(labels.order_times_pickup, { prep: state.prep_minutes ?? 20 })}
      </p>

      {step.kind === "cart" && (
        <>
          {state.pickup && state.delivery && (
            <div role="group" aria-label={labels.order_kind_label} className="flex gap-2">
              <button type="button" aria-pressed={kind === "pickup"} onClick={() => chooseKind("pickup")} className={seg(kind === "pickup")}>
                {labels.order_pickup}
              </button>
              <button type="button" aria-pressed={kind === "delivery"} onClick={() => chooseKind("delivery")} className={seg(kind === "delivery")}>
                {labels.order_delivery}
              </button>
            </div>
          )}
          <span className="text-sm font-bold">{labels.order_pay_label}</span>
          <div role="group" aria-label={labels.order_pay_label} className="flex gap-2">
            {methods.map((m) => (
              <button key={m} type="button" aria-pressed={pay === m} onClick={() => setPay(m)} className={seg(pay === m)}>
                {m === "qr" && (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <rect x="3" y="3" width="7" height="7" />
                    <rect x="14" y="3" width="7" height="7" />
                    <rect x="3" y="14" width="7" height="7" />
                    <path d="M14 14h3v3h-3zM20 14v.01M20 20h-6" />
                  </svg>
                )}
                {payLabel(m)}
              </button>
            ))}
          </div>
          <p className="text-[13px] text-muted">
            {pay === "qr" ? labels.order_pay_hint_qr : pay === "cash" ? labels.order_pay_hint_cash : labels.order_pay_hint_card}
          </p>
          {error && <p role="alert" className="text-sm font-semibold">{error}</p>}
          <button type="button" className={primary} disabled={busy || !quote.lines.length}
            onClick={() => {
              setError(null);
              setEditing(false);
              setStep({ kind: "form" });
            }}
            data-order-continue>
            {labels.order_continue}
          </button>
        </>
      )}

      {step.kind === "form" && (
        <form
          className="flex flex-col gap-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            void sendCode(new FormData(e.currentTarget));
          }}
          aria-label={labels.order_details}
        >
          <label className="flex flex-col gap-1 text-[13px] font-semibold">
            {labels.order_name}
            <input name="name" required maxLength={80} autoComplete="name" className={field} />
          </label>
          <label className="flex flex-col gap-1 text-[13px] font-semibold">
            {labels.order_phone}
            <input name="phone" type="tel" required maxLength={40} autoComplete="tel" className={field} />
            <span className="font-normal text-muted">{labels.order_phone_hint}</span>
          </label>
          {kind === "delivery" && (
            <label className="flex flex-col gap-1 text-[13px] font-semibold">
              {labels.order_address}
              <input name="address" required maxLength={300} autoComplete="street-address" defaultValue={address} className={field} />
            </label>
          )}
          <label className="flex flex-col gap-1 text-[13px] font-semibold">
            <span>
              {labels.order_note} <span className="font-medium text-muted">{labels.order_optional}</span>
            </span>
            <input name="note" maxLength={300} className={field} />
          </label>
          <label className="flex items-start gap-2 text-[13px]">
            <input type="checkbox" name="consent" className="mt-0.5 size-5 flex-none accent-foreground" />
            <span>
              {fill(labels.order_consent, { shop: shopName })}{" "}
              <a href={privacyHref} target="_blank" rel="noopener" className="underline underline-offset-4">
                {labels.order_privacy}
              </a>
            </span>
          </label>
          {error && <p role="alert" className="text-sm font-semibold">{error}</p>}
          <button type="submit" className={primary} disabled={busy} data-order-send-code>
            {busy ? labels.order_busy : labels.order_send_code}
          </button>
          <button type="button" onClick={() => setStep({ kind: "cart" })} className="min-h-11 text-sm underline underline-offset-4">
            {labels.order_back}
          </button>
        </form>
      )}

      {step.kind === "code" && (
        <form
          className="flex flex-col gap-2.5 rounded-[14px] border-2 border-foreground p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void place(new FormData(e.currentTarget), step);
          }}
        >
          <strong className="text-[15px]">{fill(labels.order_code_sent, { phone: step.phone })}</strong>
          {step.testCode && <p className="text-sm">{fill(labels.order_test_code, { code: step.testCode })}</p>}
          <label className="flex flex-col gap-1 text-[13px] font-semibold">
            {labels.order_code}
            <input name="code" required inputMode="numeric" autoComplete="one-time-code" maxLength={12}
              className="min-h-12 rounded-[10px] border border-[#D6D6D6] px-3 text-lg font-bold tracking-[3px]" data-order-code />
          </label>
          {error && <p role="alert" className="text-sm font-semibold">{error}</p>}
          <button type="submit" className={primary} disabled={busy} data-order-place>
            {busy ? labels.order_busy : fill(labels.order_place, { total: money(quote.total_cents) })}
          </button>
          <p className="text-[12px] text-muted">{labels.order_pay_on_receipt}</p>
          <button type="button" onClick={() => setStep({ kind: "form" })} className="min-h-11 text-sm underline underline-offset-4">
            {labels.order_resend}
          </button>
        </form>
      )}
    </section>
  );
}
