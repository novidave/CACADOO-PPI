import type { Metadata } from "next";
import type { ReactNode } from "react";
import { missingColumn } from "@/lib/missingColumn";
import { cardClass } from "@/components/owner/ui";
import { SaveBar } from "@/components/owner/SaveBar";
import { saveLimits } from "../_parts/actions";
import type { InventoryOverview } from "../_parts/InventoryAdmin";
import { AdminHead, AdminNotice, adminStart, adminTitle, Hidden, numClass, saveLabels } from "../_parts/common";

export async function generateMetadata({ params }: PageProps<"/[lang]/admin/limits">): Promise<Metadata> {
  return adminTitle(params, "limits");
}

/**
 * "Limity obsahu stránky" per plan: slides, of which PDFs, and files in the library (database update 38), pages and
 * MB per file (update 30; before update 38 only the number of sections, pages and MB).
 */
interface LimitsRow {
  plan: "free" | "pro";
  max_sections: number;
  max_pages: number;
  max_mb: number;
  max_slides?: number;
  max_pdf_slides?: number;
  max_items?: number;
}

const PRO_ONLY = ["pro_ai", "pro_crm", "pro_bookings", "pro_food", "pro_domain", "pro_telegram", "pro_sms"] as const;
const LINE = "grid min-h-14 grid-cols-[minmax(0,1fr)_6rem_6rem] items-center gap-x-3 border-t border-[#E4E4E4] py-2 text-[15px]";

/** One limit: its name (and a hint) and the two plans' fields side by side. */
function Line({ label, hint, free, pro, ...data }: { label: ReactNode; hint?: ReactNode; free: ReactNode; pro: ReactNode } & Record<`data-${string}`, string>) {
  return (
    <div className={LINE} {...data}>
      <span className="flex min-w-0 flex-col">
        <span className="font-semibold">{label}</span>
        {hint && <span className="text-[13px] text-[#5C5C5C]">{hint}</span>}
      </span>
      <span className="flex justify-end">{free}</span>
      <span className="flex justify-end">{pro}</span>
    </div>
  );
}

/**
 * Admin → Limity plánov (2026-11-05, artboard 5): every Zadarmo / Pro limit side by side in ONE form with the save bar
 * — page content (admin_save_section_limits / admin_save_content_limits), blog posts (admin_save_blog_limits),
 * pre-translated languages (admin_save_translation_limits) and the inventory programs (admin_save_inventory_settings),
 * all through saveLimits; Sklad's 50 products and the "Len s Pro" list are read only. is_admin() decides every save.
 * A read that fails leaves its card's fields out (and so out of the save).
 */
