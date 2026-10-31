"use server";

import { redirect } from "next/navigation";
import { isLocale, type Locale } from "@/i18n/config";
import { getSession } from "@/lib/auth";
import { sectionUrl } from "@/lib/dashboardPages";
import { functionFailure } from "@/lib/functionError";
import { resetError } from "@/lib/inventoryReset";
import { refreshShop } from "@/lib/publicCache";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Session = NonNullable<Awaited<ReturnType<typeof getSession>>>;

/**
 * "Začať sklad odznova" (database update 43) on "Priečinok s exportom": every step goes through an owner function that
 * checks the caller owns the shop (and the daily limit, the typed name, the backup, the trash); the form comes back to
 * its section with the result.
 */
async function start(formData: FormData, at: "imports" | "danger") {
  const langValue = String(formData.get("lang") ?? "");
  const lang: Locale = isLocale(langValue) ? langValue : "en";
  const session = await getSession();
  if (!session) redirect(`/${lang}/login`);
  const shopId = String(formData.get("shop_id") ?? "");
  const slug = String(formData.get("shop_slug") ?? "");
  const back = (query: Record<string, string>): never => redirect(sectionUrl(lang, at, { shop: slug, ...query }));
  if (!UUID.test(shopId)) back({ err: "invalid shop" });
  return { session, shopId, slug, back };
}

/** stock-pull deletes the shop's raw files from Storage (the database already forgot them); null = done. */
async function deleteStoredFiles(session: Session, shopId: string): Promise<string | null> {
  const { error } = await session.supabase.functions.invoke(`stock-pull?${new URLSearchParams({ shop_id: shopId, action: "delete_files" })}`, {
    body: {},
  });
  if (!error) return null;
  const failure = await functionFailure(error);
  console.error(`inventory reset: stored files not deleted (${failure.detail})`);
  return (failure.error ?? failure.platform ?? failure.detail).slice(0, 120);
}

/** "Vymazať všetky nahrané súbory": the list, the last file's name, the example rows, then the stored files. */
export async function deleteStockFiles(formData: FormData) {
  const { session, shopId, back } = await start(formData, "imports");
  const { data, error } = await session.supabase.rpc("owner_delete_stock_files", { p_shop_id: shopId });
  if (error) back({ err: resetError(error.message) });
  const storage = await deleteStoredFiles(session, shopId);
  if (storage) back({ err: `reset_storage:${storage}` });
  back({ ok: "reset_files", n: String((data as { files?: number } | null)?.files ?? 0) });
}

/**
 * Option A ("missing") or B ("all", with the typed shop name and the two choices). The backup CSV is made by the
 * database first; the page downloads it (?backup=…). After B the shop's public pages are read again at once.
 */
export async function resetInventory(formData: FormData) {
  const { session, shopId, slug, back } = await start(formData, "danger");
  const mode = formData.get("mode") === "all" ? "all" : "missing";
  const { data, error } = await session.supabase.rpc("owner_inventory_reset", {
    p_shop_id: shopId,
    p_mode: mode,
    p_confirm: String(formData.get("confirm") ?? "").slice(0, 300),
    p_keep_translations: mode === "missing" || formData.get("keep_translations") === "on",
    p_clear_mapping: mode === "all" && formData.get("clear_mapping") === "on",
  });
  if (error) back({ err: resetError(error.message) });
  const result = (data ?? {}) as { items?: number; backup_id?: number };
  // Shop page, item pages, search, sitemap, llms.txt, the API and MCP: without these products from now on.
  refreshShop(slug);
  const query = { ok: mode === "all" ? "reset_all" : "reset_missing", n: String(result.items ?? 0), backup: String(result.backup_id ?? "") };
  if (mode === "all") {
    // update 45: the files Cacaduu wrote into the translations folder go too (the shop PC deletes them on its next check)
    if (formData.get("delete_tr_files") === "on") {
      const { error: filesError } = await session.supabase.rpc("owner_request_export_files_delete", { p_shop_id: shopId });
      if (filesError && filesError.code !== "PGRST202") console.error(`inventory reset: translation files not asked for (${filesError.message})`);
    }
    const storage = await deleteStoredFiles(session, shopId);
    if (storage) back({ ...query, ok: "", err: `reset_storage:${storage}` });
  }
  back(query);
}

/** "Obnoviť sklad": the products of one removal back exactly as they were (refused after a newer file). */
export async function restoreInventory(formData: FormData) {
  const { session, slug, back } = await start(formData, "danger");
  const resetId = Number(formData.get("reset_id"));
  if (!Number.isSafeInteger(resetId) || resetId <= 0) back({ err: "invalid reset" });
  const { data, error } = await session.supabase.rpc("owner_inventory_restore", { p_reset_id: resetId });
  if (error) back({ err: resetError(error.message) });
  refreshShop(slug);
  back({ ok: "reset_restored", n: String((data as { items?: number } | null)?.items ?? 0) });
}
