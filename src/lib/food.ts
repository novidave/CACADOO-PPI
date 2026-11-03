import "server-only";
import { type CartLine, townOf } from "./foodRules";
import { geocodeTown } from "./productSources";
import { createPublicClient } from "./supabase/public";

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
  pay?: { qr: boolean; cash: boolean; card: boolean };
  zones?: { name: string; fee_cents: number; minimum_cents: number }[];
  phone?: string | null;
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
  zone: { id: string; name: string; fee_cents: number; minimum_cents: number } | null;
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

export async function foodMenu(slug: string, q: string | null, limit = 60): Promise<MenuItem[]> {
  const { data, error } = await db().rpc("food_menu", { p_slug: slug, p_q: q, p_limit: limit });
  if (error || !data) return [];
  return ((data as { items?: MenuItem[] }).items ?? []) as MenuItem[];
}

export async function foodQuote(
  slug: string,
  lines: CartLine[],
  kind: "pickup" | "delivery",
  address: string | null,
  place: { lat: number; lng: number } | null = null,
): Promise<{ quote: Quote | null; error: string | null }> {
  const { data, error } = await db().rpc("food_quote", {
    p_slug: slug,
    p_lines: lines,
    p_kind: kind,
    p_address: address,
    p_lat: place?.lat ?? null,
    p_lng: place?.lng ?? null,
  });
  if (error) return { quote: null, error: error.message };
  return { quote: data as Quote, error: null };
}

/**
 * The quote with the address's place: when no town or postcode zone matched, the town of the address is geocoded once
 * (the search's own Nominatim rule, cached) for the shop's kilometre zones. Returns the place to keep with the order.
 */
export async function quoteWithPlace(slug: string, lines: CartLine[], kind: "pickup" | "delivery", address: string | null) {
  const first = await foodQuote(slug, lines, kind, address);
  if (kind !== "delivery" || !address || first.quote?.problem !== "outside_zone") return { ...first, place: null };
  const town = townOf(address);
  const place = town ? await geocodeTown(town).catch(() => null) : null;
  if (!place) return { ...first, place: null };
  const again = await foodQuote(slug, lines, kind, address, place);
  return { ...again, place: again.quote?.zone ? place : null };
}
