import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary, t } from "@/i18n/dictionaries";
import { requireUser } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import type { MyShop } from "@/lib/myShops";
import { MAX_PHOTO_ROWS, type PhotoRowStatus, statusCounts } from "@/lib/productPhotos";
import { DbError } from "@/components/DbError";
import { PageTitle } from "@/components/owner/PageHead";
import { cardClass } from "@/components/owner/ui";
import { PhotoBulkUpload, PhotoJobRefresh } from "@/components/owner/PhotoBulkUpload";
import { ShopSwitcher } from "../../shared";

export async function generateMetadata({ params }: PageProps<"/[lang]/dashboard/items/photos">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return { title: (await getDictionary(lang)).product_photos.bulk_title, robots: { index: false } };
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHOWN_ROWS = 200;

interface Job {
  id: string;
  file_name: string;
  kind: "csv" | "xml";
  status: "running" | "done";
  total: number;
  created_at: string;
  finished_at: string | null;
}

interface Row {
  n: number;
  code: string | null;
  ean: string | null;
  url: string | null;
  status: PhotoRowStatus;
  detail: string | null;
}

/**
 * Môj obchod → Tovar → "Fotky produktov" (database update 78): photos for many products at once from a CSV or XML file
 * (the product's code, or its EAN, and image_url per line; sample files to download). The file is read in the
 * browser; the database matches each row; the product-photos function downloads each image on the server. The report
 * shows every row's result (matched, not found, not a picture, too big…) and downloads as CSV.
 */
export default async function ProductPhotosPage({ params, searchParams }: PageProps<"/[lang]/dashboard/items/photos">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const sp = await searchParams;
  const [dict, session] = await Promise.all([getDictionary(lang), requireUser(lang)]);
  const { supabase } = session;
  const p = dict.product_photos;
  const { data: shopRows, error: shopsError } = await supabase.rpc("my_shops");
  if (shopsError) return <DbError message={shopsError.message} dict={dict} />;
  const shops = (shopRows ?? []) as MyShop[];
  if (!shops.length) redirect(`/${lang}/dashboard`);
  const shop = shops.find((s) => s.slug === first(sp.shop)) ?? shops[0];
  const here = (query: Record<string, string> = {}) => `/${lang}/dashboard/items/photos?${new URLSearchParams({ shop: shop.slug, ...query })}`;

  const { data: jobRows } = await supabase
    .from("product_photo_jobs")
    .select("id, file_name, kind, status, total, created_at, finished_at")
    .eq("shop_id", shop.id)
    .order("created_at", { ascending: false })
    .limit(10);
  const jobs = (jobRows ?? []) as Job[];
  const asked = first(sp.job);
  const job = jobs.find((j) => j.id === asked) ?? jobs[0] ?? null;
  const { data: rowData } = job && UUID.test(job.id)
    ? await supabase.from("product_photo_job_rows").select("n, code, ean, url, status, detail").eq("job_id", job.id).order("n").limit(MAX_PHOTO_ROWS)
    : { data: [] };
  const rows = (rowData ?? []) as Row[];
  const counts = statusCounts(rows);
  const finished = rows.filter((r) => r.status !== "pending" && r.status !== "working").length;
  const problems = rows.filter((r) => !["done", "unchanged", "pending", "working", "empty"].includes(r.status));
  const statusText = (s: PhotoRowStatus) => p[`status_${s}`];
  const detailText = (r: Row) => (r.status === "bad_image" && r.detail === "heic" ? p.detail_heic : r.detail ?? "");

  return (
    <div className="flex w-full max-w-3xl flex-col gap-5" data-photo-bulk-page>
      <header className="flex flex-col gap-1">
        <Link href={`/${lang}/dashboard/translations?${new URLSearchParams({ shop: shop.slug, at: "items" })}#items`} className="text-sm underline underline-offset-4">
          {dict.owner_tr.back_to_items}
        </Link>
        <PageTitle>{p.bulk_title}</PageTitle>
      </header>
      <ShopSwitcher shops={shops} current={shop} label={dict.dashboard.shop} href={(slug) => `/${lang}/dashboard/items/photos?${new URLSearchParams({ shop: slug })}`} />

      <section className={cardClass} aria-labelledby="photo-bulk-how">
        <h2 id="photo-bulk-how" className="text-[17px] font-bold">
          {p.bulk_how_title}
        </h2>
        <ul className="flex list-disc flex-col gap-1 pl-5 text-[15px]">
          <li>{p.bulk_how_1}</li>
          <li>{p.bulk_how_2}</li>
          <li>{p.bulk_how_3}</li>
          <li>{p.bulk_how_4}</li>
        </ul>
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <a href="/samples/fotky-produktov.csv" download className="font-semibold underline underline-offset-4" data-photo-sample="csv">
            {p.sample_csv}
          </a>
          <a href="/samples/fotky-produktov.xml" download className="font-semibold underline underline-offset-4" data-photo-sample="xml">
            {p.sample_xml}
          </a>
        </p>
        <PhotoBulkUpload
          shopId={shop.id}
          labels={{
            pick: p.pick,
            pick_help: p.pick_help,
            reading: p.reading,
            found: p.found,
            columns: p.columns,
            cut: p.cut,
            start: p.start,
            starting: p.starting,
            preview_code: p.col_code,
            preview_ean: p.col_ean,
            preview_url: p.col_url,
            bad_url_note: p.bad_url_note,
            error_empty: p.error_empty,
            error_no_key: p.error_no_key,
            error_no_url: p.error_no_url,
            error_not_xml: p.error_not_xml,
            error_too_big: p.error_list_too_big,
            error_job_running: p.error_job_running,
            error_job_limit: p.error_job_limit,
            error_failed: p.error_job_failed,
          }}
        />
      </section>

      <section id="report" className={`${cardClass} scroll-mt-4`} aria-labelledby="photo-bulk-report" data-photo-report={job?.status ?? "none"}>
        <h2 id="photo-bulk-report" className="text-[17px] font-bold">
          {p.report_title}
        </h2>
        {!job ? (
          <p className="text-sm text-muted">{p.report_none}</p>
        ) : (
          <>
            <PhotoJobRefresh running={job.status === "running"} />
            <p className="text-[15px]">
              <span className="font-semibold">{job.file_name}</span> · {formatDateTime(job.created_at, lang, shop.timezone)}
            </p>
            <p role="status" aria-live="polite" className="text-[15px] font-semibold">
              {job.status === "running" ? t(p.report_running, { done: String(finished), total: String(job.total) }) : t(p.report_done, { total: String(job.total) })}
            </p>
            <ul className="flex flex-wrap gap-2" aria-label={p.report_counts}>
              {counts.map((c) => (
                <li key={c.status} className="rounded-full bg-[#F4F4F4] px-3 py-1 text-sm font-semibold" data-photo-count={c.status}>
                  {statusText(c.status)}: {c.n}
                </li>
              ))}
            </ul>
            <p className="text-sm">
              <a href={`/api/owner/product-photos/report?${new URLSearchParams({ job: job.id, lang })}`} className="font-semibold underline underline-offset-4" data-photo-report-csv>
                {p.report_download}
              </a>
            </p>
            {problems.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm" data-photo-report-rows>
                  <caption className="pb-1 text-left text-muted">{t(p.report_problems, { n: String(problems.length) })}</caption>
                  <thead className="text-muted">
                    <tr>
                      <th className="py-1 pr-3 font-medium">{p.col_row}</th>
                      <th className="py-1 pr-3 font-medium">{p.col_code}</th>
                      <th className="py-1 pr-3 font-medium">{p.col_result}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {problems.slice(0, SHOWN_ROWS).map((r) => (
                      <tr key={r.n} className="border-t border-line align-top" data-photo-row={r.status}>
                        <td className="py-1 pr-3 tabular-nums">{r.n}</td>
                        <td className="py-1 pr-3 whitespace-nowrap tabular-nums">{r.code ?? r.ean ?? "–"}</td>
                        <td className="py-1">
                          <span className="font-semibold">{statusText(r.status)}</span>
                          {detailText(r) && <span className="text-muted"> · {detailText(r)}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {jobs.length > 1 && (
              <nav aria-label={p.report_older} className="flex flex-col gap-1 text-sm">
                <span className="text-muted">{p.report_older}</span>
                {jobs.map((j) => (
                  <Link key={j.id} href={`${here({ job: j.id })}#report`} aria-current={j.id === job.id ? "true" : undefined} className={j.id === job.id ? "font-semibold" : "underline underline-offset-4"}>
                    {j.file_name} · {formatDateTime(j.created_at, lang, shop.timezone)} · {t(p.report_rows, { n: String(j.total) })}
                  </Link>
                ))}
              </nav>
            )}
          </>
        )}
      </section>
    </div>
  );
}
