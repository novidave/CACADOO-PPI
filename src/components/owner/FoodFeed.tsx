"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatTime } from "@/lib/format";
import {
  agoLabel,
  cardTags,
  DELAYS,
  DELIVERY_RANGE,
  dueLabel,
  type FeedLabels,
  type FeedPay,
  fill,
  finishNeeds,
  finishTarget,
  payMethods,
  PREP_RANGE,
  reopenable,
  sortActive,
  sortDone,
  stepMinutes,
  swipeOutcome,
} from "@/lib/foodFeed";
import type { FeedCard, FoodFeed as Feed } from "@/lib/foodOwner";
import { cashChoices, money } from "@/lib/foodRules";
import {
  feedOrderQr,
  finishFeedOrder,
  type FeedAnswer,
  loadFeed,
  reopenFeedOrder,
  setFeedDelay,
  setFeedPaused,
  setFeedTime,
} from "@/app/[lang]/(account)/dashboard/assistant/orders/feedActions";

/**
 * Objednávky jedla → the feed (database update 81; design: artboards 5a tablet, 5c phone). Orders as cards, newest on
 * top (or oldest, by the shop's setting); a finished one is swiped left or right (pointer events, `touch-action:
 * pan-y`, never from a button or a link; past 30 % of the card's width it flies out, less springs back) or "Vybavené"
 * is pressed — with payments and no payment mark the payment choice opens first, with the courier app and no courier
 * "Prideliť". It moves to "Vybavené dnes" in grey; "Vrátiť", a swipe on a grey row or the toast's "Späť" reopens it.
 * Above: Príprava / Donáška (− n min +), Meškanie (one tap saves) and what the assistant tells customers — the same
 * food_times() the assistant reads. Every change goes through the feed's server actions (SQL decides; each answer is
 * the feed again); FoodOrdersLive draws the page again every 10 s when an order came or changed. Cards that were not
 * there when the page opened slide in; nothing moves with prefers-reduced-motion, and the list waits while a finger
 * is on a card.
 */

type Labels = FeedLabels;
type Dialog = { kind: "payment" | "courier"; order: FeedCard } | null;
type Toast = { text: string; undo?: () => void; error?: boolean } | null;

const reduced = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** A card moved by an action before the server answers (the answer replaces it). */
function moved(feed: Feed, o: FeedCard, to: "done" | "active", status: FeedCard["status"]): Feed {
  const rest = (list: FeedCard[]) => list.filter((x) => x.id !== o.id);
  const card: FeedCard = { ...o, status, done_at: to === "done" ? new Date().toISOString() : null };
  return to === "done"
    ? { ...feed, active: rest(feed.active), done: [card, ...rest(feed.done)] }
    : { ...feed, done: rest(feed.done), active: [card, ...rest(feed.active)] };
}

