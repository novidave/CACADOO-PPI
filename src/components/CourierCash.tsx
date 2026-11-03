"use client";

import { useState } from "react";
import { cashChoices, changeCents, money } from "@/lib/foodRules";
import { CourierStep } from "./CourierStep";

/**
 * "Hotovosť" (board 18): what the customer gave — Presne, the notes that cover the total, or "Iná suma" — and the change
 * to give, then one tap "Zaplatené · Doručené" (the payment mark and the delivery in one step, its UUID once).
 * The database checks the amount again (never less than the total).
 */
export function CourierCash({
  lang,
  totalCents,
  initialGiven,
  hidden,
  next,
  back,
  labels,
  stepLabels,
  buttonClass,
}: {
  lang: string;
  totalCents: number;
  initialGiven: number | null;
  hidden: Record<string, string>;
  next: string;
  back: string;
  labels: { given: string; exact: string; other: string; otherShort: string; change: string; confirm: string };
  stepLabels: { sending: string; retrying: string; errors: Record<string, string>; failed: string };
  buttonClass: string;
}) {
  const choices = cashChoices(totalCents).filter((c) => c !== totalCents);
  const start = initialGiven !== null && choices.includes(initialGiven) ? String(initialGiven) : String(totalCents);
  const [picked, setPicked] = useState(start);
  const [other, setOther] = useState("");
  const otherCents = /^\d{1,6}([.,]\d{1,2})?$/.test(other.trim()) ? Math.round(Number(other.trim().replace(",", ".")) * 100) : null;
  const given = picked === "other" ? otherCents : Number(picked);
  const change = changeCents(totalCents, given);
  const tooLittle = given !== null && given < totalCents;
  const pill =
    "flex min-h-[52px] cursor-pointer items-center justify-center rounded-xl border border-[#D6D6D6] bg-white px-2 text-[17px] font-bold peer-checked:border-[#111] peer-checked:bg-[#111] peer-checked:text-white peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2";

  return (
    <CourierStep
      hidden={hidden}
      next={next}
      back={back}
      className={`${buttonClass} min-h-14 w-full`}
      formClassName="flex flex-col gap-3"
      disabled={given === null || tooLittle}
      labels={stepLabels}
      data="cash"
      fields={
        <>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-semibold">{labels.given}</legend>
            <div className="grid grid-cols-3 gap-2">
              {[String(totalCents), ...choices.map(String)].map((value) => (
                <label key={value} className="relative">
                  <input
                    type="radio"
                    name="cash_given_cents"
                    value={value}
                    checked={picked === value}
                    onChange={() => setPicked(value)}
                    className="peer sr-only"
                  />
                  <span className={pill}>{value === String(totalCents) ? labels.exact : money(Number(value), lang)}</span>
                </label>
              ))}
              <label className="relative">
                <input type="radio" name="cash_given_cents" value="" checked={picked === "other"} onChange={() => setPicked("other")} className="peer sr-only" />
                <span className={pill}>{labels.otherShort}</span>
              </label>
            </div>
            {picked === "other" && (
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-semibold">{labels.other}</span>
                <input
                  name="cash_other"
                  inputMode="decimal"
                  autoFocus
                  value={other}
                  onChange={(e) => setOther(e.target.value)}
                  className="min-h-[52px] w-full rounded-xl border border-[#D6D6D6] bg-white px-3.5 text-[24px] font-bold outline-none focus:border-[#111]"
                />
              </label>
            )}
          </fieldset>
          <p className="flex items-baseline justify-between rounded-xl bg-[#F6F6F6] p-3" aria-live="polite" data-courier-change>
            <span className="text-[16px] font-semibold">{labels.change}</span>
            <strong className="text-[28px]">{change === null ? "–" : money(change, lang)}</strong>
          </p>
        </>
      }
    >
      {labels.confirm}
    </CourierStep>
  );
}
