import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { ItemView, itemMetadata } from "../../../../items/[id]/ItemView";

/**
 * An item on its shop's own domain (database update 25): only src/proxy.ts sends visitors
 * here; only the shop's own items exist (any other item is 404).
 */
export async function generateMetadata({ params }: PageProps<"/[lang]/site/[slug]/items/[id]">): Promise<Metadata> {
  const { lang, id } = await params;
  if (!isLocale(lang)) return {};
  return await itemMetadata(lang, id);
}

export default async function SiteItemPage({ params }: PageProps<"/[lang]/site/[slug]/items/[id]">) {
  const { lang, slug, id } = await params;
  if (!isLocale(lang)) notFound();
  return <ItemView lang={lang} id={id} siteSlug={slug} />;
}
