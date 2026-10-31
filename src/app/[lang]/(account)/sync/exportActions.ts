"use server";

import { getSession } from "@/lib/auth";
import type { Edit } from "@/lib/exportFiles";
import { refreshShop } from "@/lib/publicCache";

/**
 * "Po nahratí súboru" and "Preklady v priečinku" (database update 45), called from the owner's browser: every write
 * goes through an owner_* function (membership checked there); what visitors can see is read again at once.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LANG = /^[a-z]{2,3}(-[a-z]{2,4})?$/;
const FIELDS = ["source_code", "name", "ean", "brand", "quantity", "price", "currency", "description", "category", "private"];

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

async function owner() {
  const s = await getSession();
  return s?.supabase ?? null;
}

export interface ReviewSaved {
  describeIds: string[];
  marked: number;
}

/** "Nový súbor – skontrolujte" → "Uložiť". */
export async function saveExportReview(input: {
  shopId: string;
  slug: string;
  columns: Record<string, string>;
  langs: string[] | null;
  describe: boolean;
  remember: boolean;
}): Promise<Result<ReviewSaved>> {
  const supabase = await owner();
  if (!supabase || !UUID.test(input.shopId)) return { ok: false, error: "login" };
  const columns = Object.fromEntries(
    Object.entries(input.columns ?? {})
      .filter(([column, field]) => column.length <= 200 && FIELDS.includes(field))
      .slice(0, 200),
  );
  const langs = Array.isArray(input.langs) ? input.langs.filter((l) => typeof l === "string" && LANG.test(l)).slice(0, 42) : null;
  const { data, error } = await supabase.rpc("owner_save_export_review", {
    p_shop_id: input.shopId,
    p_columns: columns,
    p_langs: langs,
    p_describe: Boolean(input.describe),
    p_remember: Boolean(input.remember),
  });
  if (error) return { ok: false, error: ["column", "field", "langs", "limit"].includes(error.message) ? error.message : "failed" };
  refreshShop(input.slug);
  const value = (data ?? {}) as { describe_ids?: string[]; marked?: number };
  return { ok: true, value: { describeIds: (value.describe_ids ?? []).filter((id) => UUID.test(id)), marked: Number(value.marked ?? 0) } };
}

/** With "Zapamätať a už sa nepýtať": the shop PC's window handles new products on each check. */
export async function exportAuto(shopId: string): Promise<Result<{ remember: boolean; describeIds: string[]; marked: number }>> {
  const supabase = await owner();
  if (!supabase || !UUID.test(shopId)) return { ok: false, error: "login" };
  const { data, error } = await supabase.rpc("owner_export_auto", { p_shop_id: shopId });
  if (error) return { ok: false, error: error.code === "PGRST202" ? "unavailable" : "failed" };
  const value = (data ?? {}) as { remember?: boolean; describe_ids?: string[]; marked?: number };
  return {
    ok: true,
    value: { remember: Boolean(value.remember), describeIds: (value.describe_ids ?? []).filter((id) => UUID.test(id)), marked: Number(value.marked ?? 0) },
  };
}

/** "Vygenerovať popisy": drafts (or published, with "Zverejniť vygenerované popisy automaticky") for up to 20 products. */
export async function describeItems(slug: string, ids: string[]): Promise<Result<{ made: number }>> {
  const supabase = await owner();
  const list = (Array.isArray(ids) ? ids : []).filter((id) => UUID.test(id)).slice(0, 20);
  if (!supabase || !list.length) return { ok: false, error: "login" };
  const { data, error } = await supabase.functions.invoke<{ results: { state: string }[] }>("translate", {
    body: { action: "describe", item_ids: list },
  });
  if (error || !data) return { ok: false, error: "failed" };
  const made = data.results.filter((r) => r.state === "draft" || r.state === "published").length;
  if (data.results.some((r) => r.state === "published")) refreshShop(slug);
  return { ok: true, value: { made } };
}

export interface EditsApplied {
  applied: number;
  same: number;
  unknown: { code: string | null; ean: string | null }[];
  skipped: { code: string; field: string; reason: string }[];
}

/** The owner's edits of one file (only the changed cells), in parts of 2 000. */
export async function applyExportEdits(input: { shopId: string; slug: string; lang: string | null; file: string; edits: Edit[] }): Promise<Result<EditsApplied>> {
  const supabase = await owner();
  if (!supabase || !UUID.test(input.shopId)) return { ok: false, error: "login" };
  if (input.lang !== null && !LANG.test(input.lang)) return { ok: false, error: "lang" };
  const rows = (Array.isArray(input.edits) ? input.edits : [])
    .filter((e) => e && ["description", "name", "category"].includes(e.field) && typeof e.text === "string")
    .map((e) => ({ code: String(e.code ?? "").slice(0, 200), ean: e.ean ? String(e.ean).slice(0, 40) : null, field: e.field, text: e.text.slice(0, 70_000) }));
  const total: EditsApplied = { applied: 0, same: 0, unknown: [], skipped: [] };
  for (let i = 0; i < rows.length; i += 2000) {
    const { data, error } = await supabase.rpc("owner_apply_export_edits", {
      p_shop_id: input.shopId,
      p_lang: input.lang,
      p_file: String(input.file ?? "").slice(0, 120),
      p_rows: rows.slice(i, i + 2000),
    });
    if (error) return { ok: false, error: error.message === "lang" ? "lang" : "failed" };
    const part = data as EditsApplied;
    total.applied += part.applied;
    total.same += part.same;
    total.unknown.push(...part.unknown);
    total.skipped.push(...part.skipped);
  }
  if (total.applied) refreshShop(input.slug);
  return { ok: true, value: total };
}
