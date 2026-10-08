// Unit tests of stripe-checkout: who gets a Stripe page, and what the payment page asks.
// Run: npm run test:functions
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { handler, openStripe, returnUrl, type Stripe, toForm } from "./index.ts";

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}\n  expected ${b}\n  got      ${a}`);
}

const SHOP = "11111111-2222-4333-8444-555555555555";
const USER = { id: "00000000-0000-0000-0000-00000000000a", email: "owner@example.invalid" };
const BACK = "https://cacadoo.example/sk/dashboard?shop=farby-kovac";

interface Setup {
  user?: typeof USER | null;
  member?: boolean;
  shop?: { id: string; name: string; ico: string | null } | null;
  row?: { stripe_customer_id: string | null; stripe_subscription_id: string | null; status: string } | null;
}

/** Fakes for the caller's client, the service-role client and Stripe; every call is recorded. */
function fakes(setup: Setup = {}) {
  const user = setup.user === undefined ? USER : setup.user;
  const shop = setup.shop === undefined ? { id: SHOP, name: "Farby Kováč", ico: "12345678" } : setup.shop;
  const log: string[] = [];
  const table = (name: string) => ({
    select: () => ({
      eq: () => ({ maybeSingle: () => Promise.resolve({ data: name === "shops" ? shop : setup.row ?? null, error: null }) }),
    }),
  });
  const asCaller = {
    auth: { getUser: (token: string) => Promise.resolve({ data: { user: token === "owner-jwt" ? user : null } }) },
    rpc: (name: string, args: Record<string, unknown>) => {
      log.push(`caller ${name} ${JSON.stringify(args)}`);
      return Promise.resolve({ data: setup.member ?? true, error: null });
    },
    from: table,
  };
  const db = {
    rpc: (name: string, args: Record<string, unknown>) => {
      log.push(`service ${name} ${JSON.stringify(args)}`);
      return Promise.resolve({ data: args.p_customer, error: null });
    },
  };
  const stripeCalls: { path: string; form: Record<string, string>; key?: string }[] = [];
  const stripe = (<T>(_method: string, path: string, params = {}, key?: string) => {
    stripeCalls.push({ path, form: Object.fromEntries(toForm(params)), key });
    if (path === "/customers") return Promise.resolve({ id: "cus_new" } as T);
    if (path === "/checkout/sessions") return Promise.resolve({ url: "https://checkout.stripe.com/c/pay/cs_test_1" } as T);
    return Promise.resolve({ url: "https://billing.stripe.com/p/session/test_1" } as T);
  }) as Stripe;
  const deps = { asCaller: asCaller as unknown as SupabaseClient, db: db as unknown as SupabaseClient, stripe, priceId: "price_pro" };
  return { deps, log, stripeCalls };
}

function request(body: Record<string, unknown>, token = "owner-jwt") {
  return new Request("http://localhost/stripe-checkout", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ shop_id: SHOP, lang: "sk", return_url: BACK, company_id_label: "IČO", ...body }),
  });
}

Deno.test("Upgrade: one customer for the shop, then the payment page with tax and company details", async () => {
  const { deps, log, stripeCalls } = fakes();
  const response = await openStripe(request({ action: "checkout" }), deps);
  eq([response.status, await response.json()], [200, { url: "https://checkout.stripe.com/c/pay/cs_test_1", kind: "checkout" }], "reply");

  eq(stripeCalls.map((c) => c.path), ["/customers", "/checkout/sessions"], "Stripe calls");
  eq(stripeCalls[0].form, {
    email: USER.email,
    name: "Farby Kováč",
    "preferred_locales[0]": "sk",
    "metadata[shop_id]": SHOP,
    "invoice_settings[custom_fields][0][name]": "IČO",
    "invoice_settings[custom_fields][0][value]": "12345678",
  }, "customer with the company ID for the first invoice");
  eq(stripeCalls[0].key, `ppi-customer-${SHOP}-${USER.id}`, "a double click makes no second customer");
  eq(log, [
    `caller is_shop_member {"p_shop_id":"${SHOP}"}`,
    `service link_stripe_customer {"p_shop_id":"${SHOP}","p_customer":"cus_new"}`,
  ], "membership checked with the owner's login; customer remembered");

  eq(stripeCalls[1].form, {
    mode: "subscription",
    customer: "cus_new",
    "customer_update[name]": "auto",
    "customer_update[address]": "auto",
    "line_items[0][price]": "price_pro",
    "line_items[0][quantity]": "1",
    client_reference_id: SHOP,
    "metadata[shop_id]": SHOP,
    "subscription_data[metadata][shop_id]": SHOP,
    "automatic_tax[enabled]": "true",
    "tax_id_collection[enabled]": "true",
    "name_collection[business][enabled]": "true",
    billing_address_collection: "required",
    "custom_fields[0][key]": "companyid",
    "custom_fields[0][label][type]": "custom",
    "custom_fields[0][label][custom]": "IČO",
    "custom_fields[0][type]": "text",
    "custom_fields[0][optional]": "true",
    "custom_fields[0][text][maximum_length]": "40",
    "custom_fields[0][text][default_value]": "12345678",
    locale: "sk",
    success_url: `${BACK}&plan=done#plan`,
    cancel_url: `${BACK}&plan=canceled#plan`,
  }, "payment page");
});

