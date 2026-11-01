import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { ShopLegalView, shopLegalMetadata } from "../../../../[lang]/shops/[slug]/ShopLegalView";

/** The shop's own "Právne informácie" on its own domain ("/pravne-informacie"; only src/proxy.ts sends visitors here). */
export async function generateMetadata({ params }: PageProps<"/site/[lang]/[slug]/pravne-informacie">): Promise<Metadata> {
  const { lang, slug } = await params;
  if (!isLocale(lang)) return {};
  return await shopLegalMetadata(lang, slug, true);
}

export default async function SiteLegalPage({ params }: PageProps<"/site/[lang]/[slug]/pravne-informacie">) {
  const { lang, slug } = await params;
  if (!isLocale(lang)) notFound();
  return <ShopLegalView lang={lang} slug={slug} onSite />;
}
