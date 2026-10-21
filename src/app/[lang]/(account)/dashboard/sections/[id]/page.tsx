import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/i18n/config";

/**
 * The address of the old "Náhľad" of a page section (updates 28–37): the file is in "Obsah stránky" now (database
 * update 38), where the live preview shows the whole slider.
 */
export default async function OldSectionPreview({ params, searchParams }: PageProps<"/[lang]/dashboard/sections/[id]">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const sp = await searchParams;
  const shop = Array.isArray(sp.shop) ? sp.shop[0] : sp.shop;
  redirect(`/${lang}/dashboard/content?${new URLSearchParams({ ...(shop ? { shop } : {}), at: "library" })}#library`);
}