export function FoodFeed({
  shopId,
  lang,
  initial,
  labels,
  canWrite,
  detailBase,
  couriersHref,
  serverNow,
}: {
  shopId: string;
  lang: string;
  initial: Feed;
  labels: Labels;
  canWrite: boolean;
  /** "/sk/dashboard/assistant/orders/" + id + "?shop=…" is an order's page */
  detailBase: { path: string; query: string };
  couriersHref: string;
  serverNow: number;
}) {
  // what the screen shows: the server's feed, or the answer of the owner's own last action on it, or — while a finger
  // is on a card — the feed as it was when the finger came down
  const [mine, setMine] = useState<{ base: Feed; feed: Feed } | null>(null);
  const [held, setHeld] = useState<Feed | null>(null);
  const latest = useRef(initial);
  useEffect(() => {
    latest.current = initial;
  }, [initial]);
  const shown = held ?? (mine && mine.base === initial ? mine.feed : initial);

  const [since] = useState(serverNow);
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    const first = window.setTimeout(() => setNow(Date.now()), 0);
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, []);

  const [drag, setDrag] = useState<{ id: string; dx: number } | null>(null);
  const [out, setOut] = useState<{ id: string; dir: number; w: number } | null>(null);
  const gesture = useRef<{ id: string; x0: number; y0: number; w: number; pid: number; on: boolean } | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  // the payment dialog's QR (2026-11-05): one stable loader per open dialog, so the dialog asks the server once
  const payOrderId = dialog?.kind === "payment" ? dialog.order.id : null;
  const loadQr = useCallback(() => (payOrderId ? feedOrderQr(shopId, payOrderId, lang) : Promise.resolve(null)), [shopId, payOrderId, lang]);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [toast, setToast] = useState<Toast>(null);
  const toastTimer = useRef<number | null>(null);
  const [said, setSaid] = useState("");
  const [busy, setBusy] = useState(false);
  const [prep, setPrep] = useState<number | null>(null);
  const [deliv, setDeliv] = useState<number | null>(null);
  const [delay, setDelay] = useState<number | null>(null);
  const saveTimer = useRef<number | null>(null);
  const [olderOpen, setOlderOpen] = useState(false);

  const tz = shown.timezone;
  const hm = (iso: string | null) => (iso ? formatTime(new Date(iso), tz) : "");
  const parts = shown.parts;
  const settings = shown.settings;
  const times = shown.times;
  const prepShown = prep ?? times.prep_minutes;
  const delivShown = deliv ?? times.delivery_minutes;
  const delayShown = delay ?? times.delay_minutes;

  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (dialog && !d.open) d.showModal();
    if (!dialog && d.open) d.close();
  }, [dialog]);

  useEffect(
    () => () => {
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    },
    [],
  );

  const showToast = (t: Toast) => {
    setToast(t);
    if (t) setSaid(t.text);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 5000);
  };
  const errorText = (code: string) => (labels as Record<string, string>)[code] ?? labels.err_failed;
  const take = (res: FeedAnswer) => {
    if (res.feed) setMine({ base: latest.current, feed: res.feed });
    if (!res.ok) showToast({ text: errorText(res.error), error: true });
    return res.ok;
  };

  // ------------------------------------------------------------------ the two actions

  const doFinish = async (o: FeedCard, pay: FeedPay | null = null, cash: number | null = null, courier: string | null = null) => {
    const to = finishTarget(o, parts);
    setMine({ base: latest.current, feed: moved(shown, o, "done", to) });
    showToast({ text: fill(to === "on_the_way" ? labels.feed_toast_on_way : labels.feed_toast_done, { n: o.number }), undo: () => void doReopen(o) });
    const res = await finishFeedOrder(shopId, o.id, crypto.randomUUID(), pay, cash, courier, courier ? crypto.randomUUID() : null);
    if (take(res) && res.ok && res.sms) showToast({ text: res.sms === "sent" ? labels.ok_sms : labels.err_sms_failed, error: res.sms !== "sent" });
  };

  const doReopen = async (o: FeedCard) => {
    setMine({ base: latest.current, feed: moved(shown, o, "active", o.status) });
    showToast({ text: fill(labels.feed_toast_back, { n: o.number }) });
    take(await reopenFeedOrder(shopId, o.id, crypto.randomUUID()));
  };

  /** "Vybavené": first what the finish needs (the courier, the payment), else at once (flying out). */
  const finish = (o: FeedCard, dir = -1, w = 0) => {
    const needs = finishNeeds(o, parts);
    if (needs) {
      setDialog({ kind: needs, order: o });
      return;
    }
    fly(o, dir, w, () => void doFinish(o));
  };

  const fly = (o: FeedCard, dir: number, w: number, then: () => void) => {
    if (reduced() || !w) {
      setHeld(null);
      then();
      return;
    }
    setOut({ id: o.id, dir, w });
    window.setTimeout(() => {
      setOut(null);
      setHeld(null);
      then();
    }, 230);
  };

  // ------------------------------------------------------------------ swipes (pointer events)

  const down = (o: FeedCard) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (!canWrite || out) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if ((e.target as Element).closest("button, a, input, select, textarea, label, summary")) return;
    gesture.current = { id: o.id, x0: e.clientX, y0: e.clientY, w: e.currentTarget.offsetWidth || 1, pid: e.pointerId, on: false };
  };
  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.pid !== e.pointerId) return;
    const dx = e.clientX - g.x0;
    const dy = e.clientY - g.y0;
    if (!g.on) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
        gesture.current = null; // the page scrolls (touch-action: pan-y)
        return;
      }
      if (Math.abs(dx) < 10) return;
      g.on = true;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // the pointer is gone already
      }
      setHeld(shown);
    }
    setDrag({ id: g.id, dx });
  };
  const up = (o: FeedCard, done: boolean) => (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    gesture.current = null;
    if (!g || !g.on || g.pid !== e.pointerId) return;
    const dir = e.type === "pointercancel" ? 0 : swipeOutcome(e.clientX - g.x0, g.w);
    setDrag(null);
    if (dir === 0) {
      setHeld(null);
      return;
    }
    if (done) {
      if (!reopenable(o)) {
        setHeld(null);
        return;
      }
      fly(o, dir, g.w, () => void doReopen(o));
      return;
    }
    if (finishNeeds(o, parts)) setHeld(null);
    finish(o, dir, g.w);
  };
  const shift = (o: FeedCard) => (drag?.id === o.id ? drag.dx : out?.id === o.id ? out.dir * (out.w + 40) : 0);
  const swipeProps = (o: FeedCard, done: boolean) => ({
    onPointerDown: down(o),
    onPointerMove: move,
    onPointerUp: up(o, done),
    onPointerCancel: up(o, done),
    style: { transform: `translateX(${Math.round(shift(o))}px)` },
    "data-dragging": drag?.id === o.id ? "" : undefined,
  });

  // ------------------------------------------------------------------ the bar: times, delay, pause

  const saveTime = (field: "prep_minutes" | "delivery_minutes", value: number) => {
    (field === "prep_minutes" ? setPrep : setDeliv)(value);
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      const res = await setFeedTime(shopId, field, value);
      take(res);
      (field === "prep_minutes" ? setPrep : setDeliv)(null);
      if (res.ok) setSaid(labels.feed_saved);
    }, 500);
  };
  const pickDelay = async (v: number) => {
    setDelay(v);
    const res = await setFeedDelay(shopId, v);
    take(res);
    setDelay(null);
    if (res.ok) setSaid(labels.feed_saved);
  };
  const togglePause = async () => {
    setBusy(true);
    take(await setFeedPaused(shopId, !settings.paused));
    setBusy(false);
  };
  const showOlder = async () => {
    setOlderOpen(true);
    if (!shown.older) take(await loadFeed(shopId, true));
  };

  const active = sortActive(shown.active, settings.feed_order);
  const done = sortDone(shown.done);
  const pickupAt = hm(new Date(now + (prepShown + delayShown) * 60_000).toISOString());
  const deliveryAt = hm(new Date(now + (delivShown + delayShown) * 60_000).toISOString());
  const accepting = shown.state.accepting;
  const reasonText = (labels as Record<string, string>)[`not_accepting_${shown.state.reason ?? "off"}`] ?? labels.not_accepting_off;
  const detailHref = (o: FeedCard) => `${detailBase.path}${o.id}${detailBase.query}`;
  const itemsText = (o: FeedCard) => o.lines.map((l) => `${l.qty}× ${l.name}${l.extras_text ? ` (${l.extras_text})` : ""}`).join(" · ");

  const stepper = (label: string, value: number, range: typeof PREP_RANGE | typeof DELIVERY_RANGE, field: "prep_minutes" | "delivery_minutes") => (
    <div className="flex items-center justify-between gap-2 @[40rem]:flex-col @[40rem]:items-start @[40rem]:justify-start @[40rem]:gap-1.5" data-feed-stepper={field}>
      <span className="text-xs font-bold uppercase tracking-wide text-muted">{label}</span>
      <div className="flex flex-none items-center gap-1.5">
        <button
          type="button"
          className="flex size-12 items-center justify-center rounded-xl border border-line bg-white text-2xl font-bold disabled:opacity-40"
          aria-label={fill(labels.feed_less, { what: label })}
          disabled={!canWrite || value <= range.min}
          onClick={() => saveTime(field, stepMinutes(value, -range.step, range))}
          data-feed-less={field}
        >
          −
        </button>
        <output className="min-w-16 text-center text-lg font-bold tabular-nums" aria-live="polite" data-feed-value={field}>
          {fill(labels.feed_minutes, { n: value })}
        </output>
        <button
          type="button"
          className="flex size-12 items-center justify-center rounded-xl border border-line bg-white text-2xl font-bold disabled:opacity-40"
          aria-label={fill(labels.feed_more, { what: label })}
          disabled={!canWrite || value >= range.max}
          onClick={() => saveTime(field, stepMinutes(value, range.step, range))}
          data-feed-more={field}
        >
          +
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex flex-col gap-5" data-food-feed>
      {/* the bar (artboards 5a / 5c, 2026-11-05): a container query — one row from 56 rem (the tablet, the menu as a rail);
          rows with the label left and the control right on a phone (5c). "Pozastaviť" sits in the box of what the
          assistant says (nothing that differs between tabs may sit above the tabs). */}
      <section className="@container rounded-2xl border border-line bg-[#FAFAFA] p-3 @[40rem]:p-4" aria-label={labels.feed_says} data-feed-bar>
        <div className="flex flex-col gap-2.5 @[40rem]:flex-row @[40rem]:flex-wrap @[40rem]:items-end @[40rem]:gap-4 @[56rem]:flex-nowrap @[56rem]:items-center">
          {settings.pickup_on && stepper(labels.feed_prep, prepShown, PREP_RANGE, "prep_minutes")}
          {parts.delivery && stepper(labels.feed_delivery, delivShown, DELIVERY_RANGE, "delivery_minutes")}
          <div className="flex items-center justify-between gap-2 @[40rem]:flex-col @[40rem]:items-start @[40rem]:gap-1.5">
            <span className="text-xs font-bold uppercase tracking-wide text-muted">{labels.feed_delay}</span>
            <div className="flex flex-none gap-1 @[40rem]:gap-1.5" role="group" aria-label={labels.feed_delay}>
              {DELAYS.map((v) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={delayShown === v}
                  aria-label={fill(labels.feed_delay_chip, { n: v })}
                  disabled={!canWrite}
                  onClick={() => void pickDelay(v)}
                  className={`min-h-12 min-w-11 rounded-xl px-1.5 text-base font-bold tabular-nums @[40rem]:min-w-12 @[40rem]:px-2 ${delayShown === v ? "border-2 border-foreground bg-foreground text-white" : "border border-[#D6D6D6] bg-white"}`}
                  data-feed-delay={v}
                >
                  {v === 0 ? "0" : `+${v}`}
                </button>
              ))}
            </div>
          </div>
          <div
            className={`flex min-w-0 flex-col gap-1 rounded-xl p-2.5 @[40rem]:basis-full @[40rem]:p-3 @[56rem]:min-w-60 @[56rem]:flex-1 @[56rem]:basis-auto ${settings.paused ? "border-2 border-[#F2B705] bg-[#FFFBEA]" : "border border-line bg-white"}`}
            {...(settings.paused ? { "data-feed-paused": "" } : { "data-feed-says": "" })}
          >
            <div className="flex items-center justify-between gap-2">
              {settings.paused ? <strong>{labels.feed_paused_title}</strong> : <span className="text-xs font-bold uppercase tracking-wide text-muted">{labels.feed_says}</span>}
              {canWrite && settings.enabled && (
                <button
                  type="button"
                  onClick={() => void togglePause()}
                  disabled={busy}
                  aria-pressed={settings.paused}
                  className={`min-h-11 flex-none rounded-xl px-3.5 text-[15px] font-semibold ${settings.paused ? "bg-foreground text-white" : "border border-line bg-white"}`}
                  data-feed-pause={settings.paused ? "resume" : "pause"}
                >
                  {settings.paused ? labels.feed_resume : labels.feed_pause}
                </button>
              )}
            </div>
            {settings.paused ? (
              <span className="text-sm">{labels.feed_paused_text}</span>
            ) : (
              <>
                {!accepting && <span className="text-sm font-semibold text-[#B42318]">{reasonText}</span>}
                {settings.pickup_on && (
                  <span className="text-[15px] font-semibold" data-feed-says-pickup>
                    {fill(labels.feed_says_pickup, { time: pickupAt, n: prepShown + delayShown })}
                  </span>
                )}
                {parts.delivery && (
                  <span className="text-[15px] font-semibold" data-feed-says-delivery>
                    {fill(labels.feed_says_delivery, { time: deliveryAt, n: delivShown + delayShown })}
                  </span>
                )}
                {times.long_delay && delay === null && <span className="text-sm">{labels.feed_says_long}</span>}
                <span className="flex items-center gap-1 text-[13px] font-semibold text-[#146C37]">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden="true">
                    <path d="m5 12 5 5L20 7" />
                  </svg>
                  {labels.feed_synced}
                </span>
              </>
            )}
          </div>
        </div>
      </section>

      {/* active cards */}
      <section className="flex flex-col gap-3" aria-labelledby="feed-active">
        <div className="flex flex-col gap-0.5">
          <h2 id="feed-active" className="text-lg font-bold">
            {fill(labels.feed_active, { n: active.length })}
          </h2>
          {canWrite && active.length > 0 && <p className="text-sm text-muted">{labels.feed_hint}</p>}
        </div>
        {active.length === 0 && (
          <div className="flex flex-col items-center gap-1 rounded-2xl border border-dashed border-line p-6 text-center" data-feed-empty>
            <strong>{labels.feed_empty_title}</strong>
            <span className="text-sm text-muted">{labels.feed_empty_text}</span>
          </div>
        )}
        <ul className="flex flex-col gap-3" data-feed-active>
          {active.map((o) => {
            const tags = cardTags(o, parts);
            const due = dueLabel(o.ready_by, now);
            const ago = agoLabel(o.created_at, now);
            const isNew = o.status === "new";
            const fresh = Date.parse(o.created_at) > since;
            return (
              <li key={o.id} className={`ppi-feed-slot relative overflow-hidden rounded-[14px] ${fresh ? "ppi-feed-in" : ""}`}>
                <div className="ppi-feed-under absolute inset-0 flex items-center justify-between bg-[#E3F4EA] px-5 font-bold text-[#146C37]" aria-hidden="true">
                  <span>{labels.feed_finish}</span>
                  <span>{labels.feed_finish}</span>
                </div>
                <div
                  className={`ppi-feed-card relative flex flex-col gap-1.5 rounded-[14px] bg-white p-3 ${isNew ? "border-2 border-foreground" : "border border-[#E4E4E4]"}`}
                  data-feed-card={o.id}
                  data-feed-number={o.number}
                  data-status={o.status}
                  {...swipeProps(o, false)}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 flex-col">
                      <span className="flex items-baseline gap-2">
                        <strong className="text-xl tabular-nums">{hm(o.created_at)}</strong>
                        <span className="text-sm text-muted">{ago.kind === "now" ? labels.feed_now : fill(labels.feed_ago, { n: ago.n })}</span>
                      </span>
                      <Link href={detailHref(o)} className="min-w-0 truncate font-semibold">
                        #{o.number}
                        {o.name ? ` · ${o.name}` : ""}
                      </Link>
                    </div>
                    {isNew && <span className="flex h-[22px] flex-none items-center rounded-full bg-foreground px-2.5 text-xs font-bold text-white">{labels.feed_new}</span>}
                  </div>
                  <p className="flex items-center gap-1.5 text-[15px] font-semibold">
                    {o.kind === "delivery" ? <TruckIcon /> : <BagIcon />}
                    {fill(o.kind === "delivery" ? labels.feed_delivery_by : labels.feed_pickup_at, { time: hm(o.ready_by) })}
                    <span className="font-normal text-muted">· {due.kind === "now" ? labels.feed_now : fill(labels.feed_in, { n: due.n })}</span>
                  </p>
                  {tags.address && (
                    <p className="flex items-start gap-1.5 text-sm">
                      <PinIcon />
                      <span className="min-w-0">
                        {o.address}
                        {o.zone_name && <span className="font-semibold" data-feed-zone> · {o.zone_name}</span>}
                      </span>
                    </p>
                  )}
                  <p className="text-[15px]">{itemsText(o)}</p>
                  {o.note && <p className="text-sm text-muted">{fill(labels.feed_note, { note: o.note })}</p>}
                  <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                    <div className="flex flex-wrap items-center gap-1.5 text-sm">
                      <strong className="text-base tabular-nums">{money(o.total_cents, lang, o.currency)}</strong>
                      {tags.pay && o.pay_method && (
                        <span className="rounded-full bg-[#EEF1F5] px-2.5 py-1 text-xs font-semibold" data-feed-pay-tag>
                          {o.paid_at
                            ? fill(labels.paid_short, { method: labels[`pay_${o.pay_method}`] })
                            : fill(labels.feed_not_paid, { method: labels[`pay_${o.pay_method}`] })}
                        </span>
                      )}
                      {tags.courier && (
                        <span className="rounded-full border border-[#D6D6D6] px-2.5 py-1 text-xs font-semibold" data-feed-courier-tag>
                          {fill(labels.feed_courier, { name: o.courier_name ?? "" })}
                        </span>
                      )}
                    </div>
                    {canWrite && (
                      <button
                        type="button"
                        className="ml-auto min-h-11 rounded-xl bg-foreground px-4 font-semibold text-white"
                        aria-label={fill(labels.feed_finish_label, { n: o.number })}
                        onClick={(e) => finish(o, -1, (e.currentTarget.closest("[data-feed-card]") as HTMLElement | null)?.offsetWidth ?? 0)}
                        data-feed-finish={o.id}
                      >
                        {labels.feed_finish}
                      </button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      {/* finished today, grey */}
      <section id="feed-done" className="flex flex-col gap-2" aria-labelledby="feed-done-title">
        <div className="flex flex-col gap-0.5">
          <h2 id="feed-done-title" className="text-lg font-bold">
            {fill(labels.feed_done_today, { n: done.length })}
          </h2>
          {canWrite && done.some(reopenable) && <p className="text-sm text-muted">{labels.feed_done_hint}</p>}
        </div>
        <ul className="flex flex-col gap-2" data-feed-done>
          {done.map((o) => (
            <li key={o.id} className="relative overflow-hidden rounded-xl">
              <div className="absolute inset-0 flex items-center justify-between bg-[#E4E4E4] px-5 font-bold text-[#3D3D3D]" aria-hidden="true">
                <span>{labels.feed_reopen}</span>
                <span>{labels.feed_reopen}</span>
              </div>
              <div
                className="ppi-feed-card relative flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-[#E4E4E4] bg-[#F2F2F2] px-4 py-2.5 text-[#5C5C5C]"
                data-feed-card={o.id}
                data-feed-number={o.number}
                data-status={o.status}
                data-feed-grey
                {...swipeProps(o, true)}
              >
                <DoneRowText o={o} labels={labels} hm={hm} lang={lang} href={detailHref(o)} />
                {o.status === "cancelled" ? (
                  <span className="ml-auto text-sm font-semibold">{labels.feed_cancelled}</span>
                ) : canWrite && reopenable(o) ? (
                  <button
                    type="button"
                    className="ml-auto min-h-11 rounded-lg border border-[#C8C8C8] bg-white px-3 text-sm font-semibold text-foreground"
                    aria-label={fill(labels.feed_reopen_label, { n: o.number })}
                    onClick={() => void doReopen(o)}
                    data-feed-reopen={o.id}
                  >
                    {labels.feed_reopen}
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
        {shown.older_count > 0 && !olderOpen && (
          <button type="button" onClick={() => void showOlder()} className="min-h-11 self-start font-semibold underline underline-offset-4" data-feed-older>
            {fill(labels.feed_older, { n: shown.older_count })}
          </button>
        )}
        {olderOpen && shown.older && shown.older.length > 0 && (
          <>
            <h3 className="pt-2 font-bold text-muted">{labels.feed_older_title}</h3>
            <ul className="flex flex-col gap-2" data-feed-older-list>
              {sortDone(shown.older).map((o) => (
                <li key={o.id} className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-[#E4E4E4] bg-[#F2F2F2] px-4 py-2.5 text-[#5C5C5C]">
                  <DoneRowText o={o} labels={labels} hm={hm} lang={lang} href={detailHref(o)} day />
                  {o.status === "cancelled" && <span className="ml-auto text-sm font-semibold">{labels.feed_cancelled}</span>}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {/* the payment choice / "Prideliť" before a finish */}
      <dialog
        ref={dialogRef}
        onClose={() => setDialog(null)}
        className="m-auto w-[min(92vw,460px)] rounded-2xl border border-line p-0 backdrop:bg-black/40"
        data-feed-dialog={dialog?.kind}
      >
        {dialog?.kind === "payment" && (
          <PaymentChoice
            key={dialog.order.id}
            o={dialog.order}
            labels={labels}
            lang={lang}
            methods={payMethods(settings, parts)}
            qrHref={parts.qr_terminal ? detailHref(dialog.order) : null}
            loadQr={loadQr}
            onClose={() => setDialog(null)}
            onPaid={(pay, cash) => {
              const o = dialog.order;
              setDialog(null);
              void doFinish(o, pay, cash);
            }}
          />
        )}
        {dialog?.kind === "courier" && (
          <CourierChoice
            key={dialog.order.id}
            o={dialog.order}
            labels={labels}
            couriers={shown.couriers}
            couriersHref={couriersHref}
            onClose={() => setDialog(null)}
            onPick={(id) => {
              const o = dialog.order;
              setDialog(null);
              void doFinish(o, null, null, id);
            }}
          />
        )}
      </dialog>

      {toast && (
        <div
          className={`fixed inset-x-4 bottom-4 z-40 mx-auto flex max-w-md items-center justify-between gap-3 rounded-xl px-4 py-3 text-white shadow-lg ${toast.error ? "bg-[#B42318]" : "bg-foreground"}`}
          data-feed-toast
        >
          <span className="min-w-0">{toast.text}</span>
          {toast.undo && (
            <button
              type="button"
              className="min-h-11 flex-none px-2 font-bold underline underline-offset-4"
              onClick={() => {
                const undo = toast.undo;
                setToast(null);
                undo?.();
              }}
              data-feed-undo
            >
              {labels.feed_undo}
            </button>
          )}
        </div>
      )}
      <span className="sr-only" aria-live="polite">
        {said}
      </span>
    </div>
  );
}

/** A grey row's text: time, number + name, pickup or the address, when it was finished, the total. */
function DoneRowText({ o, labels, hm, lang, href, day = false }: { o: FeedCard; labels: Labels; hm: (iso: string | null) => string; lang: string; href: string; day?: boolean }) {
  const summary = o.kind === "delivery"
    ? fill(labels.feed_delivery_short, { address: [o.address, o.zone_name].filter(Boolean).join(" · ") })
    : labels.feed_pickup_short;
  const when = o.status === "on_the_way" ? fill(labels.feed_on_way_at, { time: hm(o.done_at) }) : fill(labels.feed_done_at, { time: hm(o.done_at) });
  return (
    <>
      <span className="font-bold tabular-nums">{day ? `${o.order_day.slice(8, 10)}.${o.order_day.slice(5, 7)}. ` : ""}{hm(o.created_at)}</span>
      <Link href={href} className="min-w-0 truncate font-semibold">
        #{o.number}
        {o.name ? ` · ${o.name}` : ""}
      </Link>
      <span className="min-w-0 truncate text-sm">{summary}</span>
      {o.status !== "cancelled" && <span className="text-sm">{when}</span>}
      <span className="text-sm font-semibold tabular-nums">{money(o.total_cents, lang, o.currency)}</span>
    </>
  );
}

/** "Ako zákazník zaplatil?": only the methods that are on; cash with the quick amounts and the change. */
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
  labels: Labels;
  lang: string;
  methods: FeedPay[];
  qrHref: string | null;
  /** 2026-11-05: the order's PAY by square code inside the dialog (feedOrderQr; null = no IBAN / already paid) */
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
    <div className="flex flex-col gap-4 p-5" data-feed-pay>
      <h2 className="text-lg font-bold">{fill(labels.feed_pay_title, { n: o.number, total: money(o.total_cents, lang, o.currency) })}</h2>
      <div className="flex flex-wrap gap-2" role="group">
        {methods.map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={method === m}
            onClick={() => setMethod(m)}
            className={`min-h-12 flex-1 rounded-xl px-3 font-semibold ${method === m ? "border-2 border-foreground bg-foreground text-white" : "border border-line"}`}
            data-feed-pay-method={m}
          >
            {labels[`pay_${m}`]}
          </button>
        ))}
      </div>
      {method === "qr" && qrHref && (
        <div className="flex flex-col items-center gap-2" data-feed-qr={qr === "loading" || qr === undefined ? "loading" : qr ? "ready" : "none"}>
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
          <Link href={qrHref} className="font-semibold underline underline-offset-4" data-feed-show-qr>
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
                data-feed-cash={c}
              >
                {i === 0 ? labels.cash_exact : money(c, lang, o.currency)}
              </button>
            ))}
          </div>
          <label className="flex flex-col gap-1 text-sm">
            {labels.cash_other}
            <input
              inputMode="decimal"
              value={other}
              onChange={(e) => setOther(e.target.value)}
              className="min-h-11 rounded-lg border border-line px-3 text-base"
            />
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
          data-feed-pay-confirm
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
  labels: Labels;
  couriers: { id: string; name: string }[];
  couriersHref: string;
  onClose: () => void;
  onPick: (id: string) => void;
}) {
  const [pick, setPick] = useState<string | null>(couriers.length === 1 ? couriers[0].id : null);
  return (
    <div className="flex flex-col gap-4 p-5" data-feed-assign>
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
              <input type="radio" name="feed-courier" checked={pick === c.id} onChange={() => setPick(c.id)} className="size-5" />
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
          data-feed-assign-confirm
        >
          {labels.feed_assign_finish}
        </button>
      </div>
    </div>
  );
}

const BagIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" className="flex-none">
    <path d="M6 8h12l-1 12H7zM9 8a3 3 0 0 1 6 0" />
  </svg>
);
const TruckIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" className="flex-none">
    <path d="M3 7h11v9H3zM14 10h4l3 3v3h-7M7 19a2 2 0 1 0 0-4a2 2 0 1 0 0 4zM17 19a2 2 0 1 0 0-4a2 2 0 1 0 0 4z" />
  </svg>
);
const PinIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" className="mt-0.5 flex-none">
    <path d="M12 21s-7-6.2-7-11a7 7 0 1 1 14 0c0 4.8-7 11-7 11z" />
    <circle cx="12" cy="10" r="2.5" />
  </svg>
);
