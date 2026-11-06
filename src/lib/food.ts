import "server-only";
import { type CartLine, townOf, type ZoneOption } from "./foodRules";
import { geocodeTown } from "./productSources";
import { createCachedPublicClient, createPublicClient } from "./supabase/public";

/**
 * "Objednávky jedla" (database update 73) on the website: everything is decided in SQL — food_state (on, accepting,
 * why not), food_menu (Sklad products, sold out), food_quote (the one price rule). The website only reads them; the
 * order itself goes through the bookings function (the SMS code + food_order_create). The AI never sees a name, a
 * phone number, an address or a code.
 */

export interface FoodState {
  enabled: boolean;
  accepting?: boolean;
  reason?: "off" | "paused" | "sms_quota" | "closed" | "cutoff" | null;
  last_order_at?: string | null;
  timezone?: string;
  pickup?: boolean;
  prep_minutes?: number;
  delivery?: boolean;
  delivery_minutes?: number;
  /** update 81: the one time rule (food_times): pickup = prep + delay, delivery = the estimate + delay */
  delay_minutes?: number;
  ready_pickup_min?: number;
  ready_delivery_min?: number;
  long_delay?: boolean;
  /** update 81: false = the shop takes no payment in Cacaduu ("Platíte pri prevzatí", no method) */
  payments?: boolean;
  pay?: { qr: boolean; cash: boolean; card: boolean };
  zones?: { name: string; fee_cents: number; minimum_cents: number }[];
  /** update 87: how many zones the shop has (0 = Donáška anywhere, no fee) and the customer's list in the owner's order */
  zones_count?: number;
  zone_list?: ZoneOption[];
  phone?: string | null;
  /** update 85: "Poznámka k platbe po objednaní" as the owner wrote it (null = the default line, "-" = none). */
  pay_note?: string | null;
}

export interface MenuItem {
  item_id: string;
  name: string;
  category: string | null;
  price_cents: number;
  sold_out: boolean;
}

export interface QuoteLine {
  position: number;
  item_id: string;
  name: string;
  qty: number;
  base_cents: number;
  extras: { item_id: string; name: string; unit_cents: number }[];
  extras_cents: number;
  unit_cents: number;
  line_cents: number;
}

export interface Quote {
  ok: boolean;
  orderable: boolean;
  problem: string | null;
  kind: "pickup" | "delivery";
  lines: QuoteLine[];
  refused: { item_id: string; name: string | null; reason: string; extra_of?: string }[];
  zone: { id: string; name: string; label?: string; kind?: ZoneOption["kind"]; fee_cents: number; minimum_cents: number } | null;
  zones_count?: number;
  subtotal_cents: number;
  delivery_cents: number;
  minimum_cents: number;
  total_cents: number;
  currency: string;
  ready_minutes: number;
  state: { accepting: boolean; reason: string | null; last_order_at: string | null; timezone: string };
}

function db() {
  const supabase = createPublicClient();
  if (!supabase) throw new Error("Supabase is not configured");
  return supabase;
}

/** Whether the shop takes food orders (off before database update 73). */
export async function foodState(slug: string): Promise<FoodState> {
  const { data, error } = await db().rpc("food_state", { p_slug: slug });
  if (error || !data) return { enabled: false };
  return data as FoodState;
}

/**
 * The owner's payment note in the page's language (update 85: kind food_pay_note, a preset of every translation run,
 * so also in the shop's own language). null = no translation to show (the panel shows the note as written); nothing
 * is asked for the default line or "-".
 */
export async function foodPayNote(slug: string, lang: string, raw: string | null | undefined): Promise<string | null> {
  const note = (raw ?? "").trim();
  if (!note || note === "-") return null;
  const db = createCachedPublicClient();
  if (!db) return null;
  const { data, error } = await db.rpc("shop_translations", { p_slug: slug, p_lang: lang, p_kinds: ["food_pay_note"], p_refs: null });
  if (error || !Array.isArray(data)) return null;
  const row = (data as { kind: string; text: string }[]).find((r) => r.kind === "food_pay_note");
  return row?.text ?? null;
}

export async function foodMenu(slug: string, q: string | null, limit = 60): Promise<MenuItem[]> {
  const { data, error } = await db().rpc("food_menu", { p_slug: slug, p_q: q, p_limit: limit });
  if (error || !data) return [];
  return ((data as { items?: MenuItem[] }).items ?? []) as MenuItem[];
}

/**
 * The price rule. `zone` (update 87): the zone the customer picked — null = none picked (refused with zones:
 * zone_required); the database checks it fits the address and charges only its fee.
 */
export async function foodQuote(
  slug: string,
  lines: CartLine[],
  kind: "pickup" | "delivery",
  address: string | null,
  place: { lat: number; lng: number } | null = null,
  zone: string | null = null,
): Promise<{ quote: Quote | null; error: string | null }> {
  const { data, error } = await db().rpc("food_quote", {
    p_slug: slug,
    p_lines: lines,
    p_kind: kind,
    p_address: address,
    p_lat: place?.lat ?? null,
    p_lng: place?.lng ?? null,
    p_zone: kind === "delivery" ? zone : null,
  });
  if (error) return { quote: null, error: error.message };
  return { quote: data as Quote, error: null };
}

/**
 * The quote with the address's place (update 87: for the zone the customer picked): only when that zone is a
 * kilometre zone and the database could not place the address, the town of the address is geocoded once (the search's
 * own Nominatim rule, cached). No zones, a town or a postcode zone: never geocoded. Returns the place to keep with the
 * order.
 */
export async function quoteWithPlace(slug: string, lines: CartLine[], kind: "pickup" | "delivery", address: string | null, zone: string | null = null) {
  const first = await foodQuote(slug, lines, kind, address, null, zone);
  if (kind !== "delivery" || !address || first.quote?.problem !== "zone_mismatch" || first.quote.zone?.kind !== "radius_km") {
    return { ...first, place: null };
  }
  const town = townOf(address);
  const place = town ? await geocodeTown(town).catch(() => null) : null;
  if (!place) return { ...first, place: null };
  const again = await foodQuote(slug, lines, kind, address, place, zone);
  return { ...again, place: again.quote?.orderable || again.quote?.problem !== "zone_mismatch" ? place : null };
}
