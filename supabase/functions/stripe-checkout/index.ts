/// <reference lib="deno.ns" />
// PPI · stripe-checkout Edge Function
//
// Opens Stripe for a shop owner and returns its address ({url}):
//   - action "checkout": the payment page (Stripe Checkout) for the shop's monthly paid
//     plan, price STRIPE_PRICE_PRO. Automatic tax (Stripe Tax); the company name
//     (required), the VAT number (optional, checked by Stripe) and the company ID
//     (optional, pre-filled from the shop details) are collected for the invoices.
//   - action "portal": the Stripe customer portal (cancel, change card, invoices). A shop
//     whose subscription is still live always gets the portal, never a second checkout.
// Called by the dashboard (server action) with the owner's own login; only the shop's
// owners get an answer (is_shop_member). The website never sees a Stripe key, and this
// function never writes the paid state: only stripe-webhook does, after Stripe's signed
// event. It only remembers the shop's Stripe customer (link_stripe_customer).
//
// Deploy: Supabase → Edge Functions → Deploy a new function → Via Editor →
// name "stripe-checkout" → paste this file → Deploy, then switch OFF "Verify JWT"
// (this function checks its callers itself). Secrets: STRIPE_SECRET_KEY, STRIPE_PRICE_PRO.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

/** The Stripe API version these calls are written for. */
export const STRIPE_VERSION = "2026-09-30.endive";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LANGS = ["sk", "hu", "en"] as const;
type Lang = (typeof LANGS)[number];
/** Subscriptions that still bill (or can come back): managed in the portal. */
const LIVE = ["trialing", "active", "past_due", "unpaid", "paused"];

// ---------------------------------------------------------------- Stripe API

type Value = string | number | boolean | null | undefined | Params | Value[];
export interface Params {
  [key: string]: Value;
}

/** Stripe's form encoding: {a: {b: [{c: 1}]}} → "a[b][0][c]=1". Empty values are left out. */
export function toForm(params: Params): URLSearchParams {
  const form = new URLSearchParams();
  const add = (name: string, value: Value) => {
    if (value === null || value === undefined || value === "") return;
    if (Array.isArray(value)) value.forEach((item, i) => add(`${name}[${i}]`, item));
    else if (typeof value === "object") for (const [key, inner] of Object.entries(value)) add(`${name}[${key}]`, inner);
    else form.append(name, String(value));
  };
  for (const [key, value] of Object.entries(params)) add(key, value);
  return form;
}

export type Stripe = <T>(method: "GET" | "POST", path: string, params?: Params, idempotencyKey?: string) => Promise<T>;

