// Unit tests of the Stripe webhook: signature check, and what each event writes.
// Run: npm run test:functions
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { handleEvent, receiveEvent, type Stripe, verifySignature } from "./index.ts";

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}\n  expected ${b}\n  got      ${a}`);
}

const SECRET = "whsec_ppi_test_secret";
const SHOP = "11111111-2222-4333-8444-555555555555";
const PAYLOAD = '{"id":"evt_test","object":"event","type":"customer.subscription.updated"}';
// HMAC-SHA256 of "1760000000.<PAYLOAD>" with SECRET, made with openssl (not with this code).
const OPENSSL_SIGNATURE = "803f78df8dfe0c3ebc8241217062e31e57076665d1b9202ac92bcea3d7b562bd";

async function sign(payload: string, secret = SECRET, t = Math.floor(Date.now() / 1000)) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`)));
  return `t=${t},v1=${Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

Deno.test("Stripe's signature is accepted; anything else is refused", async () => {
  const header = `t=1760000000,v1=${OPENSSL_SIGNATURE}`;
  eq(await verifySignature(PAYLOAD, header, SECRET, 1760000000), true, "signature made by openssl");
  eq(await verifySignature(PAYLOAD, `t=1760000000,v1=${"0".repeat(64)},v1=${OPENSSL_SIGNATURE}`, SECRET, 1760000060), true,
    "one of several signatures (secret being rolled)");
  eq(await verifySignature(PAYLOAD, header, "whsec_other", 1760000000), false, "wrong secret");
  eq(await verifySignature(PAYLOAD.replace("updated", "deleted"), header, SECRET, 1760000000), false, "changed body");
  eq(await verifySignature(PAYLOAD, header, SECRET, 1760000000 + 301), false, "older than 5 minutes");
  eq(await verifySignature(PAYLOAD, header, SECRET, 1760000000 - 301), false, "from the future");
  eq(await verifySignature(PAYLOAD, `t=1760000000,v0=${OPENSSL_SIGNATURE}`, SECRET, 1760000000), false, "only v1 counts");
  eq(await verifySignature(PAYLOAD, null, SECRET, 1760000000), false, "no header");
  eq(await verifySignature(PAYLOAD, header, "", 1760000000), false, "no secret set");
});

/** A Stripe stand-in: answers GET /subscriptions/… and records every call. */
function fakeStripe(subscription: Record<string, unknown>) {
  const calls: { method: string; path: string; params?: unknown }[] = [];
  const stripe = (<T>(method: string, path: string, params?: unknown) => {
    calls.push({ method, path, params });
    if (method === "GET" && path.startsWith("/subscriptions/")) return Promise.resolve(subscription as T);
    return Promise.resolve({ id: "cus_1" } as T);
  }) as Stripe;
  return { stripe, calls };
}

/** Just enough of the Supabase client; records apply_stripe_subscription(). */
function fakeDb(options: { written?: boolean; error?: string; customerShop?: string | null } = {}) {
  const writes: Record<string, unknown>[] = [];
  const db = {
    rpc: (name: string, args: Record<string, unknown>) => {
      writes.push({ name, ...args });
      return Promise.resolve(options.error ? { data: null, error: { message: options.error } } : { data: options.written ?? true, error: null });
    },
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: () => Promise.resolve({ data: options.customerShop ? { shop_id: options.customerShop } : null }) }),
      }),
    }),
  };
  return { db: db as unknown as SupabaseClient, writes };
}

const PERIOD_END = 1762600000; // 2025-11-08T11:06:40Z
const activeSub = (extra: Record<string, unknown> = {}) => ({
  id: "sub_1",
  status: "active",
  customer: "cus_1",
  metadata: { shop_id: SHOP },
  cancel_at: null,
  cancel_at_period_end: false,
  items: { data: [{ current_period_end: PERIOD_END, price: { id: "price_pro", lookup_key: null } }] },
  ...extra,
});

Deno.test("payment page completed: company ID onto the invoices, subscription written", async () => {
  const { stripe, calls } = fakeStripe(activeSub());
  const { db, writes } = fakeDb();
  const outcome = await handleEvent({
    id: "evt_1",
    type: "checkout.session.completed",
    data: {
      object: {
        mode: "subscription",
        subscription: "sub_1",
        customer: "cus_1",
        client_reference_id: SHOP,
        custom_fields: [{ key: "companyid", label: { custom: "IČO" }, text: { value: " 12345678 " } }],
      },
    },
  }, { db, stripe, priceId: "price_pro" });
  eq(calls.map((c) => `${c.method} ${c.path}`), ["GET /subscriptions/sub_1", "POST /customers/cus_1"], "Stripe calls: plan first");
  eq(calls[1].params, { invoice_settings: { custom_fields: [{ name: "IČO", value: "12345678" }] } }, "company ID on the invoices");
  eq(writes, [{
    name: "apply_stripe_subscription",
    p_shop_id: SHOP,
    p_customer: "cus_1",
    p_subscription: "sub_1",
    p_status: "active",
    p_plan: "pro",
    p_current_period_end: "2025-11-08T11:06:40.000Z",
    p_cancel_at: null,
  }], "subscription written");
  eq(outcome, `saved sub_1 (active) for shop ${SHOP}`, "outcome");
});

Deno.test("cancelled in the portal: the end date is kept; deleted: canceled", async () => {
  for (const [sub, status, cancelAt] of [
    [activeSub({ cancel_at_period_end: true }), "active", "2025-11-08T11:06:40.000Z"],
    [activeSub({ cancel_at: PERIOD_END - 86400 }), "active", "2025-11-07T11:06:40.000Z"],
    [activeSub({ status: "canceled", cancel_at: PERIOD_END }), "canceled", null],
    [activeSub({ status: "past_due" }), "past_due", null],
  ] as const) {
    const { stripe } = fakeStripe(sub);
    const { db, writes } = fakeDb();
    await handleEvent({ id: "evt", type: "customer.subscription.updated", data: { object: { id: "sub_1", metadata: { shop_id: SHOP } } } },
      { db, stripe, priceId: "price_pro" });
    eq([writes[0].p_status, writes[0].p_cancel_at], [status, cancelAt], `status ${status}`);
  }
});

Deno.test("older API versions: the period end on the subscription itself", async () => {
  const { stripe } = fakeStripe(activeSub({ current_period_end: PERIOD_END, items: { data: [{ price: { id: "price_other", lookup_key: "pro_yearly" } }] } }));
  const { db, writes } = fakeDb();
  await handleEvent({ id: "evt", type: "customer.subscription.created", data: { object: { id: "sub_1" } } }, { db, stripe, priceId: "price_pro" });
  eq([writes[0].p_current_period_end, writes[0].p_plan], ["2025-11-08T11:06:40.000Z", "pro_yearly"], "period end and plan");
});

Deno.test("a subscription without shop_id is found by its customer, or ignored", async () => {
  const noShop = activeSub({ metadata: {} });
  const found = fakeDb({ customerShop: SHOP });
  await handleEvent({ id: "evt", type: "customer.subscription.updated", data: { object: { id: "sub_1" } } },
    { db: found.db, stripe: fakeStripe(noShop).stripe, priceId: "price_pro" });
  eq(found.writes[0]?.p_shop_id, SHOP, "shop of the customer");

  const unknown = fakeDb();
  const outcome = await handleEvent({ id: "evt", type: "customer.subscription.updated", data: { object: { id: "sub_1" } } },
    { db: unknown.db, stripe: fakeStripe(noShop).stripe, priceId: "price_pro" });
  eq([unknown.writes.length, outcome], [0, "ignored: sub_1 belongs to no PPI shop"], "nothing written");
});

Deno.test("other events and one-off payments are ignored", async () => {
  const { stripe, calls } = fakeStripe(activeSub());
  const { db, writes } = fakeDb();
  eq(await handleEvent({ id: "e1", type: "invoice.paid", data: { object: {} } }, { db, stripe, priceId: "p" }), "ignored: invoice.paid", "invoice");
  eq(await handleEvent({ id: "e2", type: "checkout.session.completed", data: { object: { mode: "payment" } } }, { db, stripe, priceId: "p" }),
    "ignored: not a subscription", "payment mode");
  eq([calls.length, writes.length], [0, 0], "no calls, no writes");
});

Deno.test("receiveEvent: bad signature 400 and nothing written; database error 500 so Stripe tries again", async () => {
  const body = JSON.stringify({ id: "evt_9", type: "customer.subscription.updated", data: { object: { id: "sub_1", metadata: { shop_id: SHOP } } } });
  const forged = fakeDb();
  const r1 = await receiveEvent(new Request("http://x", { method: "POST", body, headers: { "Stripe-Signature": await sign(body, "whsec_wrong") } }),
    SECRET, { db: forged.db, stripe: fakeStripe(activeSub()).stripe, priceId: "price_pro" });
  eq([r1.status, forged.writes.length], [400, 0], "forged event refused");

  const ok = fakeDb();
  const r2 = await receiveEvent(new Request("http://x", { method: "POST", body, headers: { "Stripe-Signature": await sign(body) } }),
    SECRET, { db: ok.db, stripe: fakeStripe(activeSub()).stripe, priceId: "price_pro" });
  eq([r2.status, ok.writes.length], [200, 1], "signed event written");

  const broken = fakeDb({ error: "connection lost" });
  const r3 = await receiveEvent(new Request("http://x", { method: "POST", body, headers: { "Stripe-Signature": await sign(body) } }),
    SECRET, { db: broken.db, stripe: fakeStripe(activeSub()).stripe, priceId: "price_pro" });
  eq(r3.status, 500, "Stripe retries");
});
