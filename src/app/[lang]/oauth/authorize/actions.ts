"use server";

import { redirect } from "next/navigation";
import { isLocale, type Locale } from "@/i18n/config";
import { getSession } from "@/lib/auth";
import { authorizeQuery, readAuthorize, redirectWith, SCOPES, type Scope } from "@/lib/ownerMcpRules";
import { siteUrl } from "@/lib/site";
import { createPublicClient } from "@/lib/supabase/public";

/** The request again from the form's hidden fields; the database checks the client and its addresses. */
function request(formData: FormData) {
  const langValue = String(formData.get("lang") ?? "");
  const lang: Locale = isLocale(langValue) ? langValue : "en";
  const asked = readAuthorize(new URLSearchParams(String(formData.get("request") ?? "")));
  if ("error" in asked) redirect(`/${lang}/dashboard`);
  return { lang, asked };
}

/** A redirect only to an address the client registered. */
async function registered(clientId: string, uri: string): Promise<boolean> {
  const db = createPublicClient();
  const { data } = (await db?.rpc("owner_mcp_client", { p_client_id: clientId })) ?? { data: null };
  return Boolean(data && (data as { redirect_uris: string[] }).redirect_uris.includes(uri));
}

/** "Povoliť": a single-use code for the ticked shops and scopes, back to the AI assistant. */
export async function approveMcp(formData: FormData) {
  const { lang, asked } = request(formData);
  const session = await getSession();
  if (!session) redirect(`/${lang}/login?${new URLSearchParams({ next: `/${lang}/oauth/authorize?${authorizeQuery(asked)}` })}`);
  const shops = formData.getAll("shop").map(String);
  const scopes = SCOPES.filter((s) => s === "shop.read" || formData.get(`scope_${s}`) === "on") as Scope[];
  const { data, error } = await session.supabase.rpc("owner_mcp_authorize", {
    p_client_id: asked.client_id,
    p_redirect_uri: asked.redirect_uri,
    p_code_challenge: asked.code_challenge,
    p_scopes: scopes,
    p_shop_ids: shops,
    p_resource: asked.resource,
  });
  if (error || typeof data !== "string") {
    const err = error?.message === "no_plan" ? "no_plan" : error?.message === "shops" ? "shops" : "failed";
    redirect(`/${lang}/oauth/authorize?${authorizeQuery(asked)}&${new URLSearchParams({ err })}`);
  }
  redirect(redirectWith(asked.redirect_uri, { code: data, state: asked.state, iss: siteUrl() }));
}

/** "Zamietnuť": the AI assistant hears access_denied (only at an address it registered). */
export async function denyMcp(formData: FormData) {
  const { lang, asked } = request(formData);
  if (!(await registered(asked.client_id, asked.redirect_uri))) redirect(`/${lang}/dashboard`);
  redirect(redirectWith(asked.redirect_uri, { error: "access_denied", state: asked.state, iss: siteUrl() }));
}
