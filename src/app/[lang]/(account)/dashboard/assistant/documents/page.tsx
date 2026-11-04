import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary, t } from "@/i18n/dictionaries";
import { requireUser } from "@/lib/auth";
import { forwardUrl, movedFrom } from "@/lib/dashboardPages";
import type { MyShop } from "@/lib/myShops";
import { DbError } from "@/components/DbError";
import { itemTabs, PageHead } from "@/components/owner/PageHead";
import { messages, ProOnly, ShopSwitcher } from "../../shared";
import { loadShopDocs, ShopDocuments } from "../../ShopDocuments";

export async function generateMetadata({ params }: PageProps<"/[lang]/dashboard/assistant/documents">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  const dict = await getDictionary(lang);
  return { title: dict.nav.tabs.assistant_documents };
}

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

/**
 * AI asistent → Dokumenty (back-end layout L2, 2026-11-03; it was a part of "Súkromné priečinky", update 63): the
 * documents and pictures the assistant answers from — the terms, the upload (up to 20 files at once), the lists. The
 * folders and their access keys are the next tab (/dashboard/assistant/folders). Old addresses (`?at=docs`) land here.
 * Paid parts check shop_has_plan() in SQL; what a free shop already has stays reachable.
 */
export default async function DocumentsPage({ params, searchParams }: PageProps<"/[lang]/dashboard/assistant/documents">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const sp = await searchParams;
  const at = first(sp.at) ?? "";
  if (movedFrom("documents", at)) redirect(forwardUrl(lang, at, sp));
  const [dict, session] = await Promise.all([getDictionary(lang), requireUser(lang)]);
  const { supabase } = session;
  const d = dict.dashboard;

  const { data: shopRows, error: shopsError } = await supabase.rpc("my_shops");
  if (shopsError) return <DbError message={shopsError.message} dict={dict} />;
  const shops = (shopRows ?? []) as MyShop[];
  if (!shops.length) redirect(`/${lang}/dashboard`);
  const shop = shops.find((s) => s.slug === first(sp.shop)) ?? shops[0];

  const [hasPlan, docsData] = await Promise.all([supabase.rpc("shop_has_plan", { p_shop_id: shop.id }), loadShopDocs(supabase, shop.id)]);
  const planActive = !hasPlan.error && hasPlan.data === true;
  const m = messages(dict, sp);
  const planUrl = `/${lang}/dashboard/plan?${new URLSearchParams({ shop: shop.slug })}`;
  const showDocs = Boolean(
    docsData && (planActive || docsData.docs.length > 0 || docsData.pictures.length > 0 || docsData.keys.length > 0),
  );

  return (
    <div className="flex w-full flex-col gap-5">
      <PageHead title={dict.nav.assistant} item="assistant" tabs={itemTabs(dict, lang, "assistant", shop.slug)} current="documents" tabsLabel={dict.nav.tabs_label}>
        <ShopSwitcher
          shops={shops}
          current={shop}
          label={d.shop}
          href={(slug) => `/${lang}/dashboard/assistant/documents?${new URLSearchParams({ shop: slug })}`}
        />
        {shops.length > 1 && <p className="text-muted">{shop.name}</p>}
      </PageHead>
      <div className="flex max-w-3xl flex-col gap-5">
      {m.top}
      <section id="docs" className="flex scroll-mt-4 flex-col gap-3" data-tab-panel="docs">
        {docsData && showDocs && (
          <p className="text-sm text-muted">{t(d.summary_docs, { documents: docsData.docs.length, pictures: docsData.pictures.length })}</p>
        )}
        {!docsData || showDocs ? (
          <ShopDocuments supabase={supabase} data={docsData} shop={shop} lang={lang} dict={dict} hasPlan={planActive} notice={m.notice("docs")} view="docs" />
        ) : (
          <>
            {m.notice("docs")}
            <p className="text-sm">{dict.docs.intro}</p>
            <ProOnly dict={dict} href={planUrl} />
          </>
        )}
      </section>
      </div>
    </div>
  );
}
