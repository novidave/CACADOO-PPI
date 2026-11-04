import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Dictionary } from "@/i18n/dictionaries";
import type { ProductPhotoLabels } from "@/components/owner/ProductPhotoField";
import { productPhotoUrl } from "./productPhotos";
import { supabaseEnv } from "./supabase/env";

/** The product's photo for its owner's screens (RLS: members read their own rows), as the 800 px address. */
export async function ownerProductPhoto(supabase: SupabaseClient, itemId: string): Promise<{ src: string; width: number; height: number } | null> {
  const env = supabaseEnv();
  if (!env) return null;
  const { data, error } = await supabase.from("product_photos").select("path_small, width, height").eq("item_id", itemId).maybeSingle();
  // before update 78 the table does not exist: no photo
  if (error || !data) return null;
  const row = data as { path_small: string; width: number; height: number };
  return { src: productPhotoUrl(env.url, row.path_small), width: row.width, height: row.height };
}

export function productPhotoLabels(dict: Dictionary): ProductPhotoLabels {
  const p = dict.product_photos;
  return {
    title: p.title,
    help: p.help,
    upload: p.upload,
    change: p.change,
    remove: p.remove,
    remove_confirm: p.remove_confirm,
    uploading: p.uploading,
    removing: p.removing,
    saved: p.saved,
    removed: p.removed,
    none: p.none,
    error_too_big: p.error_too_big,
    error_picture: p.error_picture,
    error_failed: p.error_failed,
    preview_alt: p.preview_alt,
  };
}
