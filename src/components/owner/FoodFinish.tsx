"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatTime } from "@/lib/format";
import { type FeedPay, fill, finishNeeds, finishTarget, reopenable, sortDone } from "@/lib/foodFeed";
import type { FeedCard, FoodFeed } from "@/lib/foodOwner";
import { cashChoices, money } from "@/lib/foodRules";
import {
  feedOrderQr,
  finishFeedOrder,
  loadFeed,
  reopenFeedOrder,
} from "@/app/[lang]/(account)/dashboard/assistant/orders/feedActions";

/**
 * Objednávky jedla → the kitchen board's finishing steps (2026-11-07, the feed's dialogs kept when the feed went): a
 * card whose next step is "Vyzdvihnuté" / "Doručené" (or, with the courier app, handing it on) opens what that finish
 * needs first — "Prideliť" (a courier) or the payment choice (only the methods that are on; cash with Presne, the
 * quick amounts and the change; QR with the order's PAY by square code) — and then food_order_finish (ONE transaction,
 * the step's own UUID: a double tap is the same step). "Vrátiť" (food_order_reopen, the same day only) on Doručené
 * cards; "Zobraziť staršie (n)" lists the last 7 days. After every answer the page is drawn again (router.refresh), so
 * the board never guesses; the toast "Objednávka #n vybavená · Späť" (BoardToast) reopens it.
 */

export type BoardLabels = Record<string, string>;

/** The toast's message between the buttons (they may be gone when the board is drawn again) and BoardToast. */
const TOAST_EVENT = "ppi:food-toast";
type ToastDetail = { text: string; error?: boolean; undo?: { shopId: string; orderId: string; number: number } };
const toast = (detail: ToastDetail) => window.dispatchEvent(new CustomEvent<ToastDetail>(TOAST_EVENT, { detail }));
const errorText = (labels: BoardLabels, code: string) => labels[code] ?? labels.err_failed;

