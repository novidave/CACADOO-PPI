import "server-only";
import { cookies } from "next/headers";
import { readCourierKey as readKey, signCourierKey as signKey } from "@/lib/courierKey";
import { createPublicClient } from "@/lib/supabase/public";

/**
 * The courier app (database update 75). A courier has no Cacaduu account: the SMS code on the shop's courier login
 * gives the phone a key (ckr_ + 64 hex, 30 days) kept only in this HttpOnly cookie, signed with SESSION_COOKIE_SECRET
 * when it is set; the database keeps the key's hash. Every call goes through food_courier_call (the one door: the key
 * checked every time, only the courier's own deliveries, 120 calls a minute).
 */

export const COURIER_COOKIE = "ppi_kur";
export const COURIER_COOKIE_DAYS = 30;

function secret(): string | null {
  const value = process.env.SESSION_COOKIE_SECRET?.trim();
  return value && value.length >= 32 ? value : null;
}

/** The cookie's value for a key ("key.signature" while SESSION_COOKIE_SECRET is set; `@/lib/courierKey`). */
export const signCourierKey = (key: string) => signKey(key, secret());

/** The key from this website's cookie, or null. */
export const readCourierKey = (value: string | undefined) => readKey(value, secret());

export async function courierKey(): Promise<string | null> {
  return readCourierKey((await cookies()).get(COURIER_COOKIE)?.value);
}

export type CourierPay = "qr" | "cash" | "card";

export interface CourierWhoami {
  courier: { id: string; name: string };
  shop: { slug: string; name: string; timezone: string; phone: string | null };
  perms: Record<CourierPay, boolean>;
  expires_at: string;
  cash_cents: number;
  open: number;
  delivered_today: number;
  qr_today_cents: number;
  card_today_cents: number;
}

export interface CourierOrder {
  id: string;
  number: number;
  status: "new" | "preparing" | "on_the_way" | "delivered" | "ready" | "picked_up" | "cancelled";
  name: string | null;
  phone: string | null;
  address: string | null;
  note: string | null;
  lat: number | null;
  lng: number | null;
  zone_name: string | null;
  ready_by: string;
  pay_method: CourierPay;
  paid: boolean;
  paid_at: string | null;
  cash_given_cents: number | null;
  change_cents: number | null;
  subtotal_cents: number;
  delivery_cents: number;
  total_cents: number;
  currency: string;
  delivered_at: string | null;
  lines: { name: string; qty: number; extras_text: string | null; line_cents: number }[];
  items: number;
  problem: string | null;
  timezone: string;
  shop_name: string;
  vs?: string;
  payee?: string;
  iban?: string | null;
  bic?: string | null;
  perms?: Record<CourierPay, boolean>;
}

export interface CourierDeliveries {
  open: CourierOrder[];
  done_today: { id: string; number: number; name: string | null; total_cents: number; pay_method: CourierPay; delivered_at: string }[];
  timezone: string;
}

/** One call through the door with this browser's key; error = the database's reason ("courier" = signed out). */
export async function courierCall<T>(fn: string, args: Record<string, unknown> = {}): Promise<{ data: T | null; error: string | null }> {
  const key = await courierKey();
  const client = createPublicClient();
  if (!key) return { data: null, error: "courier" };
  if (!client) return { data: null, error: "unavailable" };
  const { data, error } = await client.rpc("food_courier_call", { p_key: key, p_fn: fn, p_args: args });
  if (error) return { data: null, error: courierReason(error.message) };
  return { data: data as T, error: null };
}

/** The database's refusals the courier screens know; anything else is "failed". */
export const COURIER_REASONS = [
  "courier", "courier_expired", "no_plan", "too_many", "not_found", "step", "not_paid", "pay_method", "cash", "reason",
  "already_paid", "conflict",
] as const;

export function courierReason(message: string): string {
  const known = COURIER_REASONS.find((r) => r === message);
  if (known === "courier_expired") return "courier";
  return known ?? "failed";
}

/** The signed-in courier of this browser, or null. */
export async function courierWhoami(): Promise<CourierWhoami | null> {
  const { data } = await courierCall<CourierWhoami>("whoami");
  return data;
}

