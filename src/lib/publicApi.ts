import "server-only";
import en from "@/i18n/messages/en.json";
import hu from "@/i18n/messages/hu.json";
import sk from "@/i18n/messages/sk.json";
import { isLocale, type Locale } from "@/i18n/config";
import { canonicalItemUrl, canonicalShopUrl, loadLiveSites } from "./customDomain";
import { type CalendarDay, type OpeningHours, shopStatus, statusText } from "./hours";
import { loadCalendars } from "./shopCalendar";
import { searchAcrossLanguages } from "./queryExpansion";
import { missingColumn } from "./missingColumn";
import { siteUrl } from "./site";
import type { AvailabilityKey, FreshnessState, StockRow } from "./stock";
import { createPublicClient } from "./supabase/public";

/**
 * One source of truth for the public API (/api/v1) and the MCP server (/mcp):
 * same data and rules as the website, because everything comes from the
 * database views/functions (public_stock, search_stock, public_shops,
 * shop_stock). The quantity exactly as in the shop's file; no availability at
 * all for stale shops — the database already enforces both. Every source_url is the page's
 * canonical address: on the shop's live own domain when it has one (update 36), else on PPI.
 */

export const DATA_RULES =
  "Availability comes from each shop's own stock software. 'freshness.state' is 'current' (file under 30 min old), " +
  "'recent' (under 24 h) or 'stale' (older or never); for stale shops availability is null and must not be shown as available. " +
  "'quantity' is the quantity in the shop's own stock file (0 or less = sold out). Always cite 'source_url'.";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHOP_COLUMNS_BEFORE_26 =
  "id, slug, name, address, city, country, timezone, phone, website, email, facebook_url, opening_hours, lat, lng, freshness_state, freshness_age_minutes, latest_file_time, has_toilet, has_douchette, has_card_terminal";
const SHOP_COLUMNS_BEFORE_40 = `${SHOP_COLUMNS_BEFORE_26}, booking_url`;
const SHOP_COLUMNS = `${SHOP_COLUMNS_BEFORE_40}, site_lang`;