export default async function AdminLimitsPage({ params, searchParams }: PageProps<"/[lang]/admin/limits">) {
  const { lang, dict, session } = await adminStart(params);
  const sp = await searchParams;
  const a = dict.admin_domains;
  const n = dict.admin_nav as Record<string, string>;
  const [sectionLimits, blogLimits, translationLimits, inventory] = await Promise.all([
    session.supabase
      .from("section_limits")
      .select("plan, max_sections, max_pages, max_mb, max_slides, max_pdf_slides, max_items")
      .then(async (r) => (missingColumn(r.error, "max_slides") ? await session.supabase.from("section_limits").select("plan, max_sections, max_pages, max_mb") : r)),
    session.supabase.from("blog_limits").select("plan, max_posts"),
    session.supabase.rpc("admin_translation_limits"),
    session.supabase.rpc("admin_inventory_overview"),
  ]);
  const limitRows = sectionLimits.error ? null : ((sectionLimits.data ?? []) as LimitsRow[]);
  const blog = blogLimits.error ? null : ((blogLimits.data ?? []) as { plan: "free" | "pro"; max_posts: number | null }[]);
  const tr = translationLimits.error ? null : ((translationLimits.data ?? []) as { plan: "free" | "pro"; max_preferred: number }[]);
  const inv = inventory.error ? null : (inventory.data as InventoryOverview | null);
  const row = (plan: "free" | "pro") => limitRows?.find((r) => r.plan === plan);
  const invPlan = (plan: "free" | "pro") => inv?.plans?.find((r) => r.plan === plan);
  const unavailable = <p className="text-sm text-[#5C5C5C]">{dict.owner_blog.unavailable}</p>;
  const planHead = (
    <div className="grid grid-cols-[minmax(0,1fr)_6rem_6rem] gap-x-3 pb-1.5 text-right text-xs font-bold uppercase tracking-[.04em] text-[#5C5C5C]" aria-hidden="true">
      <span />
      <span>{n.limits_free}</span>
      <span>{n.limits_pro}</span>
    </div>
  );
  /** Both plans' number fields of one limit (named "<plan>:<field>"). */
  const pair = (field: string, label: string, min: number, max: number, value: (plan: "free" | "pro") => number | string | undefined, hint?: string, required = true) => (
    <Line
      label={label}
      hint={hint}
      data-limit={field}
      free={<input name={`free:${field}`} type="number" min={min} max={max} required={required} aria-label={`${label} – ${n.limits_free}`} defaultValue={value("free") ?? ""} className={numClass} />}
      pro={<input name={`pro:${field}`} type="number" min={min} max={max} required={required} aria-label={`${label} – ${n.limits_pro}`} defaultValue={value("pro") ?? ""} className={numClass} />}
    />
  );

  return (
    <div className="flex flex-col gap-4">
      <div>
        <AdminHead dict={dict} page="limits" />
        <AdminNotice dict={dict} sp={sp} />
      </div>

      <form action={saveLimits} className="flex flex-col gap-4" data-limits-form>
        <Hidden lang={lang} keep="" />
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
          <div className="flex flex-col gap-4">
            <section id="section-limits" className={`${cardClass} min-w-0 !gap-0`} aria-labelledby="section-limits-heading" data-section-limits>
              <h2 id="section-limits-heading" className="text-[19px] font-bold">
                {n.limits_content_title}
              </h2>
              <p className="pb-3 pt-1 text-sm text-[#5C5C5C]">{a.limits_hint}</p>
              {!limitRows ? (
                <p className="text-sm text-[#5C5C5C]">{a.limits_unavailable}</p>
              ) : (
                <>
                  {planHead}
                  {row("free")?.max_slides === undefined ? (
                    pair("max_sections", a.limits_sections, 0, 50, (p) => row(p)?.max_sections)
                  ) : (
                    <>
                      {/* the number of sections of update 30 stays as it is (the slider decides what is shown) */}
                      <input type="hidden" name="free:max_sections" value={row("free")?.max_sections ?? ""} />
                      <input type="hidden" name="pro:max_sections" value={row("pro")?.max_sections ?? ""} />
                      {pair("max_slides", a.limits_slides, 0, 10, (p) => row(p)?.max_slides, n.limits_slides_hint)}
                      {pair("max_pdf_slides", a.limits_pdf_slides, 0, 10, (p) => row(p)?.max_pdf_slides)}
                      {pair("max_items", n.limits_items_label, 0, 100, (p) => row(p)?.max_items)}
                    </>
                  )}
                  {pair("max_pages", n.limits_pages_label, 1, 50, (p) => row(p)?.max_pages)}
                  {pair("max_mb", a.limits_mb, 1, 20, (p) => row(p)?.max_mb)}
                </>
              )}
            </section>

            <section id="blog-limits" className={`${cardClass} min-w-0 !gap-0`} aria-labelledby="blog-limits-heading" data-admin-blog>
              <h2 id="blog-limits-heading" className="pb-3 text-[19px] font-bold">
                {dict.admin_blog.title}
              </h2>
              {!blog ? (
                unavailable
              ) : (
                <>
                  {planHead}
                  <Line
                    label={n.limits_blog_label}
                    hint={n.limits_blog_hint}
                    data-limit="blog"
                    free={<input name="blog:free" type="number" min={0} max={10000} aria-label={`${n.limits_blog_label} – ${n.limits_free}`} placeholder={n.limits_no_limit} defaultValue={blog.find((b) => b.plan === "free")?.max_posts ?? ""} className={numClass} />}
                    pro={<input name="blog:pro" type="number" min={0} max={10000} aria-label={`${n.limits_blog_label} – ${n.limits_pro}`} placeholder={n.limits_no_limit} defaultValue={blog.find((b) => b.plan === "pro")?.max_posts ?? ""} className={numClass} />}
                  />
                </>
              )}
            </section>
          </div>

          <div className="flex flex-col gap-4">
            <section id="translation-limits" className={`${cardClass} min-w-0 !gap-0`} aria-labelledby="translation-limits-heading" data-translation-limits>
              <h2 id="translation-limits-heading" className="pb-3 text-[19px] font-bold">
                {n.limits_tr_title}
              </h2>
              {!tr ? (
                unavailable
              ) : (
                <>
                  {planHead}
                  <Line
                    label={n.limits_tr_label}
                    hint={n.limits_tr_hint}
                    data-limit="translations"
                    free={<input name="tr:free" type="number" min={0} max={42} required aria-label={`${n.limits_tr_label} – ${n.limits_free}`} defaultValue={tr.find((l) => l.plan === "free")?.max_preferred ?? 2} className={numClass} />}
                    pro={<input name="tr:pro" type="number" min={0} max={42} required aria-label={`${n.limits_tr_label} – ${n.limits_pro}`} defaultValue={tr.find((l) => l.plan === "pro")?.max_preferred ?? 6} className={numClass} />}
                  />
                </>
              )}
            </section>

            <section id="inventory-limits" className={`${cardClass} min-w-0 !gap-0`} aria-labelledby="inventory-limits-heading" data-inventory-settings>
              <h2 id="inventory-limits-heading" className="pb-3 text-[19px] font-bold">
                {dict.admin_inventory.title}
              </h2>
              {!inv ? (
                unavailable
              ) : (
                <>
                  {planHead}
                  <Line
                    label={n.limits_inv_allowed}
                    data-limit="inventory-allowed"
                    free={<input type="checkbox" name="inv:free_allowed" aria-label={dict.admin_inventory.free_allowed} defaultChecked={invPlan("free")?.allowed ?? false} className="ppi-toggle" />}
                    pro={<span className="text-sm font-semibold">{n.limits_always}</span>}
                  />
                  <Line
                    label={n.limits_inv_interval}
                    hint={n.limits_inv_interval_hint}
                    data-limit="inventory-interval"
                    free={<input name="inv:free_interval" type="number" min={5} max={10080} required aria-label={dict.admin_inventory.free_interval} defaultValue={invPlan("free")?.interval_minutes ?? 1440} className={numClass} />}
                    pro={<input name="inv:pro_interval" type="number" min={5} max={10080} required aria-label={dict.admin_inventory.pro_interval} defaultValue={invPlan("pro")?.interval_minutes ?? 15} className={numClass} />}
                  />
                </>
              )}
            </section>

            {/* Sklad v Cacaduu (database update 67): sklad_product_limit() = 50 without the plan, none with it — read only */}
            <section id="sklad-limits" className={`${cardClass} min-w-0 !gap-0`} aria-labelledby="sklad-limits-heading" data-sklad-limits>
              <h2 id="sklad-limits-heading" className="pb-3 text-[19px] font-bold">
                {n.limits_sklad_title}
              </h2>
              {planHead}
              <Line label={n.limits_sklad_products} data-limit="sklad" free={<strong>50</strong>} pro={<strong className="text-right">{n.limits_no_limit}</strong>} />
              <p className="border-t border-[#E4E4E4] pt-2.5 text-sm text-[#5C5C5C]">{n.limits_sklad_fixed}</p>
            </section>

            {/* what only shops with the plan get (shop_has_plan decides each in SQL) — read only */}
            <section id="pro-only" className={`${cardClass} min-w-0`} aria-labelledby="pro-only-heading" data-pro-only>
              <h2 id="pro-only-heading" className="text-[19px] font-bold">
                {n.limits_pro_only_title}
              </h2>
              <ul className="flex flex-wrap gap-2 text-sm">
                {PRO_ONLY.map((k) => (
                  <li key={k} className="inline-flex h-[34px] items-center rounded-full border border-[#E4E4E4] px-3 font-semibold">
                    {n[k]}
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </div>
        <SaveBar labels={saveLabels(dict)} />
      </form>
    </div>
  );
}
