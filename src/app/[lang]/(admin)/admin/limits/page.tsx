import type { Metadata } from "next";
import { missingColumn } from "@/lib/missingColumn";
import { saveSectionLimits } from "../_parts/actions";
import { BlogLimitsAdmin } from "../_parts/BlogLimitsAdmin";
import type { InventoryOverview } from "../_parts/InventoryAdmin";
import { InventoryLimitsAdmin } from "../_parts/InventoryLimitsAdmin";
import { TranslationLimitsAdmin } from "../_parts/TranslationLimitsAdmin";
import { AdminHead, AdminNotice, adminStart, adminTitle, Hidden } from "../_parts/common";

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

const input = "rounded border border-line px-2 py-1 outline-none focus:border-foreground";
const PRO_ONLY = ["pro_ai", "pro_crm", "pro_bookings", "pro_food", "pro_domain", "pro_telegram", "pro_sms"] as const;

/**
 * Admin → Limity plánov (2026-11-05): every Zadarmo / Pro limit on one page — page content (admin_save_section_limits
 * / admin_save_content_limits), blog posts (admin_save_blog_limits), pre-translated languages
 * (admin_save_translation_limits) and the inventory programs (admin_save_inventory_settings). Each form is the same as
 * before and returns here; is_admin() decides every save.
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
  const hidden = <Hidden lang={lang} keep="" />;

  return (
    <div className="flex flex-col gap-8">
      <div>
        <AdminHead dict={dict} page="limits" />
        <AdminNotice dict={dict} sp={sp} />
      </div>

      <section id="section-limits" className="flex flex-col gap-3" aria-labelledby="section-limits-heading">
        <h2 id="section-limits-heading" className="text-lg font-semibold">
          {a.limits_title}
        </h2>
        <p className="text-sm text-muted">{a.limits_hint}</p>
        {!limitRows ? (
          <p className="text-sm text-muted">{a.limits_unavailable}</p>
        ) : (
          <div className="flex flex-col gap-2 text-sm" data-section-limits>
            {(["free", "pro"] as const).map((plan) => {
              const row = limitRows.find((r) => r.plan === plan);
              return (
                <form key={plan} action={saveSectionLimits} className="flex flex-wrap items-end gap-2 border-b border-line pb-2" data-limits-plan={plan}>
                  {hidden}
                  <input type="hidden" name="plan" value={plan} />
                  <span className="w-24 pb-1 font-medium">{plan === "pro" ? a.plan_pro : a.plan_free}</span>
                  {row?.max_slides === undefined ? (
                    <label className="flex flex-col gap-1">
                      <span>{a.limits_sections}</span>
                      <input name="max_sections" type="number" min={0} max={50} required defaultValue={row?.max_sections ?? ""} className={`${input} w-20`} />
                    </label>
                  ) : (
                    <>
                      {/* The number of sections of update 30 stays as it is (the slider decides what is shown). */}
                      <input type="hidden" name="max_sections" value={row.max_sections} />
                      <label className="flex flex-col gap-1">
                        <span>{a.limits_slides}</span>
                        <input name="max_slides" type="number" min={0} max={10} required defaultValue={row.max_slides} className={`${input} w-20`} />
                      </label>
                      <label className="flex flex-col gap-1">
                        <span>{a.limits_pdf_slides}</span>
                        <input name="max_pdf_slides" type="number" min={0} max={10} required defaultValue={row.max_pdf_slides} className={`${input} w-20`} />
                      </label>
                      <label className="flex flex-col gap-1">
                        <span>{a.limits_items}</span>
                        <input name="max_items" type="number" min={0} max={100} required defaultValue={row.max_items} className={`${input} w-20`} />
                      </label>
                    </>
                  )}
                  <label className="flex flex-col gap-1">
                    <span>{a.limits_pages}</span>
                    <input name="max_pages" type="number" min={1} max={50} required defaultValue={row?.max_pages ?? ""} className={`${input} w-20`} />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span>{a.limits_mb}</span>
                    <input name="max_mb" type="number" min={1} max={20} required defaultValue={row?.max_mb ?? ""} className={`${input} w-20`} />
                  </label>
                  <button type="submit" className="rounded border border-foreground px-3 py-1 font-medium">
                    {a.limits_save}
                  </button>
                </form>
              );
            })}
          </div>
        )}
      </section>

      <BlogLimitsAdmin
        limits={blogLimits.error ? null : ((blogLimits.data ?? []) as { plan: "free" | "pro"; max_posts: number | null }[])}
        dict={dict}
        hidden={hidden}
      />

      <TranslationLimitsAdmin
        limits={translationLimits.error ? null : ((translationLimits.data ?? []) as { plan: "free" | "pro"; max_preferred: number }[])}
        dict={dict}
        hidden={hidden}
      />

      <InventoryLimitsAdmin overview={inventory.error ? null : (inventory.data as InventoryOverview)} dict={dict} hidden={hidden} />

      {/* Sklad v Cacaduu (database update 67): sklad_product_limit() = 50 without the plan, none with it — read only */}
      <section id="sklad-limits" className="flex flex-col gap-2" aria-labelledby="sklad-limits-heading" data-sklad-limits>
        <h2 id="sklad-limits-heading" className="text-lg font-semibold">
          {n.limits_sklad_title}
        </h2>
        <p className="text-sm">
          {n.limits_sklad_products}: {n.limits_free} 50 · {n.limits_pro} {n.limits_no_limit}
        </p>
        <p className="text-sm text-muted">{n.limits_sklad_fixed}</p>
      </section>

      {/* what only shops with the plan get (shop_has_plan decides each in SQL) — read only */}
      <section id="pro-only" className="flex flex-col gap-2" aria-labelledby="pro-only-heading" data-pro-only>
        <h2 id="pro-only-heading" className="text-lg font-semibold">
          {n.limits_pro_only_title}
        </h2>
        <ul className="flex flex-wrap gap-2 text-sm">
          {PRO_ONLY.map((k) => (
            <li key={k} className="inline-flex min-h-8 items-center rounded-full border border-[#D6D6D6] px-3 font-semibold">
              {n[k]}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
