"use server";

import { isLocale } from "@/i18n/config";
import { requireUser } from "@/lib/auth";
import { refreshShop } from "@/lib/publicCache";

/**
 * After "Nahrať / Zmeniť / Odstrániť fotku" (database update 78): the product page shows the new photo at once (the
 * product-photos function also refreshes it when SITE_URL and REVALIDATE_SECRET are set). The database checks that
 * the product is the caller's (owner_product_photo_item); nothing else changes here.
 */
export async function productPhotoChanged(lang: string, itemId: string): Promise<void> {
  if (!isLocale(lang) || !/^[0-9a-f-]{36}$/i.test(itemId)) return;
  const { supabase } = await requireUser(lang);
  const { data } = await supabase.rpc("owner_product_photo_item", { p_item_id: itemId });
  const slug = (data as { slug?: string } | null)?.slug;
  if (slug) refreshShop(slug);
}
