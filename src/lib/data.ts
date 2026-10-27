import "server-only";
import { cache } from "react";
import { loadLiveSites } from "./customDomain";
import type { CalendarDay } from "./hours";
import { missingColumn } from "./missingColumn";
import { loadCalendars } from "./shopCalendar";
import { createCachedPublicClient } from "./supabase/public";
import type { OpeningHours } from "./hours";
import type { NameI18n } from "./names";
import type { AvailabilityKey, FreshnessState, StockRow } from "./stock";

/** One row of public.public_shops. */
export interface PublicShop {
  id: string;
  slug: string;
  name: string;
  address: string | null;
  city: string | null;
  country: string | null;
  timezone: string;
  phone: string | null;
  website: string | null;
  logo_url: string | null;
  opening_hours: OpeningHours | null;
  lat: number | null;
  lng: number | null;
  freshness_state: FreshnessState;
  freshness_age_minutes: number | null;
  latest_file_time: string | null;
  has_toilet: boolean;
  has_douchette: boolean;
  has_card_terminal: boolean;
  email: string | null;
  facebook_url: string | null;
  /** The owner's own assistant button label and welcome text (plain text; null = the default text). */
  assistant_label: string | null;
  assistant_welcome: string | null;
  /** The shop's page in a booking app (https only; database update 26 — null before it). */
  booking_url: string | null;
  /** The own domain's home language (update 40, "Predvolený jazyk na vlastnej doméne"; null before it). */
  site_lang?: string | null;
  /** The company under the address (database updates 47/48; from shopCompany(), not public_shops). */
  zip?: string | null;
  company_name?: string | null;
  ico?: string | null;
  dic?: string | null;
}

