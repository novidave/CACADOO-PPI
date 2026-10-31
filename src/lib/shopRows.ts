import type { Locale } from "@/i18n/config";
import type { ShopItemRow, ShopSearchRow } from "@/lib/data";
import { formatPrice } from "@/lib/format";
import { itemNames } from "@/lib/names";
import { highlightParts } from "@/lib/searchWords";
import { stockState, type StockState } from "@/lib/stockDot";

/**
 * One product row of the shop page's "Produkty" tab, written on the server (the first HTML and the live search's
 * answers alike): the names as `itemNames()` shows them, the price as the shop's file has it, the stock dot's state
 * from the database (`public_stock`'s availability). No stock sentence: in listings the dot carries it (2026-10-29).
 */
export interface ProductRow {
  id: string;
  name: string;
  original: string | null;
  price: number | null;
  currency: string;
  priceText: string;
  stock: StockState;
  /**
   * The name and the shop's name cut where the search's words matched, marked on the server (@/lib/searchWords, so the
   * page's JavaScript does not carry the rule): plain, marked, plain, marked… — null without a match.
   */
  nameMarks: string[] | null;
  originalMarks: string[] | null;
}

export interface ProductRows {
  q: string;
  /** exact / match / similar (update 54); null without words. */
  kind: ShopSearchRow["kind"] | null;
  total: number;
  rows: ProductRow[];
}

/** "Akrylové médium" with "akril" → ["", "Akrylové", " médium"] (every odd piece is marked); null without a hit. */
export function marks(text: string, matched: string[]): string[] | null {
  if (!matched.length) return null;
  const out: string[] = [""];
  for (const part of highlightParts(text, matched)) {
    const odd = out.length % 2 === 0;
    if (part.hit === odd) out[out.length - 1] += part.text;
    else out.push(part.text);
  }
  return out.length > 1 ? out : null;
}

export function productRow(item: ShopItemRow & { matched?: string[] }, lang: Locale): ProductRow {
  const names = itemNames(item.item_name, item.item_name_i18n, lang);
  return {
    id: item.item_id,
    name: names.primary,
    original: names.secondary,
    price: item.price === null ? null : Number(item.price),
    currency: item.currency,
    priceText: formatPrice(item.price, lang, item.currency),
    stock: stockState(item.availability),
    nameMarks: marks(names.primary, item.matched ?? []),
    originalMarks: names.secondary ? marks(names.secondary, item.matched ?? []) : null,
  };
}
