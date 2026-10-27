import "server-only";
import { revalidateTag } from "next/cache";
import { CROSS_TAG, PUBLIC_TAG, shopTag } from "./supabase/public";

/**
 * After an owner saved something a visitor can see (details, hours, items, slider, blog, translations), or a new
 * stock file / post / page picture arrived: the shop's cached reads (and the reads across shops, which show its items
 * too) are read again by the next visitor. Only in Server Actions and Route Handlers.
 */
export function refreshShop(slug: string | null | undefined) {
  if (!slug) return refreshAll();
  revalidateTag(shopTag(slug), { expire: 0 });
  revalidateTag(CROSS_TAG, { expire: 0 });
}

/** A change for every shop (the admin's holidays, languages, limits): every cached public read. */
export function refreshAll() {
  revalidateTag(PUBLIC_TAG, { expire: 0 });
}
