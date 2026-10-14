import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { functionFailure } from "./functionError";

/**
 * Custom domains (database update 25): what the page "Predplatné a doména" reads with the
 * owner's own login (RLS: the shop's own rows), and the calls to the domains Edge Function,
 * which does everything that moves an order (Websupport, Vercel, Stripe).
 */

/** A shop's open domain (one at a time). */
export const OPEN_STATUSES = ["checkout", "paid", "registering", "configuring", "securing", "live", "waiting_dns", "verified"];
/** The steps of a bought domain, in order (the progress screen). */
export const BOUGHT_STEPS = ["paid", "registering", "configuring", "securing", "live"] as const;

export interface DnsWant {
  type: string;
  name: string;
  value: string;
}

export interface DomainOrder {
  id: string;
  kind: "bought" | "connected";
  hostname: string;
  site_host: string | null;
  www: boolean;
  status: string;
  price_cents: number | null;
  renewal_cents: number | null;
  vat_included: boolean | null;
  currency: string;
  test_mode: boolean;
  quoted_at: string | null;
  paid_at: string | null;
  refunded_at: string | null;
  invoice_url: string | null;
  registrar_service_id: string | null;
  dns_records: DnsWant[] | null;
  last_check_at: string | null;
  next_check_at: string | null;
  live_at: string | null;
  live_email_at: string | null;
  expires_at: string | null;
  renewal_state: "none" | "due" | "paid" | "failed";
  renewal_invoice_url: string | null;
  auth_code: string | null;
  needs_admin: boolean;
  last_error: string | null;
  created_at: string;
}

export const DOMAIN_COLUMNS =
  "id, kind, hostname, site_host, www, status, price_cents, renewal_cents, vat_included, currency, test_mode, quoted_at, " +
  "paid_at, refunded_at, invoice_url, registrar_service_id, dns_records, last_check_at, next_check_at, live_at, " +
  "live_email_at, expires_at, renewal_state, renewal_invoice_url, auth_code, needs_admin, last_error, created_at";

export interface DomainPrice {
  tld: string;
  price_cents: number;
  renewal_cents: number;
  vat_included: boolean;
  sort_order: number;
}

export interface OwnerDetails {
  company_name: string | null;
  contact_name: string | null;
  street: string | null;
  city: string | null;
  zip: string | null;
  country: string | null;
  ico: string | null;
  dic: string | null;
  ic_dph: string | null;
  email: string | null;
  phone: string | null;
  missing: string[];
}

export const OWNER_FIELDS = [
  "company_name", "contact_name", "street", "city", "zip", "country", "ico", "dic", "ic_dph", "email", "phone",
] as const;

/** How the domains function logs details Websupport refused (followed by our field names, e.g. "ico, country"). */
export const OWNER_REFUSED = "Owner details refused by Websupport: ";

/** The owner's fields Websupport refused for this order, while it waits for the correction. */
export function refusedFields(o: DomainOrder | null): string[] {
  if (!o || o.status !== "registering" || !o.needs_admin || !o.last_error?.startsWith(OWNER_REFUSED)) return [];
  const list = o.last_error.slice(OWNER_REFUSED.length).split(" (")[0];
  return list.split(",").map((f) => f.trim()).filter((f) => (OWNER_FIELDS as readonly string[]).includes(f));
}

export interface DomainPageData {
  /** The open domain, else the latest one that ended (for its notice and transfer code). */
  current: DomainOrder | null;
  /** The name checked in step 2 (price frozen), still to be paid. */
  quote: DomainOrder | null;
  prices: DomainPrice[];
  settings: { search_url: string; same_price_as_registrar: boolean };
  owner: OwnerDetails | null;
}

/** Everything the page needs; null before database update 25. */
export async function loadDomainPage(supabase: SupabaseClient, shopId: string): Promise<DomainPageData | null> {
  const [orders, prices, settings, owner] = await Promise.all([
    supabase.from("domain_orders").select(DOMAIN_COLUMNS).eq("shop_id", shopId).order("created_at", { ascending: false }).limit(10),
    supabase.from("domain_prices").select("tld, price_cents, renewal_cents, vat_included, sort_order").eq("active", true),
    supabase.rpc("domain_shop_settings"),
    supabase.rpc("domain_owner_details", { p_shop_id: shopId }),
  ]);
  if (orders.error || prices.error) return null;
  const rows = (orders.data ?? []) as unknown as DomainOrder[];
  const open = rows.find((o) => OPEN_STATUSES.includes(o.status)) ?? null;
  const ended = rows.find((o) => !OPEN_STATUSES.includes(o.status) && o.status !== "quoted" && o.status !== "canceled") ?? null;
  const quote = rows.find((o) => o.status === "quoted" && o.quoted_at && Date.now() - Date.parse(o.quoted_at) < 86_400_000) ?? null;
  const priceRows = ((prices.data ?? []) as DomainPrice[]).sort(
    (a, b) => Number(b.tld === "sk") - Number(a.tld === "sk") || a.sort_order - b.sort_order || a.tld.localeCompare(b.tld),
  );
  const s = ((settings.data ?? []) as { search_url: string; same_price_as_registrar: boolean }[])[0];
  return {
    current: open ?? ended,
    quote: open ? null : quote,
    prices: priceRows,
    settings: s ?? { search_url: "https://www.websupport.sk", same_price_as_registrar: false },
    owner: (owner.data as OwnerDetails | null) ?? null,
  };
}

/** "Aby vás našli Google a AI asistenti" on a live domain (database update 33). */
export interface Findable {
  google_verification: string | null;
  google_verification_state: "added" | "manual" | null;
  google_verification_at: string | null;
  indexnow_at: string | null;
  indexnow_urls: number | null;
  indexnow_result: string | null;
  categories: string[];
}

/** The Search Console value, the last IndexNow ping and the categories; null before update 33. */
export async function loadFindable(supabase: SupabaseClient, orderId: string, shopId: string): Promise<Findable | null> {
  const [order, shop] = await Promise.all([
    supabase
      .from("domain_orders")
      .select("google_verification, google_verification_state, google_verification_at, indexnow_at, indexnow_urls, indexnow_result")
      .eq("id", orderId)
      .maybeSingle(),
    supabase.from("shops").select("product_categories").eq("id", shopId).maybeSingle(),
  ]);
  if (order.error || shop.error || !order.data) return null;
  return { ...(order.data as Omit<Findable, "categories">), categories: ((shop.data?.product_categories as string[] | null) ?? []) };
}

/** The domains Edge Function with the caller's own login: its answer, or its reason code. */
export async function callDomains<T>(
  supabase: SupabaseClient,
  body: Record<string, unknown>,
): Promise<{ data: T | null; error: string | null; status: number | null; message: string | null }> {
  const { data, error } = await supabase.functions.invoke<T>("domains", { body });
  if (!error) return { data: data ?? null, error: null, status: 200, message: null };
  const failure = await functionFailure(error);
  if (!failure.error) console.error(`domains: ${String(body.action)} failed (${failure.detail})`);
  return {
    data: null,
    error: failure.error ?? (failure.platform ? `fn_${failure.platform}` : "failed"),
    status: failure.status,
    // Stripe's or Websupport's own reason (never a key), or Supabase's when it refused the call.
    message: failure.message,
  };
}

/** "19,90 €" in the page language. */
export function euros(cents: number | null | undefined, lang: string, currency = "EUR"): string {
  if (cents === null || cents === undefined) return "";
  return new Intl.NumberFormat(lang, { style: "currency", currency }).format(cents / 100);
}