/** "Vyzdvihnuté" / "Doručené" on a board card: the courier or the payment first when needed, then the finish. */
export function FinishButton({
  shopId,
  lang,
  order,
  parts,
  methods,
  couriers,
  couriersHref,
  qrHref,
  labels,
  className,
  children,
}: {
  shopId: string;
  lang: string;
  order: FeedCard;
  parts: FoodFeed["parts"];
  methods: FeedPay[];
  couriers: { id: string; name: string }[];
  couriersHref: string;
  /** the order's page (the QR full screen) — only with the QR terminal */
  qrHref: string | null;
  labels: BoardLabels;
  className: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [open, setOpen] = useState<"payment" | "courier" | null>(null);
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const loadQr = useCallback(() => feedOrderQr(shopId, order.id, lang), [shopId, order.id, lang]);

  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  const finish = async (pay: FeedPay | null = null, cash: number | null = null, courier: string | null = null) => {
    setOpen(null);
    setBusy(true);
    const to = courier ? "on_the_way" : finishTarget(order, parts);
    const res = await finishFeedOrder(shopId, order.id, crypto.randomUUID(), pay, cash, courier, courier ? crypto.randomUUID() : null);
    setBusy(false);
    if (!res.ok) {
      toast({ text: errorText(labels, res.error), error: true });
    } else if (res.sms) {
      toast({ text: res.sms === "sent" ? labels.ok_sms : labels.err_sms_failed, error: res.sms !== "sent" });
    } else {
      toast({
        text: fill(to === "on_the_way" ? labels.feed_toast_on_way : labels.feed_toast_done, { n: order.number }),
        undo: { shopId, orderId: order.id, number: order.number },
      });
    }
    router.refresh();
  };

  return (
    <>
      <button
        type="button"
        disabled={busy}
        className={className}
        onClick={() => {
          const needs = finishNeeds(order, parts);
          if (needs) setOpen(needs);
          else void finish();
        }}
        data-food-finish={order.id}
      >
        {children}
      </button>
      <dialog
        ref={dialogRef}
        onClose={() => setOpen(null)}
        className="m-auto w-[min(92vw,460px)] rounded-2xl border border-line p-0 backdrop:bg-black/40"
        data-food-dialog={open ?? undefined}
      >
        {open === "payment" && (
          <PaymentChoice
            o={order}
            labels={labels}
            lang={lang}
            methods={methods}
            qrHref={qrHref}
            loadQr={loadQr}
            onClose={() => setOpen(null)}
            onPaid={(pay, cash) => void finish(pay, cash)}
          />
        )}
        {open === "courier" && (
          <CourierChoice
            o={order}
            labels={labels}
            couriers={couriers}
            couriersHref={couriersHref}
            onClose={() => setOpen(null)}
            onPick={(id) => void finish(null, null, id)}
          />
        )}
      </dialog>
    </>
  );
}

/** "Vrátiť" on a Doručené card: back to its last step (the same day only — "too_late" otherwise, said by SQL). */
export function ReopenButton({ shopId, order, labels }: { shopId: string; order: Pick<FeedCard, "id" | "number" | "status">; labels: BoardLabels }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  if (!reopenable(order)) return null;
  return (
    <button
      type="button"
      disabled={busy}
      className="min-h-11 rounded-lg border border-[#C8C8C8] bg-white px-3 text-sm font-semibold"
      aria-label={fill(labels.feed_reopen_label, { n: order.number })}
      onClick={async () => {
        setBusy(true);
        const res = await reopenFeedOrder(shopId, order.id, crypto.randomUUID());
        setBusy(false);
        toast(res.ok ? { text: fill(labels.feed_toast_back, { n: order.number }) } : { text: errorText(labels, res.error), error: true });
        router.refresh();
      }}
      data-food-reopen={order.id}
    >
      {labels.feed_reopen}
    </button>
  );
}

/** "Zobraziť staršie (n)": the last 7 days under Doručené (read when asked). */
export function OlderOrders({
  shopId,
  count,
  lang,
  timezone,
  labels,
  detailBase,
}: {
  shopId: string;
  count: number;
  lang: string;
  timezone: string;
  labels: BoardLabels;
  detailBase: { path: string; query: string };
}) {
  const [older, setOlder] = useState<FeedCard[] | null>(null);
  const [busy, setBusy] = useState(false);
  if (count <= 0) return null;
  const hm = (iso: string | null) => (iso ? formatTime(new Date(iso), timezone) : "");
  if (!older) {
    return (
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          const res = await loadFeed(shopId, true);
          setBusy(false);
          if (res.ok) setOlder(res.feed.older ?? []);
          else toast({ text: errorText(labels, res.error), error: true });
        }}
        className="min-h-11 self-start px-1 text-sm font-semibold underline underline-offset-4"
        data-food-older
      >
        {fill(labels.feed_older, { n: count })}
      </button>
    );
  }
  return (
    <div className="flex flex-col gap-1.5" data-food-older-list>
      <h3 className="px-1 text-sm font-bold text-muted">{labels.feed_older_title}</h3>
      {sortDone(older).map((o) => (
        <Link
          key={o.id}
          href={`${detailBase.path}${o.id}${detailBase.query}`}
          className="flex flex-wrap items-baseline gap-x-2 rounded-lg bg-white px-3 py-2 text-sm text-[#5C5C5C]"
        >
          <span className="font-bold tabular-nums">
            {o.order_day.slice(8, 10)}.{o.order_day.slice(5, 7)}. {hm(o.created_at)}
          </span>
          <span className="font-semibold text-foreground">
            #{o.number}
            {o.name ? ` · ${o.name}` : ""}
          </span>
          <span className="tabular-nums">{o.status === "cancelled" ? labels.feed_cancelled : money(o.total_cents, lang, o.currency)}</span>
        </Link>
      ))}
    </div>
  );
}

