/// <reference lib="deno.ns" />
// PPI · admin-status Edge Function (2026-11-05, Admin → Prehľad / Preklady)
//
// Tells the admin's pages which modes the platform runs in, from the function secrets — never a key or a value:
//   - stripe: "test" | "live" from the prefix of STRIPE_SECRET_KEY (sk_test_ / rk_test_ → test, sk_live_ / rk_live_ →
//     live; another prefix → "unknown"; no key → null). Only these words leave the function; nothing calls Stripe.
//   - registrar: REGISTRAR_MODE ("live" or else "test", as the domains function reads it) and whether the Websupport
//     keys (WEBSUPPORT_API_KEY, WEBSUPPORT_API_SECRET, WEBSUPPORT_USER_ID) exist.
//   - translation_budget_eur: TRANSLATION_MONTHLY_BUDGET_EUR as the translate function reads it (null = no budget).
// Only an admin: the caller's own login, then is_admin() (RLS / SQL decide). Reads nothing else, writes nothing.
//
// Deploy: Supabase → Edge Functions → Deploy a new function → Via Editor → name "admin-status" → paste this file →
// Deploy, then switch OFF "Verify JWT" (it checks its caller itself). No new secret.

import { createClient } from "npm:@supabase/supabase-js@2";

export interface Status {
  stripe: "test" | "live" | "unknown" | null;
  registrar: { mode: "test" | "live"; configured: boolean };
  translation_budget_eur: number | null;
}

type Env = (name: string) => string | undefined;

/** The modes, from the names of the secrets only (the key's prefix for Stripe). */
export function statusOf(env: Env): Status {
  const key = (env("STRIPE_SECRET_KEY") ?? "").trim();
  const stripe = !key ? null : /^(sk|rk)_live_/.test(key) ? "live" : /^(sk|rk)_test_/.test(key) ? "test" : "unknown";
  const has = (name: string) => Boolean((env(name) ?? "").trim());
  const budget = Number((env("TRANSLATION_MONTHLY_BUDGET_EUR") ?? "").trim() || "0");
  return {
    stripe,
    registrar: {
      mode: (env("REGISTRAR_MODE") ?? "").trim() === "live" ? "live" : "test",
      configured: has("WEBSUPPORT_API_KEY") && has("WEBSUPPORT_API_SECRET") && has("WEBSUPPORT_USER_ID"),
    },
    translation_budget_eur: Number.isFinite(budget) && budget > 0 ? budget : null,
  };
}

interface Caller {
  auth: { getUser(token: string): PromiseLike<{ data: { user: { id: string } | null } | null }> };
  rpc(name: string): PromiseLike<{ data: unknown; error: unknown }>;
}

export interface Deps {
  asCaller: (authorization: string) => Caller;
  env: Env;
}

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== "POST") return reply(405, { error: "method" });
  const authorization = req.headers.get("Authorization") ?? "";
  const token = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!token) return reply(401, { error: "login" });
  const caller = deps.asCaller(authorization);
  const { data: auth } = await caller.auth.getUser(token);
  if (!auth?.user) return reply(401, { error: "login" });
  const admin = await caller.rpc("is_admin");
  if (admin.error || admin.data !== true) return reply(403, { error: "not_admin" });
  return reply(200, statusOf(deps.env));
}

export function handler(req: Request): Promise<Response> {
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anonKey) return Promise.resolve(reply(500, { error: "config" }));
  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  return handle(req, {
    asCaller: (authorization) =>
      createClient(url, anonKey, { ...options, global: { headers: { Authorization: authorization } } }) as unknown as Caller,
    env: (name) => Deno.env.get(name),
  });
}

if (!Deno.env.get("PPI_FUNCTION_TEST")) Deno.serve(handler);
