"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { formatTime } from "@/lib/format";
import { DELAYS, DELIVERY_RANGE, fill, PREP_RANGE, stepMinutes } from "@/lib/foodFeed";
import type { FoodFeed } from "@/lib/foodOwner";
import { type FeedAnswer, setFeedDelay, setFeedPaused, setFeedTime } from "@/app/[lang]/(account)/dashboard/assistant/orders/feedActions";

/**
 * Objednávky jedla → Objednávky: THE GREEN BAR (2026-11-07, at the owner's request: no feed — its times, the delay,
 * the assistant's line and the close button live here). The first block under the tabs, a container query
 * (`@container`, `data-food-bar`): from 56 rem of its own width ONE row — the status dot + words · "Príprava" − n min +
 * (steps of 5, 5–120, saved 0.5 s after the last tap) · "Donáška" − n min + (10–180, only with Donáška) · "Meškanie"
 * 0 · +10 · +20 · +30 · +45 (`aria-pressed`, one tap saves) · the box "Asistent zákazníkom hovorí: odber o 18:40 ·
 * donáška do 19:10" (food_times in the shop's time zone, "Synchronizované s asistentom", the long-delay line) ·
 * "Uzavrieť objednávky". Narrower: rows with the label left and the control right (chips 44 px), the button full width
 * last. Paused = yellow (#FFF6D6, the #F2B705 dot), "Objednávky sú uzavreté" + "Otvoriť objednávky"; closed by the
 * hours / the cutoff / the SMS quota = grey with the state's words, the times and the delay still editable. Every
 * change goes through the feed's server actions (SQL decides: owner_food_save_settings for one field,
 * owner_food_set_delay, owner_food_pause) and the page is drawn again (router.refresh).
 */

type Data = Pick<FoodFeed, "times" | "parts" | "state" | "settings" | "timezone">;

