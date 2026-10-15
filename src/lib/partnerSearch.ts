import "server-only";
import type { PartnerHit } from "./partners";
import { createPublicClient } from "./supabase/public";

/**
 * Layer 2 of the main chat's search: the partners' product feeds (database update 35), read with
 * the anon client like every public search. The database decides the order (never the affiliate
 * flag), what is fresh (48 hours) and which stores are in the shopper's town.
 */

/** Whether any enabled partner has rows (no partner → the chat skips the layer). False before update 35. */
export async function partnerLayerReady(): Promise<boolean> {
  const supabase = createPublicClient();
  if (!supabase) return false;
  try {
    const { data, error } = await supabase.rpc("partner_layer_ready");
    return !error && data === true;
  } catch {
    return false;
  }
}

/** The partners' products for a term; with a town the shopper wrote, the partner's stores there. */
export async function searchPartners(q: string, town: string | null, limit = 10): Promise<PartnerHit[] | null> {
  const supabase = createPublicClient();
  if (!supabase) return null;
  const { data, error } = await supabase.rpc("search_partner_products", { p_q: q, p_town: town, p_limit: limit });
  if (error) {
    console.error(`ai-search: partner search failed (${error.message})`);
    return null;
  }
  return ((data ?? []) as PartnerHit[]).map((hit) => ({
    ...hit,
    price: hit.price === null ? null : Number(hit.price),
    regular_price: hit.regular_price === null ? null : Number(hit.regular_price),
    stores: Array.isArray(hit.stores) ? hit.stores.map((s) => ({ ...s, quantity: s.quantity === null ? null : Number(s.quantity) })) : [],
  }));
}
