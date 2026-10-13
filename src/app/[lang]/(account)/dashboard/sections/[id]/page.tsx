import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary, t } from "@/i18n/dictionaries";
import { requireUser } from "@/lib/auth";
import type { SectionPage, ShownSection } from "@/lib/sections";
import { PageSections } from "@/components/PageSections";
import { PendingButton } from "@/components/PendingButton";
import { SectionZoom } from "@/components/SectionZoom";
import { setSectionState } from "../../sectionActions";

export const metadata: Metadata = { robots: { index: false } };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Row {
  id: string;
  shop_id: string;
  title: string;
  display: "collapsed" | "open";
  position: ShownSection["position"];
  allow_download: boolean;
  published: boolean;
  hidden: boolean;
  version: number;
  upload_version: number | null;
  upload_error: string | null;
  page_layout?: "slider" | "stacked";
  source?: string;
}

/**
 * "Náhľad" of a page section (database update 28): exactly as visitors will see it, from the
 * private pictures (10-minute addresses from page-sections; RLS: only the shop's owners read
 * the row). With a new PDF being made ready, the new one; then "Zverejniť".
 */
export default async function SectionPreview({ params, searchParams }: PageProps<"/[lang]/dashboard/sections/[id]">) {
  const { lang, id } = await params;
  if (!isLocale(lang) || !UUID.test(id)) notFound();
  const [dict, session] = await Promise.all([getDictionary(lang), requireUser(lang)]);
  const s = dict.sections;
  const sp = await searchParams;
  const slugParam = Array.isArray(sp.shop) ? sp.shop[0] : sp.shop;
  const { data } = await session.supabase
    .from("shop_page_sections")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  const row = data as Row | null;
  if (!row) notFound();
  const { data: shop } = await session.supabase.from("shops").select("slug").eq("id", row.shop_id).maybeSingle();
  const slug = (shop as { slug: string } | null)?.slug ?? slugParam ?? "";
  const which = row.upload_version && !row.upload_error ? "upload" : "live";
  const { data: preview } = await session.supabase.functions.invoke<{ version: number; pages: (Omit<SectionPage, "ext"> & { small: string | null; large: string | null })[] }>(
    "page-sections",
    { body: { action: "preview", section_id: id, which } },
  );
  const pages = (preview?.pages ?? []).filter((p): p is typeof p & { small: string; large: string } => Boolean(p.small && p.large));
  // In the preview the download stays off (the PDF is not public yet); the owner's setting is shown in words.
  const section: ShownSection = {
    id: row.id,
    title: row.title,
    display: row.display,
    position: row.position,
    allow_download: false,
    page_layout: row.page_layout === "stacked" ? "stacked" : "slider",
    source: row.source === "pictures" ? "pictures" : "pdf",
    pages: pages.map((p) => ({ ...p, ext: "webp" })),
  };
  const back = `/${lang}/dashboard?${new URLSearchParams({ shop: slug, at: "sections" })}#sections`;

  return (
    <div className="flex max-w-3xl flex-col gap-6" data-section-preview-page>
      <header className="flex flex-col gap-2">
        <Link href={back} className="text-sm underline underline-offset-4">
          ← {s.back}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{t(s.preview_title, { title: row.title })}</h1>
        <p className="border border-line p-3 text-sm">{s.preview_note}</p>
        <p className="text-sm text-muted">
          {s[`display_${row.display}`]} · {row.page_layout === "stacked" ? s.layout_stacked : s.layout_slider} ·{" "}
          {(s as Record<string, string>)[`position_${row.position}`]}
          {row.allow_download ? ` · ${s.download_on}` : ""}
        </p>
      </header>
      {pages.length === 0 ? (
        <p>{s.preview_none}</p>
      ) : (
        <>
          <PageSections sections={[section]} position={section.position} slug={slug} dict={dict} />
          <SectionZoom labels={s} />
        </>
      )}
      {row.version > 0 && (!row.published || row.hidden) && (
        <form action={setSectionState}>
          <input type="hidden" name="lang" value={lang} />
          <input type="hidden" name="shop_id" value={row.shop_id} />
          <input type="hidden" name="shop_slug" value={slug} />
          <input type="hidden" name="section_id" value={row.id} />
          <input type="hidden" name="state" value={row.published ? "show" : "publish"} />
          <PendingButton pending={dict.owner.saving}>{row.published ? s.show : s.publish}</PendingButton>
        </form>
      )}
    </div>
  );
}
