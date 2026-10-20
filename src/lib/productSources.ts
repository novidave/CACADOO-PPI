import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { functionFailure } from "./functionError";
import { createPublicClient } from "./supabase/public";

/**
 * Layers 3 and 4 of the main chat's search (Prompt 11): shops nearby and the web, asked through
 * the product-sources Edge Function — it holds the caches, the daily limit, the switches and the
 * outside keys. The website proves itself with EXTERNAL_SEARCH_SECRET (a server variable, never
 * in the browser). Only the product and the town go out.
 */

function secret(): string | null {
  const value = process.env.EXTERNAL_SEARCH_SECRET?.trim();
  return value && value.length >= 32 ? value : null;
}

/** On when EXTERNAL_SEARCH_SECRET (at least 32 characters) is set on the server. */
export function outsideSearchEnabled(): boolean {
  return secret() !== null;
}

export interface SourceTown {
  name: string;
  lat: number;
  lng: number;
  country: string | null;
  source: "nominatim" | "cacaduu";
}

export interface OsmShop {
  id: string;
  name: string;
  category: string;
  lat: number;
  lng: number;
  street: string | null;
  housenumber: string | null;
  city: string | null;
  phone: string | null;
  opening_hours: string | null;
  distance_km: number;
}

export interface GoogleShop {
  id: string;
  name: string;
  address: string | null;
  lat: number;
  lng: number;
  maps_url: string | null;
  distance_km: number;
}

export interface NearbyAnswer {
  status: "ok" | "off" | "limit" | "not_found" | "busy" | "unavailable" | "error";
  town: SourceTown | null;
  osm: { status: string; shops: OsmShop[]; fetched_at: string | null; attribution: string } | null;
  google: { status: string; shops: GoogleShop[] } | null;
}

export interface WebAnswer {
  status: "ok" | "off" | "limit" | "error";
  town?: SourceTown | null;
  results?: { domain: string; label: string; title: string; url: string; price: string | null; page_age: string | null }[];
  deep_links?: { domain: string; label: string; url: string }[];
  searched_at?: string;
}

async function call<T>(body: Record<string, unknown>, signal: AbortSignal, timeoutMs: number): Promise<T | { status: "error" }> {
  const key = secret();
  const supabase = createPublicClient();
  if (!key || !supabase) return { status: "error" };
  try {
    const { data, error } = await supabase.functions.invoke<T>("product-sources", {
      body,
      headers: { "x-ppi-sources": key },
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    });
    if (!error && data) return data;
    const failure = await functionFailure(error);
    console.error(`ai-search: product-sources ${String(body.action)} failed (${failure.error ?? failure.detail})`);
  } catch (e) {
    if (!signal.aborted) console.error(`ai-search: product-sources ${String(body.action)} failed (${e instanceof Error ? e.message : String(e)})`);
  }
  return { status: "error" };
}

/** Layer 3: shops of these kinds around the centre of the town the shopper wrote. */
export function nearbyShops(args: { town: string; categories: string[]; lang: string }, signal: AbortSignal) {
  return call<NearbyAnswer>({ action: "nearby", ...args }, signal, 25_000);
}

/** Layer 4: the product on the admin's allowed shop websites, for a shopper in that town. */
export function webOffers(args: { query: string; town: string; lang: string }, signal: AbortSignal) {
  return call<WebAnswer>({ action: "web", ...args }, signal, 30_000);
}

/** The admin page: which switches of the function are on (never a key). */
export async function sourcesStatus(supabase: SupabaseClient) {
  try {
    const { data, error } = await supabase.functions.invoke<{ env: Record<string, unknown> }>("product-sources", { body: { action: "admin_status" } });
    return error || !data ? null : data.env;
  } catch {
    return null;
  }
}
