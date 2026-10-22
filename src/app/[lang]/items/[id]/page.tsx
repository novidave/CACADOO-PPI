import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { ItemView, itemMetadata } from "./ItemView";

export async function generateMetadata({ params }: PageProps<"/[lang]/items/[id]">): Promise<Metadata> {
  const { lang, id } = await params;
  if (!isLocale(lang)) return {};
  return await itemMetadata(lang, id);
}

export default async function ItemPage({ params, searchParams }: PageProps<"/[lang]/items/[id]">) {
  const original = (await searchParams).original === "1";
  const { lang, id } = await params;
  if (!isLocale(lang)) notFound();
  return <ItemView lang={lang} id={id} siteSlug={null} original={original} />;
}
