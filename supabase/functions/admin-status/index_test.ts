// Unit tests of the admin-status function: only an admin, only modes (never a key). Run: npm run test:functions
import { type Deps, handle, statusOf } from "./index.ts";

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}\n  expected ${b}\n  got      ${a}`);
}

const env = (values: Record<string, string>) => (name: string) => values[name];

Deno.test("statusOf: Stripe's mode from the key's prefix, Websupport's mode and keys, the translation budget", () => {
  eq(statusOf(env({})), { stripe: null, registrar: { mode: "test", configured: false }, translation_budget_eur: null }, "nothing set");
  eq(statusOf(env({ STRIPE_SECRET_KEY: "sk_test_abc" })).stripe, "test", "test key");
  eq(statusOf(env({ STRIPE_SECRET_KEY: "rk_live_abc" })).stripe, "live", "restricted live key");
  eq(statusOf(env({ STRIPE_SECRET_KEY: "pk_live_abc" })).stripe, "unknown", "not a secret key");
  eq(statusOf(env({ REGISTRAR_MODE: "live", WEBSUPPORT_API_KEY: "k", WEBSUPPORT_API_SECRET: "s", WEBSUPPORT_USER_ID: "1" })).registrar,
    { mode: "live", configured: true }, "Websupport live");
  eq(statusOf(env({ REGISTRAR_MODE: "LIVE", WEBSUPPORT_API_KEY: "k" })).registrar, { mode: "test", configured: false }, "only exact live");
  eq([statusOf(env({ TRANSLATION_MONTHLY_BUDGET_EUR: "25" })).translation_budget_eur, statusOf(env({ TRANSLATION_MONTHLY_BUDGET_EUR: "0" })).translation_budget_eur,
    statusOf(env({ TRANSLATION_MONTHLY_BUDGET_EUR: "x" })).translation_budget_eur], [25, null, null], "budget");
});

Deno.test("handle: a login and is_admin() first; the answer never carries a key", async () => {
  const deps = (user: string | null, admin: boolean): Deps => ({
    asCaller: () => ({
      auth: { getUser: () => Promise.resolve({ data: { user: user ? { id: user } : null } }) },
      rpc: () => Promise.resolve({ data: admin, error: null }),
    }),
    env: env({ STRIPE_SECRET_KEY: "sk_live_secretvalue", REGISTRAR_MODE: "live" }),
  });
  const post = (auth?: string) => new Request("https://x/admin-status", { method: "POST", headers: auth ? { Authorization: auth } : {} });
  eq((await handle(post(), deps("u", true))).status, 401, "no login");
  eq((await handle(post("Bearer t"), deps(null, true))).status, 401, "unknown login");
  eq((await handle(post("Bearer t"), deps("u", false))).status, 403, "not an admin");
  const ok = await handle(post("Bearer t"), deps("u", true));
  const text = await ok.text();
  eq([ok.status, JSON.parse(text).stripe, JSON.parse(text).registrar.mode], [200, "live", "live"], "modes");
  eq(text.includes("secretvalue") || text.includes("sk_live"), false, "never the key");
  eq((await handle(new Request("https://x", { method: "GET" }), deps("u", true))).status, 405, "POST only");
});