export function FoodBar({
  shopId,
  initial,
  labels,
  canWrite,
  serverNow,
}: {
  shopId: string;
  initial: Data;
  labels: Record<string, string>;
  canWrite: boolean;
  serverNow: number;
}) {
  const router = useRouter();
  // the server's data, or the answer of the owner's own last change while the page is drawn again
  const [mine, setMine] = useState<{ base: Data; data: Data } | null>(null);
  const shown = mine && mine.base === initial ? mine.data : initial;
  const [prep, setPrep] = useState<number | null>(null);
  const [deliv, setDeliv] = useState<number | null>(null);
  const [delay, setDelay] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState("");
  const saveTimer = useRef<number | null>(null);
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    const first = window.setTimeout(() => setNow(Date.now()), 0);
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
  }, []);

  const take = (res: FeedAnswer) => {
    if (res.feed) setMine({ base: initial, data: res.feed });
    setSaid(res.ok ? labels.feed_saved : (labels[res.error] ?? labels.feed_failed));
    router.refresh();
    return res.ok;
  };

  const { times, parts, settings, state } = shown;
  const prepShown = prep ?? times.prep_minutes;
  const delivShown = deliv ?? times.delivery_minutes;
  const delayShown = delay ?? times.delay_minutes;
  const hm = (minutes: number) => formatTime(new Date(now + minutes * 60_000), shown.timezone);
  const paused = Boolean(settings.paused);
  const accepting = state.accepting;
  const tone = paused ? "paused" : accepting ? "accepting" : (state.reason ?? "off");

  const saveTime = (field: "prep_minutes" | "delivery_minutes", value: number) => {
    (field === "prep_minutes" ? setPrep : setDeliv)(value);
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      const res = await setFeedTime(shopId, field, value);
      take(res);
      (field === "prep_minutes" ? setPrep : setDeliv)(null);
    }, 500);
  };
  const pickDelay = async (v: number) => {
    setDelay(v);
    take(await setFeedDelay(shopId, v));
    setDelay(null);
  };
  const togglePause = async () => {
    setBusy(true);
    take(await setFeedPaused(shopId, !paused));
    setBusy(false);
  };

  const label = (text: string) => <span className="text-[13px] font-bold uppercase tracking-wide text-[#3D4A43] @[56rem]:text-xs">{text}</span>;
  const row = "flex items-center justify-between gap-3 @[56rem]:flex-col @[56rem]:items-start @[56rem]:justify-start @[56rem]:gap-1";
  const square = "flex size-11 items-center justify-center rounded-xl border border-line bg-white text-2xl font-bold disabled:opacity-40";

  const stepper = (text: string, value: number, range: typeof PREP_RANGE | typeof DELIVERY_RANGE, field: "prep_minutes" | "delivery_minutes") => (
    <div className={`${row} @[56rem]:flex-none`} data-food-stepper={field}>
      {label(text)}
      <div className="flex flex-none items-center gap-1">
        <button
          type="button"
          className={square}
          aria-label={fill(labels.feed_less, { what: text })}
          disabled={!canWrite || value <= range.min}
          onClick={() => saveTime(field, stepMinutes(value, -range.step, range))}
          data-food-less={field}
        >
          −
        </button>
        <output className="min-w-14 text-center text-lg font-bold tabular-nums @[56rem]:min-w-[3.25rem] @[56rem]:text-base" data-food-value={field}>
          {fill(labels.feed_minutes, { n: value })}
        </output>
        <button
          type="button"
          className={square}
          aria-label={fill(labels.feed_more, { what: text })}
          disabled={!canWrite || value >= range.max}
          onClick={() => saveTime(field, stepMinutes(value, range.step, range))}
          data-food-more={field}
        >
          +
        </button>
      </div>
    </div>
  );

  const colours =
    tone === "accepting"
      ? "border-[#1E9E5A] bg-[#F1FBF5]"
      : tone === "paused"
        ? "border-[#F2B705] bg-[#FFF6D6]"
        : "border-line bg-[#FAFAFA]";
  const dot =
    tone === "accepting"
      ? "bg-[#1E9E5A] ring-offset-[#146C37]"
      : tone === "paused"
        ? "bg-[#F2B705] ring-offset-[#B7860B]"
        : "bg-[#D64545] ring-offset-[#9B2C2C]";
  const words = paused ? labels.bar_closed_title : accepting ? labels.accepting : (labels[`not_accepting_${state.reason ?? "off"}`] ?? labels.not_accepting_off);
  const says = [
    settings.pickup_on ? fill(labels.bar_says_pickup, { time: hm(prepShown + delayShown) }) : null,
    parts.delivery ? fill(labels.bar_says_delivery, { time: hm(delivShown + delayShown) }) : null,
  ].filter(Boolean);

  return (
    <section className={`@container rounded-2xl border-2 p-3 ${colours}`} aria-label={labels.bar_label} data-food-bar={tone}>
      <div className="flex flex-col gap-2.5 @[56rem]:flex-row @[56rem]:items-center @[56rem]:gap-2.5">
        <p className="flex items-center gap-2 font-bold @[56rem]:max-w-[7rem] @[56rem]:flex-none @[56rem]:leading-tight" data-food-bar-state>
          <span aria-hidden="true" className={`inline-block size-3 flex-none rounded-full ring-2 ring-white ring-offset-1 ${dot}`} />
          {words}
        </p>
        {settings.pickup_on && stepper(labels.feed_prep, prepShown, PREP_RANGE, "prep_minutes")}
        {parts.delivery && stepper(labels.feed_delivery, delivShown, DELIVERY_RANGE, "delivery_minutes")}
        <div className={`${row} @[56rem]:flex-none`}>
          {label(labels.feed_delay)}
          <div className="flex flex-none gap-1" role="group" aria-label={labels.feed_delay}>
            {DELAYS.map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={delayShown === v}
                aria-label={fill(labels.feed_delay_chip, { n: v })}
                disabled={!canWrite}
                onClick={() => void pickDelay(v)}
                className={`min-h-11 min-w-11 rounded-xl px-1 text-base font-bold tabular-nums ${delayShown === v ? "border-2 border-foreground bg-foreground text-white" : "border border-[#D6D6D6] bg-white"}`}
                data-food-delay={v}
              >
                {v === 0 ? "0" : `+${v}`}
              </button>
            ))}
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-0.5 rounded-xl border border-line bg-white px-3 py-2 @[56rem]:min-w-[12rem] @[56rem]:flex-1" data-food-says>
          {paused ? (
            <span className="text-sm">{labels.feed_paused_text}</span>
          ) : (
            <>
              <span className="text-[13px] text-[#3D4A43]">{labels.bar_says}</span>
              {says.length > 0 && (
                <strong className="text-[15px]" data-food-says-line>
                  {says.join(" · ")}
                </strong>
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
        {canWrite && settings.enabled && (
          <button
            type="button"
            onClick={() => void togglePause()}
            disabled={busy}
            className={`min-h-12 w-full rounded-xl px-4 text-[15px] font-semibold @[56rem]:w-auto @[56rem]:max-w-[7.5rem] @[56rem]:flex-none @[56rem]:px-3 @[56rem]:leading-tight ${paused ? "bg-foreground text-white" : "border border-foreground bg-white"}`}
            data-food-pause={paused ? "open" : "close"}
          >
            {paused ? labels.bar_open : labels.bar_close}
          </button>
        )}
      </div>
      <span className="sr-only" aria-live="polite">
        {said}
      </span>
    </section>
  );
}