/** One row of public.shop_stock(). */
export interface ShopItemRow {
  item_id: string;
  item_name: string;
  ean: string | null;
  brand: string | null;
  price: number | null;
  currency: string;
  quantity: number | null;
  availability: AvailabilityKey | null;
  is_available: boolean;
  freshness_state: FreshnessState;
  freshness_age_minutes: number | null;
  latest_file_time: string | null;
  updated_at: string | null;
  total_count: number;
  item_name_lang: string | null;
  item_name_i18n: NameI18n | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHOP_COLUMNS_BEFORE_26 =
  "id, slug, name, address, city, country, timezone, phone, website, logo_url, opening_hours, lat, lng, freshness_state, freshness_age_minutes, latest_file_time, has_toilet, has_douchette, has_card_terminal, email, facebook_url, assistant_label, assistant_welcome";
const SHOP_COLUMNS_BEFORE_40 = `${SHOP_COLUMNS_BEFORE_26}, booking_url`;
const SHOP_COLUMNS = `${SHOP_COLUMNS_BEFORE_40}, site_lang`;

/** Shops from public_shops, with the booking link (update 26) and the own domain's home language (update 40) once they are in. */
async function publicShops<T>(query: (columns: string) => PromiseLike<{ data: T | null; error: { code?: string; message: string } | null }>) {
  const result = await query(SHOP_COLUMNS);
  if (!missingColumn(result.error, "site_lang")) return result;
  const before40 = await query(SHOP_COLUMNS_BEFORE_40);
  if (!missingColumn(before40.error, "booking_url")) return before40;
  return await query(SHOP_COLUMNS_BEFORE_26);
}

/**
 * What visitors see, read with the anon key and no cookies through the short shared cache (createCachedPublicClient:
 * at most 60 s old; owner saves and new stock files refresh it at once). Every visitor — an owner too — sees the same.
 */
async function client() {
  const supabase = createCachedPublicClient();
  if (!supabase) throw new Error("Supabase is not configured (see SETUP.md)");
  return supabase;
}

/** Cached per request, so metadata and page share one query. */
export const getShop = cache(async (slug: string): Promise<PublicShop | null> => {
  const db = await client();
  const { data, error } = await publicShops((columns) => db.from("public_shops").select(columns).eq("slug", slug).maybeSingle());
  if (error) throw new Error(error.message);
  return data ? ({ booking_url: null, ...(data as object) } as PublicShop) : null;
});

export async function getShopsByIds(ids: string[]): Promise<Map<string, PublicShop>> {
  if (ids.length === 0) return new Map();
  const db = await client();
  const { data, error } = await publicShops((columns) => db.from("public_shops").select(columns).in("id", ids));
  if (error) throw new Error(error.message);
  return new Map(((data ?? []) as unknown as PublicShop[]).map((s) => [s.id, { ...s, booking_url: s.booking_url ?? null }]));
}

export async function getShopItems(
  slug: string,
  q: string,
  page: number,
  pageSize: number,
): Promise<{ items: ShopItemRow[]; total: number }> {
  const { data, error } = await (await client()).rpc("shop_stock", {
    p_slug: slug,
    q: q || null,
    p_limit: pageSize,
    p_offset: (page - 1) * pageSize,
  });
  if (error) throw new Error(error.message);
  const items = (data ?? []) as ShopItemRow[];
  return { items, total: Number(items[0]?.total_count ?? 0) };
}

/** Whether the shop has the paid plan — the database decides (false until the plan is set up). */
export async function shopHasPlan(shopId: string): Promise<boolean> {
  const { data, error } = await (await client()).rpc("shop_has_plan", { p_shop_id: shopId });
  return !error && data === true;
}

/**
 * Whether the shop's product pages show no other shops: the paid plan, or a domain of its
 * own being set up or live (shop_stands_alone(), database update 26; the plan alone before it).
 */
export async function shopStandsAlone(shopId: string): Promise<boolean> {
  const { data, error } = await (await client()).rpc("shop_stands_alone", { p_shop_id: shopId });
  if (error) return shopHasPlan(shopId);
  return data === true;
}

/** The special days and holidays of these shops for the status (database update 27; none before it). */
export async function getShopCalendars(shopIds: string[], days = 16): Promise<Map<string, CalendarDay[]>> {
  return loadCalendars(await client(), shopIds, days);
}

/**
 * Whether shoppers of this shop may download their own conversation as a PDF (paid plan; on
 * unless the owner turned it off; database update 24 — false before it).
 */
export async function shopperPdfAllowed(slug: string): Promise<boolean> {
  const { data, error } = await (await client()).rpc("shopper_pdf_allowed", { p_slug: slug });
  return !error && data === true;
}

/**
 * After the owner deleted the whole stock, until the next file is applied: the shop page says "Sortiment sa práve
 * aktualizuje" instead of "no products" (database update 43 decides; false before it).
 */
/** PSČ, company name, IČO and DIČ for the shop page and its JSON-LD (database update 48; null before it). */
export async function shopCompany(slug: string): Promise<{ zip: string | null; company_name: string | null; ico: string | null; dic: string | null } | null> {
  const { data, error } = await (await client()).rpc("shop_company_details", { p_slug: slug });
  const row = !error && Array.isArray(data) ? data[0] : null;
  return row ?? null;
}

export async function shopStockResetting(slug: string): Promise<boolean> {
  const { data, error } = await (await client()).rpc("shop_stock_resetting", { p_slug: slug });
  return !error && data === true;
}

/**
 * The shop's own domain while it is live (canonical address, JSON-LD, links), else null.
 * Database update 25 — null before it.
 */
export async function shopSiteHost(slug: string): Promise<string | null> {
  const { data, error } = await (await client()).rpc("shop_site", { p_slug: slug });
  return !error && typeof data === "string" && data ? data : null;
}

/** Shops whose own domain is live: slug → host, once per request (search results link there). */
export const getLiveSites = cache(async (): Promise<Map<string, string>> => {
  try {
    return await loadLiveSites(await client());
  } catch {
    return new Map();
  }
});

/** An item as visitors may see it (public_stock), or null. */
export const getItem = cache(async (id: string): Promise<StockRow | null> => {
  if (!UUID.test(id)) return null;
  const { data, error } = await (await client())
    .from("public_stock")
    .select(
      "item_id, item_name, ean, brand, shop_id, shop_slug, shop_name, shop_address, shop_city, shop_country, shop_timezone, shop_lat, shop_lng, price, currency, quantity, availability, is_available, freshness_state, freshness_age_minutes, latest_file_time, updated_at, item_name_lang, item_name_i18n",
    )
    .eq("item_id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? ({ ...data, distance_km: null } as StockRow) : null;
});

/** The same product (EAN) in other shops, nearest to `near` first (any distance if unknown). */
export async function getOtherOffers(
  item: StockRow,
  near: { lat: number; lng: number } | null,
): Promise<StockRow[]> {
  if (!item.ean) return [];
  const { data, error } = await (await client()).rpc("search_stock", {
    q: item.ean,
    lat: near?.lat ?? null,
    lng: near?.lng ?? null,
    radius_km: 500,
    only_available: false,
  });
  if (error) throw new Error(error.message);
  return ((data ?? []) as StockRow[])
    .filter((row) => row.ean === item.ean && row.item_id !== item.item_id)
    .sort((a, b) => (a.distance_km ?? Infinity) - (b.distance_km ?? Infinity));
}
