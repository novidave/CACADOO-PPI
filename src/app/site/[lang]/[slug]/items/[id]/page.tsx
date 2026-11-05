import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getItem } from "@/lib/data";
import { menuDishOf } from "@/lib/menu";
import { DishView, dishMetadata } from "../../../../../[lang]/items/[id]/DishView";
import { ItemView, itemMetadata } from "../../../../../[lang]/items/[id]/ItemView";

/**
 * An item on its shop's own domain (database update 25): only src/proxy.ts sends visitors
 * here; only the shop's own items exist (any other item is 404). A restaurant's dish (update 84) has its dish page.
 */
export async function generateMetadata({ params }: PageProps<"/site/[lang]/[slug]/items/[id]">): Promise<Metadata> {
  const { lang, id } = await params;
  if (!isLocale(lang)) return {};
  const [dish] = await Promise.all([menuDishOf(id), getItem(id).catch(() => null)]);
  return dish ? await dishMetadata(lang, dish) : await itemMetadata(lang, id);
}

export default async function SiteItemPage({ params, searchParams }: PageProps<"/site/[lang]/[slug]/items/[id]">) {
  const original = (await searchParams).original === "1";
  const { lang, slug, id } = await params;
  if (!isLocale(lang)) notFound();
  const [dish] = await Promise.all([menuDishOf(id), getItem(id).catch(() => null)]);
  if (dish) return <DishView lang={lang} at={dish} siteSlug={slug} original={original} />;
  return <ItemView lang={lang} id={id} siteSlug={slug} original={original} />;
}
