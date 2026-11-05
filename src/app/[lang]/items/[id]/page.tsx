import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getItem } from "@/lib/data";
import { menuDishOf } from "@/lib/menu";
import { DishView, dishMetadata } from "./DishView";
import { ItemView, itemMetadata } from "./ItemView";

export async function generateMetadata({ params }: PageProps<"/[lang]/items/[id]">): Promise<Metadata> {
  const { lang, id } = await params;
  if (!isLocale(lang)) return {};
  // a restaurant's dish (update 84) or a shop's product; both reads at once (no waterfall for products)
  const [dish] = await Promise.all([menuDishOf(id), getItem(id).catch(() => null)]);
  return dish ? await dishMetadata(lang, dish) : await itemMetadata(lang, id);
}

export default async function ItemPage({ params, searchParams }: PageProps<"/[lang]/items/[id]">) {
  const original = (await searchParams).original === "1";
  const { lang, id } = await params;
  if (!isLocale(lang)) notFound();
  const [dish] = await Promise.all([menuDishOf(id), getItem(id).catch(() => null)]);
  if (dish) return <DishView lang={lang} at={dish} siteSlug={null} original={original} />;
  return <ItemView lang={lang} id={id} siteSlug={null} original={original} />;
}
