/// <reference lib="deno.ns" />
// PPI · invite-owner Edge Function
//
// Invites a shop owner by e-mail and links them to a shop. It needs the
// service role key (Supabase provides it to Edge Functions automatically),
// which is why this lives here and never in the website.
//
// Deploy: Supabase dashboard → Edge Functions → Deploy a new function →
// Via Editor → name "invite-owner" → paste this file → Deploy. (SETUP.md, part E)

import { createClient } from "npm:@supabase/supabase-js@2";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function reply(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply(405, { error: "POST only" });

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) return reply(500, { error: "Function is missing Supabase settings" });

  // 1. Who is calling? Ask the database with the caller's own login.
  const authorization = req.headers.get("Authorization") ?? "";
  const asCaller = createClient(url, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: isAdmin, error: adminError } = await asCaller.rpc("is_admin");
  if (adminError || isAdmin !== true) return reply(403, { error: "Admin only" });

  // 2. Check the input.
  let body: { shop_id?: string; email?: string; redirect_to?: string };
  try {
    body = await req.json();
  } catch {
    return reply(400, { error: "Invalid JSON" });
  }
  const shopId = String(body.shop_id ?? "");
  const email = String(body.email ?? "").trim().toLowerCase();
  if (!UUID.test(shopId)) return reply(400, { error: "Invalid shop" });
  if (!EMAIL.test(email) || email.length > 254) return reply(400, { error: "Invalid e-mail" });
  let redirectTo: string | undefined;
  try {
    const parsed = new URL(String(body.redirect_to ?? ""));
    if (parsed.protocol === "https:" || parsed.hostname === "localhost") redirectTo = parsed.toString();
  } catch {
    redirectTo = undefined; // Supabase then uses the project's Site URL
  }

  // 3. Act with the service role.
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: shop } = await admin.from("shops").select("id").eq("id", shopId).maybeSingle();
  if (!shop) return reply(404, { error: "Shop not found" });

  let userId: string | null = null;
  const { data: existing } = await admin.rpc("user_id_by_email", { p_email: email });
  if (existing) userId = String(existing);

  let invited = false;
  if (!userId) {
    const { data, error } = await admin.auth.admin.inviteUserByEmail(email, { redirectTo });
    if (error || !data.user) return reply(400, { error: error?.message ?? "Invitation failed" });
    userId = data.user.id;
    invited = true;
  }

  const { error: linkError } = await admin
    .from("shop_members")
    .upsert({ shop_id: shopId, user_id: userId, role: "owner" }, { onConflict: "shop_id,user_id", ignoreDuplicates: true });
  if (linkError) return reply(500, { error: linkError.message });

  return reply(200, { ok: true, invited });
});