/** public_shops with the booking link once database update 26 is in, without it before. */
async function publicShops<T>(query: (columns: string) => PromiseLike<{ data: T | null; error: { code?: string; message: string } | null }>) {
  const result = await query(SHOP_COLUMNS);
  if (!missingColumn(result.error, "site_lang")) return result;
  const before40 = await query(SHOP_COLUMNS_BEFORE_40);
  if (!missingColumn(before40.error, "booking_url")) return before40;
  return await query(SHOP_COLUMNS_BEFORE_26);
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function db() {
  const supabase = createPublicClient();
  if (!supabase) throw new ApiError(503, "Database not configured");
  return supabase;
}

export function apiLang(value: string | null | undefined): Locale {
  return isLocale(value) ? value : "en";
}

/** Shops whose own domain is live: slug → host (live_shop_sites); kept a minute, empty on any error. */
export type LiveSites = Map<string, string>;
let sitesCache: { at: number; sites: LiveSites } | null = null;
async function liveSites(): Promise<LiveSites> {
  if (sitesCache && Date.now() - sitesCache.at < 60_000) return sitesCache.sites;
  const sites = await loadLiveSites(createPublicClient()).catch(() => new Map<string, string>());
  sitesCache = { at: Date.now(), sites };
  return sites;
}

const itemSourceUrl = (sites: LiveSites, lang: Locale, slug: string, itemId: string) => canonicalItemUrl(sites, siteUrl(), lang, slug, itemId);
const shopSourceUrl = (sites: LiveSites, lang: Locale, slug: string, country: string | null) => canonicalShopUrl(sites, siteUrl(), lang, slug, country);

function availabilityText(key: AvailabilityKey | null, quantity: number | null): string | null {
  if (!key) return null;
  return en.stock[key].replace("{n}", String(quantity ?? ""));
}

export function apiItem(row: StockRow, lang: Locale, sites: LiveSites = new Map()) {
  return {
    id: row.item_id,
    /** As the shop wrote it. */
    name: row.item_name,
    /** In the requested language (null until translated). */
    name_translated: row.item_name_i18n?.[lang]?.trim() || null,
    /** Language of `name` (ISO 639-1), detected with the translation. */
    name_lang: row.item_name_lang ?? null,
    brand: row.brand,
    ean: row.ean,
    price: row.price === null ? null : Number(row.price),
    currency: row.currency,
    availability: row.availability,
    availability_text: availabilityText(row.availability, row.quantity),
    is_available: row.is_available,
    quantity: row.quantity === null ? null : Number(row.quantity),
    freshness: {
      state: row.freshness_state,
      age_minutes: row.freshness_age_minutes,
      updated_at: row.latest_file_time,
    },
    distance_km: row.distance_km,
    shop: {
      slug: row.shop_slug,
      name: row.shop_name,
      address: row.shop_address,
      city: row.shop_city,
      country: row.shop_country,
      timezone: row.shop_timezone,
      lat: row.shop_lat,
      lng: row.shop_lng,
      source_url: shopSourceUrl(sites, lang, row.shop_slug, row.shop_country),
    },
    source_url: itemSourceUrl(sites, lang, row.shop_slug, row.item_id),
  };
}

interface ShopRow {
  id: string;
  slug: string;
  name: string;
  address: string | null;
  city: string | null;
  country: string | null;
  timezone: string;
  phone: string | null;
  website: string | null;
  email: string | null;
  facebook_url: string | null;
  booking_url?: string | null;
  opening_hours: OpeningHours | null;
  lat: number | null;
  lng: number | null;
  freshness_state: FreshnessState;
  freshness_age_minutes: number | null;
  latest_file_time: string | null;
  has_toilet: boolean;
  has_douchette: boolean;
  has_card_terminal: boolean;
}

const STATUS_LABELS: Record<string, typeof en.status> = { sk: sk.status, hu: hu.status, en: en.status };

/**
 * The shop's status now — open / break / closed / holiday / no_hours — computed with the same
 * function as the website (src/lib/hours.ts) from the hours, the owner's special days and the
 * holidays that apply (shop_calendar()), with the status in words and when it changes next.
 */
export function apiStatus(
  shop: { opening_hours: OpeningHours | null; timezone: string | null },
  calendar: CalendarDay[],
  lang: Locale,
  now: Date = new Date(),
) {
  const status = shopStatus({ hours: shop.opening_hours, timeZone: shop.timezone, days: calendar }, now);
  return {
    state: status.state,
    text: statusText(status, STATUS_LABELS[lang] ?? en.status, lang),
    /** "holiday" = special hours on a holiday or a shortened holiday; "special" = the owner's special hours. */
    label: status.label,
    next_change: status.nextChange,
  };
}

/** Each shop's special days and holidays (database update 27; none before it). */
async function calendarsFor(ids: string[], days = 16) {
  return loadCalendars(db(), ids, days).catch(() => new Map<string, CalendarDay[]>());
}

export function apiShop(shop: ShopRow, lang: Locale, calendar: CalendarDay[] = [], sites: LiveSites = new Map()) {
  const status = apiStatus(shop, calendar, lang);
  return {
    slug: shop.slug,
    name: shop.name,
    address: shop.address,
    city: shop.city,
    country: shop.country,
    lat: shop.lat,
    lng: shop.lng,
    timezone: shop.timezone,
    phone: shop.phone,
    website: shop.website,
    email: shop.email,
    facebook_url: shop.facebook_url,
    booking_url: shop.booking_url ?? null,
    opening_hours: shop.opening_hours,
    open_now: status.state === "open" ? true : status.state === "break" || status.state === "closed" ? false : null,
    status,
    facilities: {
      customer_toilet: shop.has_toilet,
      douchette: shop.has_douchette,
      card_payment: shop.has_card_terminal,
    },
    freshness: {
      state: shop.freshness_state,
      age_minutes: shop.freshness_age_minutes,
      updated_at: shop.latest_file_time,
    },
    source_url: shopSourceUrl(sites, lang, shop.slug, shop.country),
  };
}

/** "48.75,21.92" or a town where PPI has shops ("Michalovce", accents optional). */
export async function resolveNear(near: string | null | undefined) {
  const text = (near ?? "").trim();
  if (!text) return null;
  const coords = text.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (coords) {
    const lat = Number(coords[1]);
    const lng = Number(coords[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng, source: "coordinates" as const };
    throw new ApiError(400, "near: latitude must be -90..90 and longitude -180..180");
  }
  const { data, error } = await db().rpc("town_center", { p_town: text.slice(0, 100) });
  if (error) throw new ApiError(500, error.message);
  const town = (data ?? [])[0] as { lat: number; lng: number; town: string; country: string | null } | undefined;
  if (!town) return { lat: null, lng: null, source: "unknown_town" as const, town: text };
  return { lat: town.lat, lng: town.lng, source: "town" as const, town: town.town, country: town.country };
}

export async function searchStock(params: {
  q: string;
  lat?: number | null;
  lng?: number | null;
  near?: string | null;
  radiusKm?: number | null;
  onlyAvailable?: boolean;
  lang: Locale;
  /** The main page's chat cards: each shop also gets what its status is computed from (its live dot). */
  withStatusInput?: boolean;
}) {
  let location: Awaited<ReturnType<typeof resolveNear>> = null;
  if (params.lat != null && params.lng != null) {
    if (Math.abs(params.lat) > 90 || Math.abs(params.lng) > 180) throw new ApiError(400, "lat/lng out of range");
    location = { lat: params.lat, lng: params.lng, source: "coordinates" };
  } else if (params.near) {
    location = await resolveNear(params.near);
  }
  const radius = Math.min(Math.max(Number(params.radiusKm) || 10, 0.1), 500);
  const hasPoint = location?.lat != null && location?.lng != null;

  // Every language (update 40): names in any translation; a search with no hit (or in Chinese) also in Claude's words.
  const run = async (q: string) => {
    const { data, error } = await db().rpc("search_stock", {
      q: q.slice(0, 200) || null,
      lat: hasPoint ? location!.lat : null,
      lng: hasPoint ? location!.lng : null,
      radius_km: radius,
      only_available: Boolean(params.onlyAvailable),
    });
    if (error) throw new ApiError(500, error.message);
    return (data ?? []) as StockRow[];
  };
  const rows = await searchAcrossLanguages(params.q, run, (r) => r.item_id);
  // Each result's shop gets its status (the same rule as the page): hours + special days + holidays.
  const ids = [...new Set(rows.map((r) => r.shop_id))];
  const [hours, calendars, sites] = await Promise.all([
    ids.length
      ? db().from("public_shops").select("id, opening_hours, timezone").in("id", ids)
      : Promise.resolve({ data: [], error: null }),
    calendarsFor(ids),
    rows.length ? liveSites() : Promise.resolve(new Map<string, string>()),
  ]);
  const hoursOf = new Map(((hours.data ?? []) as { id: string; opening_hours: OpeningHours | null; timezone: string }[]).map((h) => [h.id, h]));
  const now = new Date();
  const results = rows.map((row) => {
    const item = apiItem(row, params.lang, sites);
    const shopHours = hoursOf.get(row.shop_id);
    if (!shopHours) return item;
    const calendar = calendars.get(row.shop_id) ?? [];
    return {
      ...item,
      shop: {
        ...item.shop,
        status: apiStatus(shopHours, calendar, params.lang, now),
        ...(params.withStatusInput ? { status_input: { hours: shopHours.opening_hours, timeZone: shopHours.timezone, days: calendar } } : {}),
      },
    };
  });
  return {
    query: params.q,
    location: location ?? { source: "none" },
    radius_km: hasPoint ? radius : null,
    note:
      location?.source === "unknown_town"
        ? `PPI has no shops in a town called "${location.town}"; searched all shops instead.`
        : hasPoint
          ? undefined
          : "No location given: searched all shops (no distances).",
    count: results.length,
    results,
    data_rules: DATA_RULES,
  };
}

export async function listShops(lang: Locale) {
  const { data, error } = await publicShops((columns) => db().from("public_shops").select(columns).order("name").limit(1000));
  if (error) throw new ApiError(500, error.message);
  const shops = (data ?? []) as unknown as ShopRow[];
  const [calendars, sites] = await Promise.all([calendarsFor(shops.map((s) => s.id)), liveSites()]);
  return { count: shops.length, shops: shops.map((s) => apiShop(s, lang, calendars.get(s.id) ?? [], sites)), data_rules: DATA_RULES };
}

export async function getShop(slug: string, lang: Locale) {
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) throw new ApiError(404, "Shop not found");
  const { data, error } = await publicShops((columns) => db().from("public_shops").select(columns).eq("slug", slug).maybeSingle());
  if (error) throw new ApiError(500, error.message);
  if (!data) throw new ApiError(404, "Shop not found");
  const shop = data as unknown as ShopRow;
  const [calendars, sites] = await Promise.all([calendarsFor([shop.id]), liveSites()]);
  return { shop: apiShop(shop, lang, calendars.get(shop.id) ?? [], sites), data_rules: DATA_RULES };
}

export async function getShopItems(slug: string, pageNumber: number, q: string, lang: Locale) {
  const shop = (await getShop(slug, lang)).shop;
  const pageSize = 50;
  const current = Math.max(1, Math.floor(pageNumber) || 1);
  const { data, error } = await db().rpc("shop_stock", {
    p_slug: slug,
    q: q || null,
    p_limit: pageSize,
    p_offset: (current - 1) * pageSize,
  });
  if (error) throw new ApiError(500, error.message);
  const rows = (data ?? []) as (Omit<StockRow, "shop_id" | "shop_slug" | "shop_name"> & { total_count: number })[];
  const total = Number(rows[0]?.total_count ?? 0);
  const sites = await liveSites();
  return {
    shop,
    page: current,
    page_size: pageSize,
    total,
    pages: Math.max(1, Math.ceil(total / pageSize)),
    items: rows.map((row) =>
      apiItem(
        {
          ...row,
          shop_id: "",
          shop_slug: shop.slug,
          shop_name: shop.name,
          shop_address: shop.address,
          shop_city: shop.city,
          shop_country: shop.country,
          shop_timezone: shop.timezone,
          shop_lat: shop.lat,
          shop_lng: shop.lng,
          distance_km: null,
        } as StockRow,
        lang,
        sites,
      ),
    ),
    data_rules: DATA_RULES,
  };
}

export async function getItem(id: string, lang: Locale) {
  if (!UUID.test(id)) throw new ApiError(404, "Item not found");
  const { data, error } = await db()
    .from("public_stock")
    .select(
      "item_id, item_name, ean, brand, shop_id, shop_slug, shop_name, shop_address, shop_city, shop_country, shop_timezone, shop_lat, shop_lng, price, currency, quantity, availability, is_available, freshness_state, freshness_age_minutes, latest_file_time, updated_at, item_name_lang, item_name_i18n",
    )
    .eq("item_id", id)
    .maybeSingle();
  if (error) throw new ApiError(500, error.message);
  if (!data) throw new ApiError(404, "Item not found");
  const sites = await liveSites();
  const item = apiItem({ ...(data as StockRow), distance_km: null }, lang, sites);

  // Same product (EAN) in other shops, nearest to this shop first.
  let also_available_at: ReturnType<typeof apiItem>[] = [];
  if (item.ean) {
    const others = await db().rpc("search_stock", {
      q: item.ean,
      lat: item.shop.lat,
      lng: item.shop.lng,
      radius_km: 500,
      only_available: false,
    });
    also_available_at = ((others.data ?? []) as StockRow[])
      .filter((r) => r.ean === item.ean && r.item_id !== item.id)
      .slice(0, 20)
      .map((r) => apiItem(r, lang, sites));
  }
  return { item, also_available_at, data_rules: DATA_RULES };
}
