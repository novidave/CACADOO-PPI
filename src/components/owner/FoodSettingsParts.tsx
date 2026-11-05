"use client";

import { useEffect, useRef, useState } from "react";
import { formatTime } from "@/lib/format";
import { DELIVERY_RANGE, fill, partsSummary, PREP_RANGE, stepMinutes } from "@/lib/foodFeed";
import { Toggle } from "./ui";

/**
 * Objednávky jedla → Nastavenia (database update 81, artboard 5b): "Čo používate" and "Časy pre asistenta". Plain
 * form fields of the page's one form ("Uložiť" in the SaveBar saves them with everything else; the save bar counts
 * them): the five switches (uncontrolled checkboxes; "Len feed" / "Zapnúť všetko" set them and announce the change),
 * Aplikácia kuriéra greyed out without Donáška and QR terminál without Platby (a greyed switch is not sent, so its
 * own choice stays for later), the status line; the steppers (− n min +, steps of 5) and the assistant's sentence as a
 * preview from the fields as they are now plus today's delay.
 */

type Part = "delivery_on" | "courier_app" | "payments_on" | "deduct_on_delivery" | "qr_terminal";
const PARTS: Part[] = ["delivery_on", "courier_app", "payments_on", "deduct_on_delivery", "qr_terminal"];