export function stripeApi(secretKey: string, fetchImpl: typeof fetch = fetch, base = "https://api.stripe.com"): Stripe {
  return async <T>(method: "GET" | "POST", path: string, params: Params = {}, idempotencyKey?: string) => {
    const form = toForm(params).toString();
    const headers: Record<string, string> = { Authorization: `Bearer ${secretKey}`, "Stripe-Version": STRIPE_VERSION };
    if (method === "POST") headers["Content-Type"] = "application/x-www-form-urlencoded";
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    const response = await fetchImpl(`${base}/v1${path}${method === "GET" && form ? `?${form}` : ""}`, {
      method,
      headers,
      body: method === "POST" ? form : undefined,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Stripe ${response.status}: ${data?.error?.message ?? response.statusText}`);
    return data as T;
  };
}

// ---------------------------------------------------------------- the request

/** Back only to a PPI dashboard page: https (http only on this computer), path /{lang}/dashboard. */
export function returnUrl(value: unknown): URL | null {
  try {
    const url = new URL(String(value));
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return null;
    if (url.username || url.password || !/^\/(sk|hu|en)\/dashboard$/.test(url.pathname)) return null;
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

function withPlan(back: URL, outcome: "done" | "canceled"): string {
  const url = new URL(back);
  url.searchParams.set("plan", outcome);
  url.hash = "plan";
  return url.toString();
}

/** The label of the company ID field (from the website's texts), up to 100 characters. */
function cleanLabel(value: unknown): string {
  const label = typeof value === "string" ? value.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 100) : "";
  return label || "Company ID";
}

/** Everything the payment page needs: price, tax, company details for the invoice, way back. */
export function checkoutParams(o: {
  customer: string;
  priceId: string;
  shopId: string;
  lang: Lang;
  back: URL;
  companyIdLabel: string;
  companyId: string;
}): Params {
  return {
    mode: "subscription",
    customer: o.customer,
    // Checkout saves the company name and billing address onto the customer: they appear
    // on every invoice. Both are required by Stripe for tax ID collection and automatic tax.
    customer_update: { name: "auto", address: "auto" },
    line_items: [{ price: o.priceId, quantity: 1 }],
    client_reference_id: o.shopId,
    metadata: { shop_id: o.shopId },
    subscription_data: { metadata: { shop_id: o.shopId } },
    automatic_tax: { enabled: true },
    tax_id_collection: { enabled: true },
    name_collection: { business: { enabled: true } },
    billing_address_collection: "required",
    custom_fields: [
      {
        key: "companyid",
        label: { type: "custom", custom: o.companyIdLabel },
        type: "text",
        optional: true,
        text: { maximum_length: 40, default_value: o.companyId || undefined },
      },
    ],
    locale: o.lang,
    success_url: withPlan(o.back, "done"),
    cancel_url: withPlan(o.back, "canceled"),
  };
}

export interface Deps {
  /** The caller's own login: is_shop_member() and RLS decide what it may read. */
  asCaller: SupabaseClient;
  /** Service role: only for link_stripe_customer(). */
  db: SupabaseClient;
  stripe: Stripe;
  priceId: string;
}

interface SubscriptionRow {
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  status: string;
}

/**
 * POST {shop_id, action: "checkout" | "portal", lang, return_url, company_id_label}
 * with the owner's login → {url, kind}.
 */
export async function openStripe(req: Request, deps: Deps): Promise<Response> {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const { data: auth } = token ? await deps.asCaller.auth.getUser(token) : { data: null };
  const user = auth?.user;
  if (!user) return reply(401, { error: "login", message: "Log in again" });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return reply(400, { error: "bad_request", message: "JSON body expected" });
  }
  const shopId = String(body?.shop_id ?? "");
  const action = body?.action === "checkout" || body?.action === "portal" ? body.action : null;
  const lang: Lang = LANGS.find((l) => l === body?.lang) ?? "en";
  const back = returnUrl(body?.return_url);
  if (!UUID.test(shopId) || !action || !back) {
    return reply(400, { error: "bad_request", message: "shop_id, action and return_url are required" });
  }

  const { data: member } = await deps.asCaller.rpc("is_shop_member", { p_shop_id: shopId });
  if (member !== true) return reply(403, { error: "not_member", message: "Only this shop's owners can manage its plan" });

  const [{ data: shop }, { data: row, error: rowError }] = await Promise.all([
    deps.asCaller.from("shops").select("id, name, ico").eq("id", shopId).maybeSingle(),
    deps.asCaller
      .from("subscriptions")
      .select("stripe_customer_id, stripe_subscription_id, status")
      .eq("shop_id", shopId)
      .maybeSingle(),
  ]);
  if (rowError) return reply(500, { error: "database", message: rowError.message });
  if (!shop) return reply(404, { error: "not_found", message: "Shop not found" });
  const sub = row as SubscriptionRow | null;

  try {
    if (action === "portal" || (sub && LIVE.includes(sub.status))) {
      if (!sub?.stripe_customer_id || !sub.stripe_subscription_id) {
        return reply(409, { error: "no_subscription", message: "This shop has no subscription yet" });
      }
      const portal = await deps.stripe<{ url: string }>("POST", "/billing_portal/sessions", {
        customer: sub.stripe_customer_id,
        return_url: back.toString(),
        locale: lang,
      });
      return reply(200, { url: portal.url, kind: "portal" });
    }

    const companyIdLabel = cleanLabel(body?.company_id_label);
    const companyId = String(shop.ico ?? "").trim().slice(0, 40);
    let customer = sub?.stripe_customer_id ?? null;
    if (!customer) {
      // One Stripe customer per shop, made before its first payment page so that the company
      // ID from the shop details is already on the first invoice. The idempotency key stops
      // a double click from making two.
      const created = await deps.stripe<{ id: string }>(
        "POST",
        "/customers",
        {
          email: user.email,
          name: shop.name,
          preferred_locales: [lang],
          metadata: { shop_id: shopId },
          invoice_settings: companyId
            ? { custom_fields: [{ name: companyIdLabel.slice(0, 40), value: companyId }] }
            : undefined,
        },
        `ppi-customer-${shopId}-${user.id}`,
      );
      const { data: linked, error } = await deps.db.rpc("link_stripe_customer", {
        p_shop_id: shopId,
        p_customer: created.id,
      });
      if (error || typeof linked !== "string") {
        return reply(500, { error: "database", message: error?.message ?? "Customer not saved" });
      }
      customer = linked;
    }

    const session = await deps.stripe<{ url: string }>(
      "POST",
      "/checkout/sessions",
      checkoutParams({ customer, priceId: deps.priceId, shopId, lang, back, companyIdLabel, companyId }),
    );
    return reply(200, { url: session.url, kind: "checkout" });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("stripe-checkout:", message);
    return reply(502, { error: "stripe", message });
  }
}

// ---------------------------------------------------------------- HTTP entry

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") return reply(405, { error: "method", message: "POST only" });

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) return reply(500, { error: "config", message: "Function is missing Supabase settings" });
  const secretKey = Deno.env.get("STRIPE_SECRET_KEY")?.trim();
  const priceId = Deno.env.get("STRIPE_PRICE_PRO")?.trim();
  if (!secretKey || !priceId) {
    return reply(503, { error: "not_configured", message: "Stripe is not set up yet (STRIPE_SECRET_KEY, STRIPE_PRICE_PRO)" });
  }

  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  const asCaller = createClient(url, anonKey, {
    ...options,
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const db = createClient(url, serviceKey, options);
  // STRIPE_API_BASE: only for local tests against a stand-in for Stripe.
  const stripe = stripeApi(secretKey, fetch, Deno.env.get("STRIPE_API_BASE") || undefined);
  return await openStripe(req, { asCaller, db, stripe, priceId });
}

if (!Deno.env.get("PPI_FUNCTION_TEST")) Deno.serve(handler);
