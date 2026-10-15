import type { Locale } from "@/i18n/config";
import { formatDate, formatTime, localDay } from "./format";

/**
 * Layer 2 of the main chat's search (Prompt 11 phase B): partner shops' own product feeds
 * (database update 35, imported by the partner-feeds Edge Function). One row of
 * search_partner_products() and the texts of its card. The database decides what is fresh (48
 * hours) and leaves out availability and store stock of older data; these helpers only write it
 * out. Plain functions: used by the chat server and the Deno tests (src/lib/chat_test.ts).
 */

export interface PartnerStore {
  code: string;
  name: string;
  address: string | null;
  city: string | null;
  /** As the partner's local inventory feed wrote it. */
  availability: string | null;
  state: "in_stock" | "limited" | "out_of_stock" | "on_display" | "preorder" | "backorder" | "unknown";
  quantity: number | null;
  updated_at: string;
}

export interface PartnerHit {
  partner_id: string;
  partner_name: string;
  partner_logo: string | null;
  partner_timezone: string;
  affiliate: boolean;
  item_id: string;
  title: string;
  brand: string | null;
  gtin: string | null;
  price: number | null;
  /** The regular price while a sale price applies. */
  regular_price: number | null;
  currency: string | null;
  link: string | null;
  image_link: string | null;
  /** null when the data is older than 48 hours. */
  availability: string | null;
  availability_state: "in_stock" | "out_of_stock" | "preorder" | "backorder" | "in_days" | "unknown" | null;
  availability_days: number | null;
  updated_at: string;
  stale: boolean;
  /** The partner's stores in the shopper's town with this item (from the local inventory feed only). */
  stores: PartnerStore[];
}

/** The partner texts of the dictionary (search.partner_*). */
export interface PartnerTexts {
  partner_online_in_stock: string;
  partner_online_out_of_stock: string;
  partner_online_preorder: string;
  partner_online_backorder: string;
  partner_online_in_days: string;
  partner_online_raw: string;
  partner_store: string;
  partner_store_in_stock: string;
  partner_store_limited: string;
  partner_store_out_of_stock: string;
  partner_store_on_display: string;
  partner_store_preorder: string;
  partner_store_backorder: string;
  partner_store_raw: string;
  partner_data_time: string;
  partner_data_day: string;
}

const fill = (text: string, values: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (whole, key: string) => (key in values ? String(values[key]) : whole));

/** In stock in one of the partner's stores in the town (the partner's own word), with data under 48 hours. */
export function isGoodPartner(hit: PartnerHit): boolean {
  return !hit.stale && hit.stores.some((s) => s.state === "in_stock" || s.state === "limited");
}

/** "online skladom" / "online do 3 dní" / "online: 2026-11-02"; null when old or unknown. */
export function partnerOnlineText(hit: PartnerHit, x: PartnerTexts): string | null {
  if (hit.stale || !hit.availability_state) return null;
  switch (hit.availability_state) {
    case "in_stock":
      return x.partner_online_in_stock;
    case "out_of_stock":
      return x.partner_online_out_of_stock;
    case "preorder":
      return x.partner_online_preorder;
    case "backorder":
      return x.partner_online_backorder;
    case "in_days":
      return fill(x.partner_online_in_days, { days: hit.availability_days ?? "?" });
  }
  return hit.availability ? fill(x.partner_online_raw, { value: hit.availability }) : null;
}

/** "predajňa Košice: skladom podľa partnera". */
export function partnerStoreText(store: PartnerStore, x: PartnerTexts): string {
  const said: Record<string, string> = {
    in_stock: x.partner_store_in_stock,
    limited: x.partner_store_limited,
    out_of_stock: x.partner_store_out_of_stock,
    on_display: x.partner_store_on_display,
    preorder: x.partner_store_preorder,
    backorder: x.partner_store_backorder,
  };
  const status = said[store.state] ?? fill(x.partner_store_raw, { value: store.availability ?? "?" });
  return fill(x.partner_store, { store: store.name, status });
}

/** "údaje z 08:00" (today in the partner's time zone), "údaje z 13. 10. 2026 08:00", or for old data only the day. */
export function partnerTimeText(hit: Pick<PartnerHit, "updated_at" | "stale" | "partner_timezone">, x: PartnerTexts, lang: Locale, now = new Date()): string {
  const at = new Date(hit.updated_at);
  const tz = hit.partner_timezone;
  if (hit.stale) return fill(x.partner_data_day, { date: formatDate(at, lang, tz) });
  const time = formatTime(at, tz);
  return localDay(at, tz) === localDay(now, tz)
    ? fill(x.partner_data_time, { time })
    : fill(x.partner_data_time, { time: `${formatDate(at, lang, tz)} ${time}` });
}

/** The public address of a partner's logo (bucket partner-logos). */
export function partnerLogoUrl(base: string, path: string | null): string | null {
  return path && /^[0-9a-f-]{36}\/logo-\d{13}\.(webp|png|jpg)$/.test(path) ? `${base}/storage/v1/object/public/partner-logos/${path}` : null;
}
