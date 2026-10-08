/// <reference lib="deno.ns" />
// PPI · stripe-webhook Edge Function
//
// Stripe calls this when a payment page is completed and whenever a subscription changes
// (renewal, failed payment, cancellation in the customer portal). It checks Stripe's
// signature, fetches the subscription fresh from Stripe (so the order in which events
// arrive does not matter) and writes it with apply_stripe_subscription(): the only place
// where a shop's paid state is written. Every paid feature then asks shop_has_plan().
// The company ID typed on the payment page goes onto the customer's later invoices.
//
// Deploy: Supabase → Edge Functions → Deploy a new function → Via Editor →
// name "stripe-webhook" → paste this file → Deploy, then switch OFF "Verify JWT" (Stripe
// signs its calls instead of logging in). Secrets: STRIPE_SECRET_KEY,
// STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_PRO. In Stripe: a webhook endpoint
// https://<project>.supabase.co/functions/v1/stripe-webhook with the events
// checkout.session.completed and customer.subscription.created / updated / deleted /
// paused / resumed.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

/** The Stripe API version these calls are written for. */
export const STRIPE_VERSION = "2026-09-30.endive";
/** Events older (or newer) than this are refused: a recorded call cannot be replayed later. */
const TOLERANCE_SECONDS = 300;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------- signature

function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Stripe's signature: header "t=<unix time>,v1=<hex>[,v1=…]", where v1 is the HMAC-SHA256
 * of "<t>.<raw body>" with the endpoint's signing secret (whsec_…).
 */
export async function verifySignature(
  payload: string,
  header: string | null,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!header || !secret) return false;
  let timestamp = Number.NaN;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.trim().split("=");
    if (key === "t") timestamp = Number.parseInt(value, 10);
    else if (key === "v1" && value) signatures.push(value);
  }
  if (!Number.isFinite(timestamp) || signatures.length === 0) return false;
  if (Math.abs(nowSeconds - timestamp) > TOLERANCE_SECONDS) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${payload}`)));
  const expected = Array.from(mac, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return signatures.some((signature) => sameText(signature, expected));
}

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

export type Stripe = <T>(method: "GET" | "POST", path: string, params?: Params) => Promise<T>;

export function stripeApi(secretKey: string, fetchImpl: typeof fetch = fetch, base = "https://api.stripe.com"): Stripe {
  return async <T>(method: "GET" | "POST", path: string, params: Params = {}) => {
    const form = toForm(params).toString();
    const headers: Record<string, string> = { Authorization: `Bearer ${secretKey}`, "Stripe-Version": STRIPE_VERSION };
    if (method === "POST") headers["Content-Type"] = "application/x-www-form-urlencoded";
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

// ---------------------------------------------------------------- events

type Ref = string | { id: string } | null | undefined;
const idOf = (ref: Ref) => (typeof ref === "string" ? ref : ref?.id ?? null);

interface CheckoutSession {
  mode?: string;
  subscription?: Ref;
  customer?: Ref;
  client_reference_id?: string | null;
  metadata?: Record<string, string> | null;
  custom_fields?: { key: string; label?: { custom?: string | null } | null; text?: { value?: string | null } | null }[];
}

interface Subscription {
  id: string;
  status: string;
  customer: Ref;
  metadata?: Record<string, string> | null;
  cancel_at?: number | null;
  cancel_at_period_end?: boolean;
  /** Older API versions only; newer ones keep the period on each item. */
  current_period_end?: number;
  items?: { data?: { current_period_end?: number; price?: { id: string; lookup_key?: string | null } | null }[] };
}

export interface StripeEvent {
  id: string;
  type: string;
  data?: { object?: Record<string, unknown> };
}

export interface Deps {
  /** Service role: reads the shop of a customer, writes through apply_stripe_subscription(). */
  db: SupabaseClient;
  stripe: Stripe;
  priceId: string;
}

const iso = (seconds: number | null | undefined) =>
  typeof seconds === "number" && Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;

/** The subscription as Stripe has it now → public.subscriptions. */
export async function syncSubscription(subscriptionId: string, shopHint: string | null, deps: Deps): Promise<string> {
  if (!/^sub_[A-Za-z0-9]+$/.test(subscriptionId)) return "ignored: no subscription";
  const sub = await deps.stripe<Subscription>("GET", `/subscriptions/${subscriptionId}`);
  const customer = idOf(sub.customer);
  let shopId = sub.metadata?.shop_id || shopHint;
  if (!shopId && customer) {
    const { data } = await deps.db.from("subscriptions").select("shop_id").eq("stripe_customer_id", customer).maybeSingle();
    shopId = (data as { shop_id: string } | null)?.shop_id ?? null;
  }
  if (!shopId || !UUID.test(shopId)) return `ignored: ${sub.id} belongs to no PPI shop`;

  const items = sub.items?.data ?? [];
  const ends = items.map((item) => item.current_period_end).filter((end): end is number => typeof end === "number");
  const periodEnd = ends.length > 0 ? Math.min(...ends) : sub.current_period_end ?? null;
  const price = items[0]?.price;
  const plan = !price ? null : price.id === deps.priceId ? "pro" : price.lookup_key || price.id;
  const cancelAt = sub.status === "canceled" ? null : sub.cancel_at ?? (sub.cancel_at_period_end ? periodEnd : null);

  const { data: written, error } = await deps.db.rpc("apply_stripe_subscription", {
    p_shop_id: shopId,
    p_customer: customer,
    p_subscription: sub.id,
    p_status: sub.status,
    p_plan: plan,
    p_current_period_end: iso(periodEnd),
    p_cancel_at: iso(cancelAt),
  });
  if (error) throw new Error(`apply_stripe_subscription: ${error.message}`);
  return written ? `saved ${sub.id} (${sub.status}) for shop ${shopId}` : `kept the shop's newer subscription, not ${sub.id}`;
}

