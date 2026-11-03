import "server-only";
import type { OrderKind, OrderStatus, PayMethod } from "@/lib/foodRules";

/**
 * "Objednávky jedla" for the owner (database updates 73–74): what the Asistent pages read. Every rule is in SQL
 * (owner_food_* — members read, writes also shop_has_plan); this file only names the shapes.
 */

export interface FoodTab {
  enabled: boolean;
  new: number;
  latest: string | null;
}

type Rpc = { rpc: (name: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }> };

/** The Objednávky tab of the Asistent row (null before update 74 or for a stranger: the tab is simply not shown). */
export async function foodTab(supabase: Rpc, shopId: string): Promise<FoodTab | null> {
  const { data, error } = await supabase.rpc("owner_food_tab", { p_shop_id: shopId });
  if (error || !data) return null;
  const d = data as Partial<FoodTab>;
  return { enabled: Boolean(d.enabled), new: Number(d.new) || 0, latest: d.latest ?? null };
}

export interface FoodLine {
  id: string;
  item_id: string;
  name: string;
  qty: number;
  base_cents: number;
  extras_text: string | null;
  extras_cents: number;
  line_cents: number;
}

export interface FoodEvent {
  actor: "customer" | "owner" | "courier" | "system";
  kind: "status" | "paid" | "assigned" | "problem";
  from: OrderStatus | null;
  to: OrderStatus | null;
  detail: string | null;
  at: string;
}

export interface FoodOrder {
  id: string;
  number: number;
  kind: OrderKind;
  status: OrderStatus;
  pay_method: PayMethod;
  paid_at: string | null;
  cash_given_cents: number | null;
  change_cents: number | null;
  name: string | null;
  phone: string | null;
  address: string | null;
  note: string | null;
  zone_name: string | null;
  ready_by: string;
  subtotal_cents: number;
  delivery_cents: number;
  total_cents: number;
  currency: string;
  vs: string;
  created_at: string;
  delivered_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  stock_taken: boolean;
  contact_id: string | null;
  conversation_id: string | null;
  verified: boolean;
  /** update 75: the courier (name) and the latest "Problém s donáškou" not followed by a status step */
  courier_id?: string | null;
  courier_name?: string | null;
  problem?: string | null;
  lines: FoodLine[];
  events?: FoodEvent[];
  timezone: string;
  shop_name: string;
  payee?: string;
  iban?: string | null;
  bic?: string | null;
  sms_on_the_way?: boolean;
}

export interface OpenState {
  accepting: boolean;
  reason: "off" | "paused" | "sms_quota" | "closed" | "cutoff" | null;
  closes_at?: string | null;
  last_order_at?: string | null;
}

export interface FoodOrders {
  orders: FoodOrder[];
  counts: { new: number; preparing: number; on_the_way: number; done: number };
  totals: { count: number; total_cents: number; qr_cents: number; cash_cents: number; card_cents: number; qr: number; cash: number; card: number };
  state: OpenState;
  settings: {
    enabled: boolean;
    paused: boolean;
    pickup_on: boolean;
    prep_minutes: number;
    delivery_on: boolean;
    delivery_minutes: number;
    alert_sound: boolean;
    sms_on_the_way: boolean;
  } | null;
  timezone: string;
}

export interface FoodZone {
  id: string;
  name: string;
  kind: "town" | "postcode" | "radius_km";
  value: string;
  fee_cents: number;
  minimum_cents: number;
  sort: number;
}

export interface MenuCheck {
  checked_at: string;
  document_id: string;
  document: string;
  names: number;
  paired: number;
  missing: string[];
}

export interface FoodSettings {
  enabled: boolean;
  paused: boolean;
  pickup_on: boolean;
  prep_minutes: number;
  delivery_on: boolean;
  delivery_minutes: number;
  pay_qr: boolean;
  pay_cash: boolean;
  pay_card: boolean;
  last_order_minutes: number;
  deduct_on_delivery: boolean;
  alert_sound: boolean;
  alert_email: boolean;
  alert_telegram: boolean;
  sms_on_the_way: boolean;
  menu_check: MenuCheck | null;
  has_plan: boolean;
  state: OpenState;
  zones: FoodZone[];
  sklad_source: boolean;
  menu_items: number;
  menu_categories: string[];
  iban_set: boolean;
  sms: { order?: { used: number; limit: number } };
}
