import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { ShopView, shopMetadata } from "./ShopView";

export async function generateMetadata({ params }: PageProps<"/[lang]/shops/[slug]">): Promise<Metadata> {
  const { lang, slug } = await params;
  if (!isLocale(lang)) return {};
  return await shopMetadata(lang, slug);
}

export default async function ShopPage({ params, searchParams }: PageProps<"/[lang]/shops/[slug]">) {
  const { lang, slug } = await params;
  if (!isLocale(lang)) notFound();
  return <ShopView lang={lang} slug={slug} sp={await searchParams} onSite={false} />;
}
