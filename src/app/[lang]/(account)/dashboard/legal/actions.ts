"use server";

import { redirect } from "next/navigation";
import { isLocale, type Locale } from "@/i18n/config";
import { getSession } from "@/lib/auth";
import { validSkIco } from "@/lib/domainName";
import { OWNER_FIELDS } from "@/lib/domains";
import type { MyShop } from "@/lib/myShops";
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

/**
 * Právne informácie → "Firma" (back-end layout L2; the fields were in Údaje obchodu, update 47): the company name, IČO
 * and DIČ. The IČO is a column of the shop, saved by owner_save_shop() — sent again with every other value as it is now
 * (my_shops(), the owner's own row), so only the IČO changes; the company name and DIČ go with the PSČ as they are to
 * owner_save_company() (its own checks: "dic", "zip").
 */
export async function saveCompany(formData: FormData) {
  const langValue = String(formData.get("lang") ?? "");
  const lang: Locale = isLocale(langValue) ? langValue : "en";
  const session = await getSession();
  if (!session) redirect(`/${lang}/login`);
  const shopId = String(formData.get("shop_id") ?? "");
  const slug = String(formData.get("shop_slug") ?? "");
  const back = (query: Record<string, string>): never =>
    redirect(`/${lang}/dashboard/legal?${new URLSearchParams({ shop: slug, ...query })}#company`);
  if (!UUID.test(shopId)) back({ err: "err_failed" });
  const value = (name: string, max: number) => String(formData.get(name) ?? "").trim().slice(0, max);
  const { data: rows } = await session.supabase.rpc("my_shops");
  const shop = ((rows ?? []) as MyShop[]).find((s) => s.id === shopId);
  if (!shop) back({ err: "err_failed" });
  const ico = value("ico", 40);
  if (ico !== (shop!.ico ?? "")) {
    const s = shop!;
    const { error } = await session.supabase.rpc("owner_save_shop", {
      p: {
        id: s.id,
        slug_base: s.slug,
        name: s.name,
        ico,
        address: s.address ?? "",
        city: s.city ?? "",
        country: s.country ?? "",
        timezone: s.timezone,
        lat: s.lat === null ? "" : String(s.lat),
        lng: s.lng === null ? "" : String(s.lng),
        phone: s.phone ?? "",
        website: s.website ?? "",
        email: s.email ?? "",
        facebook_url: s.facebook_url ?? "",
        opening_hours: s.opening_hours,
        is_active: s.is_active,
        has_toilet: s.has_toilet,
        has_douchette: s.has_douchette,
        has_card_terminal: s.has_card_terminal,
      },
    });
    if (error) back({ err: "err_company" });
  }
  const { error: companyError } = await session.supabase.rpc("owner_save_company", {
    p_shop_id: shopId,
    p_company_name: value("company_name", 200),
    p_dic: value("dic", 20),
    p_zip: shop!.zip ?? "",
  });
  if (companyError && companyError.code !== "PGRST202" && companyError.code !== "42883") {
    back({ err: companyError.message === "dic" ? "err_dic" : "err_company" });
  }
  refreshShop(slug);
  back({ ok: "company" });
}

/**
 * Právne informácie → "Prevádzkovateľ" (back-end layout L2): the owner's details a domain is registered with (update 25,
 * shop_legal; also asked by the domain wizard of Predplatné a doména). Only the fields sent are changed
 * (owner_save_legal()); a Slovak IČO must be valid.
 */
export async function saveOperator(formData: FormData) {
  const langValue = String(formData.get("lang") ?? "");
  const lang: Locale = isLocale(langValue) ? langValue : "en";
  const session = await getSession();
  if (!session) redirect(`/${lang}/login`);
  const shopId = String(formData.get("shop_id") ?? "");
  const slug = String(formData.get("shop_slug") ?? "");
  const back = (query: Record<string, string>): never =>
    redirect(`/${lang}/dashboard/legal?${new URLSearchParams({ shop: slug, ...query })}#operator`);
  if (!UUID.test(shopId)) back({ err: "err_failed" });
  const details: Record<string, string> = {};
  for (const field of OWNER_FIELDS) {
    const v = formData.get(field);
    if (typeof v === "string" && v.trim()) details[field] = v.trim().slice(0, 200);
  }
  if (details.ico && (details.country ?? "").toUpperCase() === "SK" && !validSkIco(details.ico)) back({ err: "err_operator_ico" });
  const { error } = await session.supabase.rpc("owner_save_legal", { p_shop_id: shopId, p_details: details });
  back(error ? { err: "err_operator" } : { ok: "operator" });
}
