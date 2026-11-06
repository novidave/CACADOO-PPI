"use client";

import { useId, useMemo, useRef, useState } from "react";
import type { Dictionary } from "@/i18n/dictionaries";
import { canContinue, type CartLine, type OrderKind, orderKinds, payNoteLine, pickKind, readyClock } from "@/lib/foodRules";
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
  | { kind: "done"; number: number; readyBy: string; timezone: string; total: number; address: string | null };

/** The moment the panel's time line counts from (taken when a quote arrives, never while drawing). */
const clockNow = () => Date.now();

const fill = (text: string, values: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (all, key: string) => (key in values ? String(values[key]) : all));

/**
 * A food order in the shop assistant (database update 73, boards 9 and 10): the cart card the answer offered (built
 * on the server from the menu's own results, priced by Sklad), "Osobný odber" / "Donáška" as two big radio buttons
 * (2026-11-06: always both, nothing chosen at first, a way the shop does not offer greyed with its reason; the address
 * field with Donáška) and the time from the database once a way is chosen, then this page's
 * own form — name, phone, a note for the courier, the consent — and the SMS code. The AI never sees any of it. The
 * customer chooses no payment method (update 85: the shop marks how it was paid at the handover); the "Objednané" box
 * carries the shop's payment note. Every price, zone, minimum and time is decided again on the server (food_quote);
 * the order is placed the moment the right code is typed (food_order_create; a retry is the same order).
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
  // 2026-11-06: both ways always, nothing chosen at first; a way the shop does not offer is greyed (aria-disabled)
  const kinds = orderKinds(state);
  const [kind, setKind] = useState<OrderKind | null>(null);
  // the line under the buttons after a tap on a greyed way
  const [kindHint, setKindHint] = useState<OrderKind | null>(null);
  // native radios: ← → move between them (and wrap), the checked one is announced
  const kindGroup = useId();
  // the moment the time line is counted from (again with every new quote)
  const [now, setNow] = useState(clockNow);
  // update 81: the same times the assistant and the owner's feed show (food_times: + today's delay)
  const pickupMin = state.ready_pickup_min ?? state.prep_minutes ?? 20;
  const deliveryMin = state.ready_delivery_min ?? state.delivery_minutes ?? 45;
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

  /** The price rule again (only the newest answer counts); before a choice without a kind (the price without a fee). */
  async function requote(next: { cart?: CartLine[]; kind?: "pickup" | "delivery"; address?: string }) {
    const lines = next.cart ?? cart;
    if (!lines.length) return;
    const ticket = ++latest.current;
    setBusy(true);
    try {
      const k = next.kind ?? kind;
      const { ok, data } = await post({
        action: "quote", lines, ...(k ? { kind: k } : {}), address: k === "delivery" ? (next.address ?? address) : null,
      });
      if (ticket !== latest.current) return;
      if (ok && data.quote) {
        const q = data.quote as Quote;
        setQuote(q);
        setNow(clockNow());
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

  function chooseKind(k: OrderKind) {
    if (pickKind(kinds, k) !== k) {
      setKindHint(k);
      return;
    }
    setKindHint(null);
    if (k === kind) return;
    setKind(k);
    void requote({ kind: k });
  }

  async function sendCode(form: FormData) {
    const conv = conversation();
    if (!conv) {
      setError(errorText("conversation"));
      return;
    }
    if (!kind) {
      setError(labels.order_kind_pick);
      setStep({ kind: "cart" });
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
        const typed = address.trim();
        if (!typed) {
          setError(errorText("no_address"));
          return;
        }
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
    if (!kind) return; // never an order without the customer's own choice
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
        address: kind === "delivery" ? address.trim() : null,
        note: noteRef.current,
        conversation: conv,
        lang,
      });
      if (ok && data.order) {
        const o = data.order as { number: number; ready_by: string; timezone: string; total_cents: number; address: string | null };
        setStep({ kind: "done", number: o.number, readyBy: o.ready_by, timezone: o.timezone, total: o.total_cents, address: o.address });
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

  // update 85: the kind buttons — the chosen one black with white bold text, the other white with a 1.5 px line;
  // 2026-11-06: a way the shop does not offer is greyed (never selectable)
  const kindButton = (on: boolean, available: boolean) =>
    `flex min-h-[52px] items-center justify-center gap-1.5 rounded-xl px-2 text-center text-[15px] leading-tight min-[360px]:whitespace-nowrap has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[#2563EB] ${
      !available
        ? "cursor-not-allowed border-[1.5px] border-[#E2E2E2] bg-[#F4F4F4] font-semibold text-[#9A9A9A]"
        : on
          ? "cursor-pointer bg-foreground font-bold text-white"
          : "cursor-pointer border-[1.5px] border-[#E2E2E2] bg-white font-semibold"
    }`;
  // the time from the database (food_quote's ready_minutes for this kind, else food_state's), as a clock time
  const minutes = quote.kind === kind && quote.ready_minutes ? quote.ready_minutes : kind === "delivery" ? deliveryMin : pickupMin;
  const clock = readyClock(now, minutes, lang, quote.state?.timezone ?? state.timezone);
  const payNote = payNoteLine(state.pay_note, order.pay_note_translated, labels.order_pay_note_default);
  const primary = "inline-flex min-h-12 w-full items-center justify-center rounded-[10px] border border-foreground bg-foreground px-4 font-semibold text-white disabled:opacity-60";
  const field = "min-h-12 w-full rounded-[10px] border border-[#D6D6D6] px-3 text-base";

  if (step.kind === "done") {
    const time = new Intl.DateTimeFormat(lang, { timeZone: step.timezone, hour: "2-digit", minute: "2-digit" }).format(new Date(step.readyBy));
    return (
      <section aria-live="polite" className="flex flex-col gap-2 rounded-[14px] bg-[#F5F5F5] p-3.5" data-order-done={step.number}>
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
          {payNote && (
            <dd className="col-span-2 text-[15px]" data-order-pay-note>
              {payNote}
            </dd>
          )}
          {step.address && (
            <>
              <dt className="text-muted">{labels.order_done_address}</dt>
              <dd>{step.address}</dd>
            </>
          )}
          <dt className="text-muted">{labels.order_total}</dt>
          <dd>{money(step.total)}</dd>
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
          <li className="grid grid-cols-[1fr_auto] gap-x-3 border-b border-line py-2 text-[15px]" data-order-fee>
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
      {step.kind !== "cart" && kind && (
        <p className="text-[13px] text-muted" data-order-time>
          {fill(kind === "delivery" ? labels.order_delivery_by : labels.order_ready_at, { time: clock })}
        </p>
      )}
      {state.long_delay && kind && (
        <p className="text-[13px] font-semibold" role="status" data-order-long-wait>
          {fill(kind === "delivery" ? labels.order_long_wait_delivery : labels.order_long_wait, { n: kind === "delivery" ? deliveryMin : pickupMin })}
        </p>
      )}

      {step.kind === "cart" && (
        <>
          <fieldset className="flex flex-col gap-2" data-order-kinds>
            <legend className="sr-only">{labels.order_kind_label}</legend>
            <div className="grid grid-cols-2 gap-2">
              {kinds.map(({ kind: k, available }) => (
                <label key={k} className={kindButton(kind === k, available)} data-order-kind={k}
                  data-order-kind-off={available ? undefined : ""}>
                  <input
                    type="radio"
                    name={kindGroup}
                    value={k}
                    checked={kind === k}
                    aria-disabled={available ? undefined : true}
                    aria-describedby={available ? undefined : `${kindGroup}-${k}-off`}
                    onChange={() => chooseKind(k)}
                    onClick={() => {
                      if (!available) setKindHint(k);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        chooseKind(k);
                      }
                    }}
                    className="sr-only"
                  />
                  {k === "pickup" ? <BagIcon /> : <ScooterIcon />}
                  <span>{k === "pickup" ? labels.order_pickup : labels.order_delivery}</span>
                </label>
              ))}
            </div>
            {kinds.filter((k) => !k.available).map(({ kind: k }) => (
              <p key={k} id={`${kindGroup}-${k}-off`} role={kindHint === k ? "alert" : undefined}
                className={kindHint === k ? "text-[14px] font-semibold" : "sr-only"} data-order-kind-off-line={k}>
                {k === "delivery" ? labels.order_delivery_off : labels.order_pickup_off}
              </p>
            ))}
            {kind ? (
              <p className="text-[14px] font-semibold" data-order-time>
                {fill(kind === "delivery" ? labels.order_delivery_by : labels.order_ready_at, { time: clock })}
              </p>
            ) : (
              <p className="text-[14px] text-muted" data-order-kind-pick>
                {labels.order_kind_pick}
              </p>
            )}
          </fieldset>
          {kind === "delivery" && (
            <label className="flex flex-col gap-1 text-[13px] font-semibold">
              {labels.order_address}
              <input
                name="address"
                maxLength={300}
                autoComplete="street-address"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                onBlur={() => {
                  if (address.trim()) void requote({ address: address.trim() });
                }}
                className={field}
                data-order-address
              />
            </label>
          )}
          {error && <p role="alert" className="text-sm font-semibold">{error}</p>}
          <button type="button" className={primary} disabled={busy || !canContinue(kind, kinds, quote.lines.length)}
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
          {step.testCode && <p className="text-sm" data-order-test-code={step.testCode}>{fill(labels.order_test_code, { code: step.testCode })}</p>}
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

function BagIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="flex-none">
      <path d="M5 8h14l-1 12H6L5 8z" />
      <path d="M9 8V6a3 3 0 0 1 6 0v2" />
    </svg>
  );
}

function ScooterIcon() {
  return (
    <svg width="20" height="18" viewBox="0 0 26 24" className="flex-none" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="6" cy="17" r="3" />
      <circle cx="20" cy="17" r="3" />
      <path d="M9 17h8l-2-8h-3" />
      <path d="M15 9l2-4h3" />
      <path d="M3 12h7" />
    </svg>
  );
}