/** The board's one toast: "Objednávka #n vybavená · Späť" (5 s), errors in red; announced to screen readers. */
export function BoardToast({ labels }: { labels: BoardLabels }) {
  const router = useRouter();
  const [shown, setShown] = useState<ToastDetail | null>(null);
  const [said, setSaid] = useState("");
  const timer = useRef<number | null>(null);
  useEffect(() => {
    const on = (e: Event) => {
      const detail = (e as CustomEvent<ToastDetail>).detail;
      setShown(detail);
      setSaid(detail.text);
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setShown(null), 5000);
    };
    window.addEventListener(TOAST_EVENT, on);
    return () => {
      window.removeEventListener(TOAST_EVENT, on);
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, []);
  return (
    <>
      {shown && (
        <div
          className={`fixed inset-x-4 bottom-4 z-40 mx-auto flex max-w-md items-center justify-between gap-3 rounded-xl px-4 py-3 text-white shadow-lg ${shown.error ? "bg-[#B42318]" : "bg-foreground"}`}
          data-food-toast
        >
          <span className="min-w-0">{shown.text}</span>
          {shown.undo && (
            <button
              type="button"
              className="min-h-11 flex-none px-2 font-bold underline underline-offset-4"
              onClick={async () => {
                const undo = shown.undo!;
                setShown(null);
                const res = await reopenFeedOrder(undo.shopId, undo.orderId, crypto.randomUUID());
                const text = res.ok ? fill(labels.feed_toast_back, { n: undo.number }) : errorText(labels, res.error);
                setSaid(text);
                if (!res.ok) setShown({ text, error: true });
                router.refresh();
              }}
              data-food-undo
            >
              {labels.feed_undo}
            </button>
          )}
        </div>
      )}
      <span className="sr-only" aria-live="polite">
        {said}
      </span>
    </>
  );
}

/** "Ako zákazník zaplatil?": only the methods that are on; cash with the quick amounts and the change; QR drawn here. */
function PaymentChoice({
  o,
  labels,
  lang,
  methods,
  qrHref,
  loadQr,
  onClose,
  onPaid,
}: {
  o: FeedCard;
  labels: BoardLabels;
  lang: string;
  methods: FeedPay[];
  qrHref: string | null;
  /** the order's PAY by square code inside the dialog (feedOrderQr; null = no IBAN / already paid) */
  loadQr: () => Promise<{ svg: string; payee: string; iban: string; vs: string } | null>;
  onClose: () => void;
  onPaid: (pay: FeedPay, cash: number | null) => void;
}) {
  const [method, setMethod] = useState<FeedPay | null>(o.pay_method && methods.includes(o.pay_method) ? o.pay_method : (methods[0] ?? null));
  const [given, setGiven] = useState<number | null>(null);
  const [other, setOther] = useState("");
  const otherCents = other.trim() ? Math.round(Number(other.replace(",", ".")) * 100) : null;
  const cash = method === "cash" ? (otherCents ?? given) : null;
  const tooLittle = method === "cash" && cash !== null && (!Number.isFinite(cash) || cash < o.total_cents);
  // the QR is drawn on the server once, the first time "QR" is chosen (with the QR terminal on)
  const [qr, setQr] = useState<{ svg: string; payee: string; iban: string; vs: string } | null | "loading" | undefined>(undefined);
  const askedQr = useRef(false);
  const wantQr = method === "qr" && qrHref !== null;
  useEffect(() => {
    if (!wantQr || askedQr.current) return;
    askedQr.current = true;
    let live = true;
    void Promise.resolve()
      .then(() => live && setQr("loading"))
      .then(() => loadQr())
      .catch(() => null)
      .then((answer) => live && setQr(answer ?? null));
    return () => {
      live = false;
      askedQr.current = false;
    };
  }, [wantQr, loadQr]);
  return (
    <div className="flex flex-col gap-4 p-5" data-food-pay>
      <h2 className="text-lg font-bold">{fill(labels.feed_pay_title, { n: o.number, total: money(o.total_cents, lang, o.currency) })}</h2>
      <div className="flex flex-wrap gap-2" role="group">
        {methods.map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={method === m}
            onClick={() => setMethod(m)}
            className={`min-h-12 flex-1 rounded-xl px-3 font-semibold ${method === m ? "border-2 border-foreground bg-foreground text-white" : "border border-line"}`}
            data-food-pay-method={m}
          >
            {labels[`pay_${m}`]}
          </button>
        ))}
      </div>
      {method === "qr" && qrHref && (
        <div className="flex flex-col items-center gap-2" data-food-qr={qr === "loading" || qr === undefined ? "loading" : qr ? "ready" : "none"}>
          {qr && qr !== "loading" ? (
            <>
              <div
                role="img"
                aria-label={fill(labels.feed_qr_alt, { total: money(o.total_cents, lang, o.currency) })}
                className="w-[min(100%,260px)] rounded-xl border border-line bg-white p-2 [&_svg]:h-auto [&_svg]:w-full"
                // the SVG is drawn by our own server (payBySquareSvg), never from the browser or the order's text
                dangerouslySetInnerHTML={{ __html: qr.svg }}
              />
              <span className="text-center text-sm text-muted">{fill(labels.feed_qr_line, { payee: qr.payee, vs: qr.vs })}</span>
            </>
          ) : qr === null ? (
            <span className="text-sm text-muted">{labels.feed_qr_none}</span>
          ) : (
            <span className="text-sm text-muted" aria-live="polite">
              {labels.feed_qr_loading}
            </span>
          )}
          <Link href={qrHref} className="font-semibold underline underline-offset-4" data-food-show-qr>
            {qr && qr !== "loading" ? labels.feed_qr_full : labels.feed_show_qr}
          </Link>
        </div>
      )}
      {method === "cash" && (
        <div className="flex flex-col gap-2">
          <span className="font-semibold">{labels.cash_title}</span>
          <div className="flex flex-wrap gap-2">
            {[o.total_cents, ...cashChoices(o.total_cents).filter((c) => c !== o.total_cents)].map((c, i) => (
              <button
                key={c}
                type="button"
                aria-pressed={given === c && !other}
                onClick={() => {
                  setGiven(c);
                  setOther("");
                }}
                className={`min-h-11 rounded-lg px-3 font-semibold tabular-nums ${given === c && !other ? "border-2 border-foreground" : "border border-line"}`}
                data-food-cash={c}
              >
                {i === 0 ? labels.cash_exact : money(c, lang, o.currency)}
              </button>
            ))}
          </div>
          <label className="flex flex-col gap-1 text-sm">
            {labels.cash_other}
            <input inputMode="decimal" value={other} onChange={(e) => setOther(e.target.value)} className="min-h-11 rounded-lg border border-line px-3 text-base" />
          </label>
          {cash !== null && !tooLittle && cash > o.total_cents && (
            <strong className="text-lg">{fill(labels.cash_change, { amount: money(cash - o.total_cents, lang, o.currency) })}</strong>
          )}
          {tooLittle && <span className="text-sm text-[#B42318]">{labels.cash_hint}</span>}
        </div>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" onClick={onClose} className="min-h-11 rounded-xl border border-line px-4 font-semibold">
          {labels.feed_close}
        </button>
        <button
          type="button"
          disabled={!method || tooLittle}
          onClick={() => method && onPaid(method, method === "cash" ? cash : null)}
          className="min-h-11 rounded-xl bg-foreground px-4 font-semibold text-white disabled:opacity-40"
          data-food-pay-confirm
        >
          {labels.feed_pay_finish}
        </button>
      </div>
    </div>
  );
}

/** "Prideliť": the shop's active couriers, then "Prideliť a odovzdať". */
function CourierChoice({
  o,
  labels,
  couriers,
  couriersHref,
  onClose,
  onPick,
}: {
  o: FeedCard;
  labels: BoardLabels;
  couriers: { id: string; name: string }[];
  couriersHref: string;
  onClose: () => void;
  onPick: (id: string) => void;
}) {
  const [pick, setPick] = useState<string | null>(couriers.length === 1 ? couriers[0].id : null);
  return (
    <div className="flex flex-col gap-4 p-5" data-food-assign>
      <h2 className="text-lg font-bold">{fill(labels.feed_assign_title, { n: o.number })}</h2>
      {couriers.length === 0 ? (
        <p>
          {labels.feed_no_couriers}{" "}
          <Link href={couriersHref} className="font-semibold underline underline-offset-4">
            →
          </Link>
        </p>
      ) : (
        <div className="flex flex-col gap-2" role="radiogroup">
          {couriers.map((c) => (
            <label key={c.id} className={`flex min-h-12 items-center gap-3 rounded-xl border px-3 ${pick === c.id ? "border-2 border-foreground" : "border-line"}`}>
              <input type="radio" name={`food-courier-${o.id}`} checked={pick === c.id} onChange={() => setPick(c.id)} className="size-5" />
              <span className="font-semibold">{c.name}</span>
            </label>
          ))}
        </div>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" onClick={onClose} className="min-h-11 rounded-xl border border-line px-4 font-semibold">
          {labels.feed_close}
        </button>
        <button
          type="button"
          disabled={!pick}
          onClick={() => pick && onPick(pick)}
          className="min-h-11 rounded-xl bg-foreground px-4 font-semibold text-white disabled:opacity-40"
          data-food-assign-confirm
        >
          {labels.feed_assign_finish}
        </button>
      </div>
    </div>
  );
}
