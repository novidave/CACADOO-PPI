"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isLocale, type Locale } from "@/i18n/config";
import { getSession } from "@/lib/auth";
import { SCOPES } from "@/lib/ownerMcpRules";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface McpKeyState {
  key?: string;
  name?: string;
  error?: string;
}

/** "Vytvoriť kľúč": a personal key for AI assistants without OAuth (shown once; only its hash is kept). */
export async function createMcpKey(_previous: McpKeyState, formData: FormData): Promise<McpKeyState> {
  const session = await getSession();
  if (!session) return { error: "login" };
  const name = String(formData.get("name") ?? "").trim().slice(0, 100);
  if (!name) return { error: "key_name_missing" };
  const shops = formData.getAll("shop").map(String).filter((v) => UUID.test(v));
  if (shops.length === 0) return { error: "key_shops" };
  const scopes = SCOPES.filter((s) => s === "shop.read" || formData.get(`scope_${s}`) === "on");
  const { data, error } = await session.supabase.rpc("owner_mcp_create_key", { p_name: name, p_shop_ids: shops, p_scopes: scopes });
  if (error) return { error: ["no_plan", "too_many", "forbidden"].includes(error.message) ? `key_${error.message}` : "key_failed" };
  revalidatePath("/[lang]/dashboard/ai", "page");
  return { key: (data as { key: string }).key, name };
}

/** "Odpojiť": the assistant or key stops at once. */
export async function disconnectMcp(formData: FormData) {
  const langValue = String(formData.get("lang") ?? "");
  const lang: Locale = isLocale(langValue) ? langValue : "en";
  const session = await getSession();
  if (!session) redirect(`/${lang}/login`);
  const id = String(formData.get("grant_id") ?? "");
  const { error } = UUID.test(id) ? await session.supabase.rpc("owner_mcp_disconnect", { p_id: id }) : { error: { message: "bad" } };
  redirect(`/${lang}/dashboard/ai?${new URLSearchParams(error ? { err: "failed" } : { ok: "disconnected" })}`);
}
