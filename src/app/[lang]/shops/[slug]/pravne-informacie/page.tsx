import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { ShopLegalView, shopLegalMetadata } from "../ShopLegalView";

/** The shop's own "Právne informácie" on its Cacaduu address (database update 65). */
export async function generateMetadata({ params }: PageProps<"/[lang]/shops/[slug]/pravne-informacie">): Promise<Metadata> {
  const { lang, slug } = await params;
  if (!isLocale(lang)) return {};
  return await shopLegalMetadata(lang, slug, false);
}

export default async function ShopLegalPage({ params }: PageProps<"/[lang]/shops/[slug]/pravne-informacie">) {
  const { lang, slug } = await params;
  if (!isLocale(lang)) notFound();
  return <ShopLegalView lang={lang} slug={slug} onSite={false} />;
}
