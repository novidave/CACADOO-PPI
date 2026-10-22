"use server";

import { redirect } from "next/navigation";
import { isLocale, type Locale } from "@/i18n/config";
import { getSession } from "@/lib/auth";
import { sectionUrl } from "@/lib/dashboardPages";
import type { Cell, CellRow } from "@/lib/translations";
import { refreshAll, refreshShop } from "@/lib/publicCache";

/**
 * Môj obchod → "Jazyky a inventár" and a product's "Popis" / "Preklady" tabs (database update 40). Every change goes
 * through an owner_ function that checks the caller owns the shop; Claude is asked only through the translate function
 * with the owner's own login (it checks the shop again). The original texts are never changed here.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LANG = /^[a-z]{2}(-(cyrl|hans|hant))?$/;

function langOf(formData: FormData): Locale {
  const value = String(formData.get("lang") ?? "");
  return isLocale(value) ? value : "en";
}

async function session(lang: Locale) {
  const s = await getSession();
  if (!s) redirect(`/${lang}/login`);
  return s;
}

const codes = (formData: FormData, name: string) => formData.getAll(name).map(String).filter((c) => LANG.test(c));

/** "Uložiť jazyky": the main, stock-file, preferred and own-domain languages, automatic descriptions. */
export async function saveLanguages(formData: FormData) {
  const lang = langOf(formData);
  const { supabase } = await session(lang);
  const shopId = String(formData.get("shop_id") ?? "");
  const slug = String(formData.get("shop_slug") ?? "");
  const back = (query: Record<string, string>) => {
    // A saved change a visitor can see: the public pages read it again at once.
    if (query.ok) refreshShop(slug);
    return redirect(sectionUrl(lang, "languages", { shop: slug, ...query }));
  };
  if (!UUID.test(shopId)) back({ err: "invalid shop" });
  const main = String(formData.get("main_lang") ?? "");
  const domain = String(formData.get("domain_lang") ?? "");
  const { error } = await supabase.rpc("owner_save_language_settings", {
    p_shop_id: shopId,
    p_main: main,
    p_inventory: codes(formData, "inventory_langs"),
    p_preferred: codes(formData, "preferred_langs"),
    p_domain: LANG.test(domain) ? domain : null,
    p_auto_descriptions: formData.get("auto_descriptions") === "on",
  });
  if (error) back({ err: ["main", "langs", "limit", "domain"].includes(error.message) ? `languages_${error.message}` : error.message });
  back({ ok: "languages" });
}

/** "Uložiť a zverejniť" / "Zahodiť" of a description, and which description the page shows. */
export async function saveDescription(formData: FormData) {
  const lang = langOf(formData);
  const { supabase } = await session(lang);
  const slug = String(formData.get("shop_slug") ?? "");
  const itemId = String(formData.get("item_id") ?? "");
  const back = (query: Record<string, string>) => {
    // A saved change a visitor can see: the public pages read it again at once.
    if (query.ok) refreshShop(slug);
    return redirect(`/${lang}/dashboard/items/${itemId}?${new URLSearchParams({ shop: slug, tab: "description", ...query })}`);
  };
  if (!UUID.test(itemId)) redirect(`/${lang}/dashboard`);
  const action = String(formData.get("action") ?? "");
  if (action === "show") {
    const { error } = await supabase.rpc("owner_set_description_choice", { p_item_id: itemId, p_show: String(formData.get("show") ?? "auto") });
    if (error) back({ err: error.message });
    back({ ok: "description_choice" });
  }
  const publish = action === "publish";
  const { error } = await supabase.rpc("owner_save_description", {
    p_item_id: itemId,
    p_text: publish ? String(formData.get("text") ?? "") : null,
    p_publish: publish,
  });
  if (error) back({ err: error.message === "too_long" ? "description_too_long" : error.message });
  back({ ok: publish ? "description_published" : "description_discarded" });
}

/** "Vygenerovať popis" (one product, or up to 20 without a description): drafts from the shop's own data. */
export async function generateDescriptions(formData: FormData) {
  const lang = langOf(formData);
  const { supabase } = await session(lang);
  const slug = String(formData.get("shop_slug") ?? "");
  const shopId = String(formData.get("shop_id") ?? "");
  const one = String(formData.get("item_id") ?? "");
  let ids = UUID.test(one) ? [one] : [];
  if (!ids.length && UUID.test(shopId)) {
    // the first 20 products with neither the shop's own description nor Cacaduu's (nor a draft waiting)
    const { data } = await supabase.rpc("owner_items_without_description", { p_shop_id: shopId, p_limit: 20 });
    ids = ((data ?? []) as { item_id: string }[]).map((r) => r.item_id);
  }
  const back = (query: Record<string, string>) =>
    one
      ? redirect(`/${lang}/dashboard/items/${one}?${new URLSearchParams({ shop: slug, tab: "description", ...query })}`)
      : redirect(sectionUrl(lang, "translations", { shop: slug, ...query }));
  if (!ids.length) back({ err: "descriptions_none" });
  const { data, error } = await supabase.functions.invoke<{ results: { state: string }[]; error?: string }>("translate", {
    body: { action: "describe", item_ids: ids },
  });
  if (error || !data) back({ err: "descriptions_failed" });
  const made = (data?.results ?? []).filter((r) => r.state === "draft" || r.state === "published").length;
  if (!made) back({ err: (data?.results ?? []).some((r) => r.state === "too_few_facts") ? "descriptions_few_facts" : "descriptions_failed" });
  back({ ok: "descriptions", n: String(made) });
}