Deno.test("the shop's customer is reused; no company ID yet: the field starts empty", async () => {
  const { deps, log, stripeCalls } = fakes({
    shop: { id: SHOP, name: "Farby", ico: null },
    row: { stripe_customer_id: "cus_old", stripe_subscription_id: "sub_old", status: "canceled" },
  });
  const response = await openStripe(request({ action: "checkout" }), deps);
  eq(response.status, 200, "reply");
  eq(stripeCalls.map((c) => c.path), ["/checkout/sessions"], "no second customer");
  eq([stripeCalls[0].form.customer, stripeCalls[0].form["custom_fields[0][text][default_value]"]], ["cus_old", undefined], "customer, field");
  eq(log.some((l) => l.startsWith("service")), false, "nothing written");
});

Deno.test("a live subscription gets the customer portal, never a second payment page", async () => {
  for (const status of ["active", "trialing", "past_due", "unpaid", "paused"]) {
    const { deps, stripeCalls } = fakes({ row: { stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1", status } });
    const response = await openStripe(request({ action: "checkout" }), deps);
    eq((await response.json()).kind, "portal", status);
    eq(stripeCalls[0], { path: "/billing_portal/sessions", form: { customer: "cus_1", return_url: BACK, locale: "sk" } }, `${status}: portal`);
  }
  const { deps } = fakes({ row: { stripe_customer_id: "cus_1", stripe_subscription_id: null, status: "none" } });
  const response = await openStripe(request({ action: "portal" }), deps);
  eq([response.status, (await response.json()).error], [409, "no_subscription"], "no subscription yet: no portal");
});

Deno.test("only the shop's owners, with a valid login, get a Stripe page", async () => {
  const notMember = fakes({ member: false });
  const r1 = await openStripe(request({ action: "checkout" }), notMember.deps);
  eq([r1.status, notMember.stripeCalls.length], [403, 0], "not the shop's owner");

  const noLogin = fakes();
  const r2 = await openStripe(request({ action: "checkout" }, "forged-jwt"), noLogin.deps);
  eq([r2.status, noLogin.stripeCalls.length, noLogin.log.length], [401, 0, 0], "no valid login");

  const bad = fakes();
  const r3 = await openStripe(request({ action: "refund" }), bad.deps);
  eq(r3.status, 400, "unknown action");
});

Deno.test("Stripe sends the owner back only to a PPI dashboard page", () => {
  eq(returnUrl(BACK)?.toString(), BACK, "dashboard");
  eq(returnUrl("http://localhost:3000/en/dashboard?shop=x")?.toString(), "http://localhost:3000/en/dashboard?shop=x", "this computer");
  for (const bad of ["https://evil.example/login", "http://cacadoo.example/sk/dashboard", "javascript:alert(1)",
    "https://user:pw@cacadoo.example/sk/dashboard", "https://cacadoo.example/sk/dashboard/../login", "/sk/dashboard", null]) {
    eq(returnUrl(bad), null, String(bad));
  }
});

Deno.test("without the Stripe secrets the function says so (503)", async () => {
  Deno.env.set("SUPABASE_URL", "http://localhost:54321");
  Deno.env.set("SUPABASE_ANON_KEY", "anon");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service");
  Deno.env.delete("STRIPE_SECRET_KEY");
  Deno.env.delete("STRIPE_PRICE_PRO");
  const response = await handler(request({ action: "checkout" }));
  eq([response.status, (await response.json()).error], [503, "not_configured"], "not configured");
});
