"use client";

import { useState, useSyncExternalStore } from "react";
import type { Locale } from "@/i18n/config";
import { formatPrice } from "@/lib/format";
import { addOne, lineAmount, listStore, MAX_QTY, qtyOf, serverList, setQty, type ListItem } from "@/lib/shoppingList";

export interface ItemListLabels {
  add: string;
  in_list: string;
  /** "Spolu {amount}" */
  total: string;
  minus: string;
  plus: string;
  remove: string;
  /** "{n} ks v zozname" (screen readers) */
  count: string;
  said_added: string;
  said_removed: string;
}

/**
 * "Pridať do nákupného zoznamu" on the product page (the unified design, 2026-11-04): the SAME list as the shop page's
 * "Zoznam" (`listStore(shopId)`, localStorage `ppi.list.<shop id>`, the same entry: name in the page language, the
 * shop's own name, the price and currency as shown) — what is added here is in the shop page's Zoznam and the other way
 * round, in every tab. Once on the list: "V zozname · Spolu 42,90 €" with − (a bin at 1) / count / +. Sent nowhere.
 * The server's HTML shows the button (the list lives in the browser); both states are the same height.
 */
export function ItemListButton({ shopId, item, lang, labels }: { shopId: string; item: ListItem; lang: Locale; labels: ItemListLabels }) {
  const store = listStore(shopId);
  const list = useSyncExternalStore(store.subscribe, store.get, serverList);
  const qty = qtyOf(list, item.id);
  const [said, setSaid] = useState("");
  const entry = list.find((e) => e.id === item.id);
  const amount = entry ? lineAmount(entry) : null;

  const change = (next: number) => {
    store.set(next < 1 ? setQty(list, item.id, 0) : qty === 0 ? addOne(list, item) : setQty(list, item.id, next));
    setSaid(next < 1 ? labels.said_removed : labels.said_added);
  };

  return (
    <div data-item-list={qty > 0 ? "in" : "out"}>
      {qty === 0 ? (
        <button
          type="button"
          onClick={() => change(1)}
          className="flex min-h-[52px] w-full items-center justify-center gap-2.5 rounded-2xl border-[1.5px] border-[#F57C20] bg-white px-4 text-base font-bold text-[#1A1A1A] active:scale-[0.99] motion-reduce:active:scale-100"
          data-item-list-add
        >
          <ListIcon />
          {labels.add}
        </button>
      ) : (
        <div className="flex min-h-[52px] items-center justify-between gap-3 rounded-2xl border-[1.5px] border-[#F57C20] bg-[#FFF1E6] py-1.5 pr-1.5 pl-3.5" data-item-list-stepper>
          <span className="flex min-w-0 items-center gap-2">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#F57C20" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" className="shrink-0">
              <path d="M5 12.5l4.5 4.5L19 7.5" />
            </svg>
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="text-[15px] font-bold">{labels.in_list}</span>
              {amount !== null && entry && (
                <span className="text-[13px] text-[#9A3A0A]" data-item-list-total>
                  {labels.total.replace("{amount}", formatPrice(amount, lang, entry.currency))}
                </span>
              )}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-1" role="group" aria-label={labels.count.replace("{n}", String(qty))}>
            <button
              type="button"
              onClick={() => change(qty - 1)}
              aria-label={qty === 1 ? labels.remove : labels.minus}
              className="flex h-11 w-11 items-center justify-center rounded-xl bg-white text-[#C2410C]"
              data-item-list-minus
            >
              {qty === 1 ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                  <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3" />
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true" focusable="false">
                  <path d="M5 12h14" />
                </svg>
              )}
            </button>
            <span className="min-w-8 text-center text-base font-bold tabular-nums" data-item-list-qty>
              {qty}
            </span>
            <button
              type="button"
              onClick={() => change(Math.min(MAX_QTY, qty + 1))}
              disabled={qty >= MAX_QTY}
              aria-label={labels.plus}
              className="flex h-11 w-11 items-center justify-center rounded-xl bg-white text-[#C2410C] disabled:opacity-40"
              data-item-list-plus
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true" focusable="false">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
          </span>
        </div>
      )}
      <span className="sr-only" role="status" aria-live="polite">
        {said}
      </span>
    </div>
  );
}

function ListIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#F57C20" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M9 6h11M9 12h11M9 18h11" />
      <circle cx="4.5" cy="6" r="1.2" fill="#F57C20" />
      <circle cx="4.5" cy="12" r="1.2" fill="#F57C20" />
      <circle cx="4.5" cy="18" r="1.2" fill="#F57C20" />
    </svg>
  );
}