// ---------------------------------------------------------------- the Preklady table (called from the browser)

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

async function owner() {
  const s = await getSession();
  return s?.supabase ?? null;
}

/** One page of the table. */
export async function loadTranslations(shopId: string, filters: { lang?: string; kind?: string; state?: string; q?: string; ref?: string; page?: number }): Promise<Result<{ rows: CellRow[]; total: number }>> {
  const supabase = await owner();
  if (!supabase || !UUID.test(shopId)) return { ok: false, error: "login" };
  const { data, error } = await supabase.rpc("owner_translations", {
    p_shop_id: shopId,
    p_lang: filters.lang && LANG.test(filters.lang) ? filters.lang : null,
    p_kind: filters.kind || null,
    p_state: filters.state || null,
    p_q: filters.q?.trim() || null,
    p_ref: filters.ref || null,
    p_page: filters.page ?? 1,
    p_per_page: 50,
  });
  if (error) return { ok: false, error: error.message };
  const rows = (data ?? []) as (CellRow & { total: number })[];
  return { ok: true, value: { rows, total: Number(rows[0]?.total ?? 0) } };
}

/** "Upraviť" / "+ Pridať preklad": the owner's own text. */
export async function saveTranslation(shopId: string, cell: Cell, text: string): Promise<Result<null>> {
  const supabase = await owner();
  if (!supabase || !UUID.test(shopId)) return { ok: false, error: "login" };
  const { error } = await supabase.rpc("owner_save_translation", { p_shop_id: shopId, p_kind: cell.kind, p_ref: cell.ref, p_lang: cell.lang, p_text: text });
  if (error) return { ok: false, error: error.message };
  refreshAll();
  return { ok: true, value: null };
}

/** "Preložiť znova" / "Navrhnúť nový preklad": Claude's text, nothing saved. */
export async function suggestTranslation(shopId: string, cell: Cell): Promise<Result<string>> {
  const supabase = await owner();
  if (!supabase || !UUID.test(shopId)) return { ok: false, error: "login" };
  const { data, error } = await supabase.functions.invoke<{ text?: string; error?: string }>("translate", {
    body: { action: "suggest", shop_id: shopId, kind: cell.kind, ref: cell.ref, lang: cell.lang },
  });
  if (error || !data?.text) return { ok: false, error: data?.error ?? "failed" };
  return { ok: true, value: data.text };
}

/** Taking Claude's new text: an AI translation (a shop's or the owner's own one is saved as the owner's). */
export async function acceptTranslation(shopId: string, cell: Cell, text: string, asOwn: boolean): Promise<Result<null>> {
  const supabase = await owner();
  if (!supabase || !UUID.test(shopId)) return { ok: false, error: "login" };
  const { error } = asOwn
    ? await supabase.rpc("owner_save_translation", { p_shop_id: shopId, p_kind: cell.kind, p_ref: cell.ref, p_lang: cell.lang, p_text: text })
    : await supabase.rpc("owner_accept_translation", { p_shop_id: shopId, p_kind: cell.kind, p_ref: cell.ref, p_lang: cell.lang, p_text: text });
  if (error) return { ok: false, error: error.message };
  refreshAll();
  return { ok: true, value: null };
}

/** "Zmazať" (one or many): returns the rows as they were, for "Späť" within 30 s. */
export async function deleteTranslations(shopId: string, cells: Cell[], never: boolean): Promise<Result<unknown[]>> {
  const supabase = await owner();
  if (!supabase || !UUID.test(shopId)) return { ok: false, error: "login" };
  const { data, error } = await supabase.rpc("owner_delete_translations", { p_shop_id: shopId, p_cells: cells.slice(0, 1000), p_never: never });
  if (error) return { ok: false, error: error.message };
  refreshAll();
  return { ok: true, value: (data ?? []) as unknown[] };
}

export async function restoreTranslations(shopId: string, rows: unknown[]): Promise<Result<null>> {
  const supabase = await owner();
  if (!supabase || !UUID.test(shopId)) return { ok: false, error: "login" };
  const { error } = await supabase.rpc("owner_restore_translations", { p_shop_id: shopId, p_rows: rows });
  if (error) return { ok: false, error: error.message };
  refreshAll();
  return { ok: true, value: null };
}

/** "Preložiť znova" for many: the missing ones of a language are translated now (a part per call). */
export async function translateNow(shopId: string, lang: string): Promise<Result<{ saved: number; left: number }>> {
  const supabase = await owner();
  if (!supabase || !UUID.test(shopId) || !LANG.test(lang)) return { ok: false, error: "login" };
  const { data, error } = await supabase.functions.invoke<{ saved?: number; left?: number; error?: string }>("translate", {
    body: { action: "run", shop_id: shopId, lang },
  });
  if (error || !data) return { ok: false, error: data?.error ?? "failed" };
  refreshAll();
  return { ok: true, value: { saved: Number(data.saved ?? 0), left: Number(data.left ?? 0) } };
}
