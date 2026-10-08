import "server-only";
import type { OpeningHours } from "./hours";
import type { FreshnessState } from "./stock";

/** One row of public.my_shops(): a shop of the logged-in owner. */
export interface MyShop {
  id: string;
  slug: string;
  name: string;
  ico: string | null;
  address: string | null;
  city: string | null;
  country: string | null;
  timezone: string;
  lat: number | null;
  lng: number | null;
  phone: string | null;
  website: string | null;
  opening_hours: OpeningHours | null;
  visibility_mode: "exact" | "in_stock" | "yes_no";
  low_stock_threshold: number;
  logo_url: string | null;
  is_active: boolean;
  has_toilet: boolean;
  has_douchette: boolean;
  has_card_terminal: boolean;
  field_mapping: Record<string, string | null> | null;
  mapping_status: "proposed" | "confirmed" | null;
  sample_rows: Record<string, unknown>[] | null;
  latest_file_time: string | null;
  last_error: string | null;
  freshness_state: FreshnessState;
  folder_seen_at: string | null;
  last_file_name: string | null;
}

export const MAPPING_FIELDS = ["source_code", "name", "ean", "brand", "quantity", "price", "currency"] as const;
export const REQUIRED_FIELDS: readonly string[] = ["source_code", "name", "quantity", "price"];