export function FoodPartsCard({
  initial,
  labels,
  disabled,
}: {
  initial: Record<Part, boolean>;
  labels: Record<string, string>;
  disabled: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [vals, setVals] = useState(initial);
  const input = (name: Part) => (box.current?.closest("form")?.elements.namedItem(name) as HTMLInputElement | null) ?? null;
  const read = () => setVals(Object.fromEntries(PARTS.map((p) => [p, Boolean(input(p)?.checked)])) as Record<Part, boolean>);
  const setAll = (on: boolean) => {
    for (const p of PARTS) {
      const el = input(p);
      if (!el || el.checked === on) continue;
      el.checked = on;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    read();
  };
  const effective = {
    delivery: vals.delivery_on,
    courier_app: vals.delivery_on && vals.courier_app,
    payments: vals.payments_on,
    register: vals.deduct_on_delivery,
    qr_terminal: vals.payments_on && vals.qr_terminal,
  };
  const on = Object.values(effective).filter(Boolean).length;
  const summary = partsSummary({ ...effective, on });
  const [title, text] =
    summary.kind === "feed_only"
      ? [labels.mod_status_feed_only, labels.mod_status_feed_only_text]
      : summary.kind === "feed_delivery"
        ? [labels.mod_status_feed_delivery, labels.mod_status_feed_delivery_text]
        : [fill(labels.mod_status_some, { n: summary.n }), labels.mod_status_some_text];
  const row = (name: Part, label: string, hint: string, needs?: { on: boolean; text: string }) => (
    <div className={needs && !needs.on ? "opacity-50" : ""} data-food-part={name}>
      <Toggle name={name} label={label} hint={needs && !needs.on ? needs.text : hint} defaultChecked={initial[name]} disabled={disabled || (needs ? !needs.on : false)} />
    </div>
  );
  return (
    <div ref={box} className="flex flex-col gap-1" onChange={read} data-food-parts>
      <div className="flex flex-wrap items-start justify-between gap-3 pb-2">
        <div className="flex min-w-0 flex-col">
          <h2 className="text-[19px] font-bold">{labels.mod_title}</h2>
          <p className="text-sm text-muted">{labels.mod_intro}</p>
        </div>
        {!disabled && (
          <div className="flex gap-2">
            <button type="button" onClick={() => setAll(false)} className="min-h-11 rounded-xl border border-line px-3 text-sm font-semibold" data-food-feed-only>
              {labels.mod_feed_only}
            </button>
            <button type="button" onClick={() => setAll(true)} className="min-h-11 rounded-xl border border-line px-3 text-sm font-semibold" data-food-all-on>
              {labels.mod_all_on}
            </button>
          </div>
        )}
      </div>
      {row("delivery_on", labels.mod_delivery, labels.mod_delivery_hint)}
      {row("courier_app", labels.mod_courier, labels.mod_courier_hint, { on: vals.delivery_on, text: labels.mod_courier_needs })}
      {row("payments_on", labels.mod_payments, labels.mod_payments_hint)}
      {row("deduct_on_delivery", labels.mod_register, labels.mod_register_hint)}
      {row("qr_terminal", labels.mod_qr, labels.mod_qr_hint, { on: vals.payments_on, text: labels.mod_qr_needs })}
      <div className="mt-2 flex flex-col gap-0.5 rounded-xl bg-[#F6F7F9] p-3" aria-live="polite" data-food-parts-status={summary.kind === "some" ? summary.n : summary.kind}>
        <strong>{title}</strong>
        <span className="text-sm text-muted">{text}</span>
      </div>
    </div>
  );
}

/** − n min + as a real number field of the form (the save bar sees it change). */
function StepperField({ name, label, value, range, labels, disabled }: {
  name: "prep_minutes" | "delivery_minutes";
  label: string;
  value: number;
  range: typeof PREP_RANGE | typeof DELIVERY_RANGE;
  labels: Record<string, string>;
  disabled: boolean;
}) {
  const field = useRef<HTMLInputElement>(null);
  const step = (delta: number) => {
    const el = field.current;
    if (!el) return;
    el.value = String(stepMinutes(Number(el.value) || value, delta, range));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  return (
    <div className="flex flex-col gap-1.5" data-food-stepper={name}>
      <span className="text-sm font-semibold">{label}</span>
      <div className="flex items-center gap-2">
        <button type="button" disabled={disabled} onClick={() => step(-range.step)} aria-label={fill(labels.feed_less, { what: label })} className="flex size-12 items-center justify-center rounded-xl border border-line text-2xl font-bold disabled:opacity-40">
          −
        </button>
        <label className="flex items-center gap-1.5 text-lg font-bold">
          <input
            ref={field}
            type="number"
            name={name}
            min={range.min}
            max={range.max}
            step={range.step}
            defaultValue={value}
            disabled={disabled}
            className="h-12 w-20 rounded-xl border border-line text-center text-lg font-bold tabular-nums"
            aria-label={label}
          />
          <span className="text-base font-semibold text-muted">{labels.mod_min_unit}</span>
        </label>
        <button type="button" disabled={disabled} onClick={() => step(range.step)} aria-label={fill(labels.feed_more, { what: label })} className="flex size-12 items-center justify-center rounded-xl border border-line text-2xl font-bold disabled:opacity-40">
          +
        </button>
      </div>
    </div>
  );
}

export function FoodTimesCard({
  prep,
  delivery,
  delay,
  reset,
  warn,
  timezone,
  serverNow,
  labels,
  disabled,
}: {
  prep: number;
  delivery: number;
  delay: number;
  reset: "close" | "midnight" | "never";
  warn: boolean;
  timezone: string;
  serverNow: number;
  labels: Record<string, string>;
  disabled: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(serverNow);
  const [form, setForm] = useState({ prep, delivery, deliveryOn: true, payments: true, warn });
  useEffect(() => {
    const el = box.current?.closest("form");
    if (!el) return;
    const read = () => {
      const get = (n: string) => el.elements.namedItem(n) as HTMLInputElement | null;
      setForm({
        prep: Number(get("prep_minutes")?.value) || prep,
        delivery: Number(get("delivery_minutes")?.value) || delivery,
        deliveryOn: get("delivery_on") ? Boolean(get("delivery_on")?.checked) : true,
        payments: get("payments_on") ? Boolean(get("payments_on")?.checked) : true,
        warn: Boolean(get("warn_long_delay")?.checked),
      });
    };
    const first = window.setTimeout(read, 0);
    const tick = window.setInterval(() => setNow(Date.now()), 30_000);
    el.addEventListener("input", read);
    el.addEventListener("change", read);
    el.addEventListener("reset", () => window.setTimeout(read, 0));
    return () => {
      window.clearTimeout(first);
      window.clearInterval(tick);
      el.removeEventListener("input", read);
      el.removeEventListener("change", read);
    };
  }, [prep, delivery]);
  const at = (min: number) => formatTime(new Date(now + min * 60_000), timezone);
  const sentence = [
    fill(labels.mod_preview_pickup, { time: at(form.prep + delay), n: form.prep + delay }),
    form.deliveryOn ? fill(labels.mod_preview_delivery, { time: at(form.delivery + delay) }) : null,
    form.warn && delay >= 30 ? fill(labels.mod_preview_long, { n: delay }) : null,
    form.payments ? null : labels.mod_preview_pay,
  ].filter(Boolean).join(" ");
  const resets = [
    { value: "close", label: labels.mod_reset_close },
    { value: "midnight", label: labels.mod_reset_midnight },
    { value: "never", label: labels.mod_reset_never },
  ];
  return (
    <div ref={box} className="flex flex-col gap-4" data-food-times>
      <h2 className="text-[19px] font-bold">{labels.mod_times}</h2>
      <div className="flex flex-wrap gap-6">
        <StepperField name="prep_minutes" label={labels.mod_prep} value={prep} range={PREP_RANGE} labels={labels} disabled={disabled} />
        <div data-needs-delivery>
          <StepperField name="delivery_minutes" label={labels.mod_delivery_time} value={delivery} range={DELIVERY_RANGE} labels={labels} disabled={disabled} />
        </div>
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1.5 text-sm font-semibold">{labels.mod_reset_label}</legend>
        <div className="grid grid-cols-3 gap-2">
          {resets.map((r) => (
            <label key={r.value} className="relative">
              <input type="radio" name="delay_reset" value={r.value} defaultChecked={reset === r.value} disabled={disabled} className="peer sr-only" />
              <span className="flex min-h-12 cursor-pointer items-center justify-center rounded-xl border border-[#D6D6D6] bg-white px-2 text-center text-sm font-bold peer-checked:border-2 peer-checked:border-[#111] peer-checked:bg-[#111] peer-checked:text-white peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2">
                {r.label}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <Toggle name="warn_long_delay" label={labels.mod_warn} defaultChecked={warn} disabled={disabled} />
      <div className="flex flex-col gap-1 rounded-2xl rounded-bl-sm bg-[#F6F7F9] p-3" data-food-preview>
        <span className="text-xs font-bold uppercase tracking-wide text-muted">{labels.mod_preview}</span>
        <p>{sentence}</p>
      </div>
    </div>
  );
}
