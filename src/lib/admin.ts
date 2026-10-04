import "server-only";
import type { OpeningHours } from "./hours";
import { openingStatus } from "./hours";
import type { FreshnessState } from "./stock";

/** One row of public.admin_shops(). */
export interface AdminShop {
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
  created_at: string;
  file_format: string | null;
  file_url: string | null;
  field_mapping: Record<string, unknown> | null;
  mapping_status: "proposed" | "confirmed" | null;
  sample_rows: Record<string, unknown>[] | null;
  latest_file_time: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  freshness_state: FreshnessState;
  freshness_age_minutes: number | null;
  item_count: number;
  owner_count: number;
  has_toilet: boolean;
  has_douchette: boolean;
  has_card_terminal: boolean;
}

/** PRD 8.6: an active shop with no new file for over 1 hour while it is open. */
export function needsAttention(shop: AdminShop, now = new Date()): boolean {
  if (!shop.is_active) return false;
  const quiet = shop.freshness_age_minutes === null || shop.freshness_age_minutes > 60;
  return quiet && openingStatus(shop.opening_hours, shop.timezone, now)?.open === true;
}
