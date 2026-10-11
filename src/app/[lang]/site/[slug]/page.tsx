import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { ShopView, shopMetadata } from "../../shops/[slug]/ShopView";

/**
 * The shop's page on its own domain (database update 25). Only src/proxy.ts sends visitors
 * here (a request for "/" or "/{lang}" on the shop's domain); on the Cacadoo address this
 * path redirects to /{lang}/shops/{slug}. 404 unless the domain is live.
 */
export async function generateMetadata({ params }: PageProps<"/[lang]/site/[slug]">): Promise<Metadata> {
  const { lang, slug } = await params;
  if (!isLocale(lang)) return {};
  return await shopMetadata(lang, slug);
}

export default async function SitePage({ params, searchParams }: PageProps<"/[lang]/site/[slug]">) {
  const { lang, slug } = await params;
  if (!isLocale(lang)) notFound();
  return <ShopView lang={lang} slug={slug} sp={await searchParams} onSite />;
}