/** The company ID typed on the payment page goes onto the customer's later invoices. */
async function saveCompanyId(session: CheckoutSession, deps: Deps) {
  const field = (session.custom_fields ?? []).find((f) => f.key === "companyid");
  const value = field?.text?.value?.trim().slice(0, 140);
  const customer = idOf(session.customer);
  if (!value || !customer) return;
  const name = (field?.label?.custom ?? "").trim().slice(0, 40) || "Company ID";
  await deps.stripe("POST", `/customers/${encodeURIComponent(customer)}`, {
    invoice_settings: { custom_fields: [{ name, value }] },
  });
}

export async function handleEvent(event: StripeEvent, deps: Deps): Promise<string> {
  const object = event.data?.object ?? {};
  switch (event.type) {
    case "checkout.session.completed": {
      const session = object as CheckoutSession;
      const subscription = idOf(session.subscription);
      if (session.mode !== "subscription" || !subscription) return "ignored: not a subscription";
      const outcome = await syncSubscription(subscription, session.client_reference_id || session.metadata?.shop_id || null, deps);
      // The plan is saved first; if this fails, Stripe sends the event again (saving twice is harmless).
      await saveCompanyId(session, deps);
      return outcome;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
    case "customer.subscription.paused":
    case "customer.subscription.resumed": {
      const sub = object as unknown as Subscription;
      return await syncSubscription(String(sub.id ?? ""), sub.metadata?.shop_id || null, deps);
    }
    default:
      return `ignored: ${event.type}`;
  }
}

export async function receiveEvent(req: Request, secret: string, deps: Deps): Promise<Response> {
  const payload = await req.text();
  if (!(await verifySignature(payload, req.headers.get("Stripe-Signature"), secret))) {
    return reply(400, { error: "Invalid Stripe signature" });
  }
  let event: StripeEvent;
  try {
    event = JSON.parse(payload);
  } catch {
    return reply(400, { error: "Invalid JSON" });
  }
  try {
    const outcome = await handleEvent(event, deps);
    console.log(`stripe-webhook ${event.type} ${event.id}: ${outcome}`);
    return reply(200, { received: true, outcome });
  } catch (e) {
    // Stripe tries again (for up to three days) when the answer is not 2xx.
    const message = e instanceof Error ? e.message : String(e);
    console.error(`stripe-webhook ${event.type} ${event.id} failed: ${message}`);
    return reply(500, { error: message });
  }
}

// ---------------------------------------------------------------- HTTP entry

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") return reply(405, { error: "POST only" });
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const secretKey = Deno.env.get("STRIPE_SECRET_KEY")?.trim();
  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET")?.trim();
  const priceId = Deno.env.get("STRIPE_PRICE_PRO")?.trim() ?? "";
  if (!url || !serviceKey) return reply(500, { error: "Function is missing Supabase settings" });
  if (!secretKey || !webhookSecret) return reply(503, { error: "Stripe is not set up yet (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET)" });

  const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  // STRIPE_API_BASE: only for local tests against a stand-in for Stripe.
  const stripe = stripeApi(secretKey, fetch, Deno.env.get("STRIPE_API_BASE") || undefined);
  return await receiveEvent(req, webhookSecret, { db, stripe, priceId });
}

if (!Deno.env.get("PPI_FUNCTION_TEST")) Deno.serve(handler);
