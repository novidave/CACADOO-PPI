import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Locale } from "@/i18n/config";
import { formatDateTime } from "@/lib/format";
import type { ImportView } from "@/components/RecentImports";

/** One stock file report (public.stock_imports, written only by stock-pull). */
interface ImportRow {
  id: number;
  file_name: string | null;
  file_time: string | null;
  received_at: string;
  status: "ok" | "errors" | "waiting";
  total_rows: number;
  imported: number;
  zeroed: number;
  skipped: number;
  error: string | null;
  columns: string[] | null;
  preview: Record<string, unknown>[] | null;
}

/**
 * "Posledné nahrané súbory": the last 10 stock files of a shop, as the cards show them, and the newest one's status and
 * time (null before database update 21, which has no reports yet). Read only by the shop's owners (RLS).
 */
export async function loadImports(
  supabase: SupabaseClient,
  shop: { id: string; timezone: string },
  lang: Locale,
): Promise<{ imports: ImportView[]; latest: { status: ImportRow["status"]; received_at: string } | null } | null> {
  const { data, error } = await supabase
    .from("stock_imports")
    .select("id, file_name, file_time, received_at, status, total_rows, imported, zeroed, skipped, error, columns, preview")
    .eq("shop_id", shop.id)
    .order("received_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(10);
  if (error) return null;
  const rows = (data ?? []) as ImportRow[];
  return {
    imports: rows.map((row) => ({
      id: row.id,
      fileName: row.file_name ?? "",
      received: formatDateTime(row.received_at, lang, shop.timezone),
      fileTime: row.file_time ? formatDateTime(row.file_time, lang, shop.timezone) : null,
      status: row.status,
      total: row.total_rows,
      imported: row.imported,
      zeroed: row.zeroed,
      skipped: row.skipped,
      error: row.error,
      columns: row.columns ?? [],
      preview: Array.isArray(row.preview) ? row.preview : [],
    })),
    latest: rows[0] ? { status: rows[0].status, received_at: rows[0].received_at } : null,
  };
}
