"use server";

import { redirect } from "next/navigation";
import { isLocale, type Locale } from "@/i18n/config";
import { getSession } from "@/lib/auth";
import { refreshShop } from "@/lib/publicCache";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "Uložiť" on Môj obchod → Právne informácie: the texts as written; owner_save_legal_page() checks membership. */
export async function saveLegalPage(formData: FormData) {
  const langValue = String(formData.get("lang") ?? "");
  const lang: Locale = isLocale(langValue) ? langValue : "en";
  const session = await getSession();
  if (!session) redirect(`/${lang}/login`);
  const shopId = String(formData.get("shop_id") ?? "");
  const slug = String(formData.get("shop_slug") ?? "");
  const back = (query: Record<string, string>): never =>
    redirect(`/${lang}/dashboard/legal?${new URLSearchParams({ shop: slug, ...query })}`);
  if (!UUID.test(shopId)) back({ err: "err_failed" });
  const text = (name: string) => String(formData.get(name) ?? "").slice(0, 30_000);
  const { error } = await session.supabase.rpc("owner_save_legal_page", {
    p_shop_id: shopId,
    p_contact_email: String(formData.get("contact_email") ?? "").trim().slice(0, 254) || null,
    p_privacy: text("privacy"),
    p_terms: text("terms"),
    p_complaints: text("complaints"),
  });
  if (!error) refreshShop(slug);
  back(error ? { err: error.message === "email" ? "err_email" : error.message === "too_long" ? "err_too_long" : "err_failed" } : { ok: "1" });
}
