import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary, t } from "@/i18n/dictionaries";
import { requireUser } from "@/lib/auth";
import { assistantTabUrl, forwardUrl, movedFrom } from "@/lib/dashboardPages";
import type { MyShop } from "@/lib/myShops";
import { DbError } from "@/components/DbError";
import { messages, ProOnly, ShopSwitcher } from "../../shared";
import { loadShopDocs, ShopDocuments } from "../../ShopDocuments";

export async function generateMetadata({ params }: PageProps<"/[lang]/dashboard/assistant/folders">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return { title: (await getDictionary(lang)).dashboard.private_folders_title };
}

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

/**
 * Asistent → "Súkromné priečinky" (its own page since update 63; reached from Nastavenia): the documents the assistant
 * answers from, the folders, their access keys and "Len zobraziť" / "Zobraziť a stiahnuť". Old addresses
 * (`/dashboard/assistant?at=docs` or `?at=private`) are forwarded here with their query. Paid parts check shop_has_plan()
 * in SQL; what a free shop already has stays reachable.
 */
export default async function FoldersPage({ params, searchParams }: PageProps<"/[lang]/dashboard/assistant/folders">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const sp = await searchParams;
  const at = first(sp.at) ?? "";
  if (movedFrom("folders", at)) redirect(forwardUrl(lang, at, sp));
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
    <div className="flex max-w-3xl flex-col gap-5">
      <header className="flex flex-col gap-2">
        <Link href={assistantTabUrl(lang, "settings", shop.slug)} className="flex min-h-11 items-center gap-1 self-start text-sm underline underline-offset-4">
          {dict.asst.back_to_settings}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{d.private_folders_title}</h1>
        <ShopSwitcher
          shops={shops}
          current={shop}
          label={d.shop}
          href={(slug) => `/${lang}/dashboard/assistant/folders?${new URLSearchParams({ shop: slug })}`}
        />
        {shops.length > 1 && <p className="text-muted">{shop.name}</p>}
        {m.top}
      </header>
      <section id="docs" className="flex scroll-mt-4 flex-col gap-3" data-tab-panel="docs">
        {docsData && showDocs && (
          <p className="text-sm text-muted">{t(d.summary_docs, { documents: docsData.docs.length, pictures: docsData.pictures.length })}</p>
        )}
        {!docsData || showDocs ? (
          <ShopDocuments supabase={supabase} data={docsData} shop={shop} lang={lang} dict={dict} hasPlan={planActive} notice={m.notice("docs")} />
        ) : (
          <>
            {m.notice("docs")}
            <p className="text-sm">{dict.docs.intro}</p>
            <ProOnly dict={dict} href={planUrl} />
          </>
        )}
      </section>
    </div>
  );
}
