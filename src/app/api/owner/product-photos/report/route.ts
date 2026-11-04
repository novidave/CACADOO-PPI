import { isLocale } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import { getSession } from "@/lib/auth";
import { PHOTO_ROW_STATUSES, type PhotoRowStatus, reportCsv, type ReportRow } from "@/lib/productPhotos";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/owner/product-photos/report?job=<id>&lang=sk — a bulk photo file's result as CSV for Excel (database update
 * 78): one line per row of the file (number, code, EAN, image_url, result, reason). Read with the owner's own login:
 * RLS lets members read only their own shops' reports.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const job = url.searchParams.get("job") ?? "";
  const asked = url.searchParams.get("lang") ?? "sk";
  const lang = isLocale(asked) ? asked : "sk";
  if (!UUID.test(job)) return Response.json({ error: "bad_request" }, { status: 400 });
  const session = await getSession();
  if (!session) return Response.json({ error: "login" }, { status: 401 });
  const { data: jobRow } = await session.supabase.from("product_photo_jobs").select("id, file_name").eq("id", job).maybeSingle();
  if (!jobRow) return Response.json({ error: "not_found" }, { status: 404 });
  const { data } = await session.supabase.from("product_photo_job_rows").select("n, code, ean, url, status, detail").eq("job_id", job).order("n").limit(5000);
  const p = (await getDictionary(lang)).product_photos;
  const status = Object.fromEntries(PHOTO_ROW_STATUSES.map((s) => [s, p[`status_${s}`]])) as Record<PhotoRowStatus, string>;
  const csv = reportCsv((data ?? []) as ReportRow[], { header: [p.col_row, p.col_code, p.col_ean, p.col_url, p.col_result, p.col_detail], status });
  const name = `${String((jobRow as { file_name: string }).file_name).replace(/\.[a-z]+$/i, "").replace(/[^\p{L}\p{N}_-]+/gu, "-").slice(0, 60) || "fotky"}-vysledok.csv`;
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      "Cache-Control": "no-store",
    },
  });
}
