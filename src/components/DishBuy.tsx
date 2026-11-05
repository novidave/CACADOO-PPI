"use client";

import Link from "next/link";
import { useId, useState } from "react";
import type { Locale } from "@/i18n/config";
import { ItemListButton, type ItemListLabels } from "@/components/ItemListButton";
import { StockDot } from "@/components/StockDot";

export interface DishLine {
  id: string;
  /** The size ("32 cm"); null for a dish without sizes. */
  label: string | null;
  /** As the list keeps it: the name in the page language (+ the size) and the shop's own. */
  name: string;
  original: string | null;
  price: number;
  currency: string;
  priceText: string;
  soldOut: boolean;
  /** "Objednať" (only while ordering in the assistant is on and the line is not sold out). */
  orderHref: string | null;
}

/**
 * A dish's price on its page (update 84; the product page's main card): the sizes as a choice (one price shown, the
 * first one not sold out picked), the green "Dostupné" / red "Vypredané dnes" pill, "Pridať do nákupného zoznamu" (the
 * SAME list as the restaurant page's Zoznam: `ItemListButton`, keyed by the size) and "Objednať" (a real link to the
 * shop page's assistant with that dish). Every size and price is in the first HTML.
 */
export function DishBuy({
  shopId,
  lang,
  lines,
  labels,
}: {
  shopId: string;
  lang: Locale;
  lines: DishLine[];
  labels: {
    price: string;
    sizes: string;
    available: string;
    soldOut: string;
    order: string;
    orderAria: string;
    list: ItemListLabels;
  };
}) {
  const [picked, setPicked] = useState(() => (lines.find((l) => !l.soldOut) ?? lines[0]).id);
  const line = lines.find((l) => l.id === picked) ?? lines[0];
  const name = useId();
  const sized = lines.some((l) => l.label);

  return (
    <div className="flex flex-col gap-3" data-dish-buy>
      {sized && (
        <fieldset className="flex flex-col gap-2" data-dish-sizes>
          <legend className="mb-2 text-sm font-semibold text-[#5B6670]">{labels.sizes}</legend>
          <div className="flex flex-wrap gap-2">
            {lines.map((l) => (
              <label
                key={l.id}
                className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-full border-[1.5px] px-4 text-[15px] font-bold has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[#2563EB] ${
                  l.id === line.id ? "border-[#F57C20] bg-[#FFF1E6] text-[#9A3A0A]" : "border-[#ECE7DE] bg-white"
                }`}
                data-dish-size={l.id}
                data-sold-out={l.soldOut || undefined}
              >
                <input type="radio" name={name} value={l.id} checked={l.id === line.id} onChange={() => setPicked(l.id)} className="sr-only" />
                <span>{l.label}</span>
                <span className={`font-medium tabular-nums ${l.soldOut ? "text-[#9B1C1C] line-through" : "text-[#5B6670]"}`}>{l.priceText}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <p className="text-[30px] leading-none font-bold tabular-nums" data-item-price>
          <span className="sr-only">{labels.price}: </span>
          {line.priceText}
        </p>
        <span
          className="inline-flex min-h-8 items-center gap-2 rounded-full px-3 text-sm font-bold"
          style={line.soldOut ? { background: "#FDECEC", color: "#9B1C1C" } : { background: "#E3F1EC", color: "#1F6150" }}
          data-item-stock-pill={line.soldOut ? "sold_out" : "available"}
        >
          <StockDot state={line.soldOut ? "sold_out" : "available"} size={10} />
          {line.soldOut ? labels.soldOut : labels.available}
        </span>
      </div>
      <hr className="border-[#F1EDE6]" />
      <ItemListButton
        key={line.id}
        shopId={shopId}
        item={{ id: line.id, name: line.name, original: line.original, price: line.price, currency: line.currency }}
        lang={lang}
        labels={labels.list}
      />
      {line.orderHref && (
        <Link
          href={line.orderHref}
          className="flex min-h-[52px] items-center justify-center rounded-2xl bg-[#F57C20] px-4 text-base font-bold text-white"
          aria-label={labels.orderAria.replace("{name}", line.name)}
          data-dish-order={line.id}
        >
          {labels.order}
        </Link>
      )}
    </div>
  );
}
