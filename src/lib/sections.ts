import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { supabaseEnv } from "@/lib/supabase/env";

/**
 * Page sections from PDFs (paid plan, database update 28). Visitors get only the sections the
 * database shows (shop_sections(): published, not hidden, inside their dates, the shop has the
 * plan, the pictures already public). The pictures are served straight from the public bucket
 * with srcset (800 / 1600 px), never through image optimisation; the PDF is never loaded here.
 */

import type { SectionPosition } from "./sectionLimits";

export { MAX_PDF_BYTES, MAX_PDF_PAGES, MAX_SECTIONS, POSITIONS, type SectionPosition } from "./sectionLimits";
export const PUBLIC_BUCKET = "shop-sections-public";

export interface SectionPage {
  page: number;
  width: number;
  height: number;
  ext: "webp" | "jpg";
  text: string;
  /** Picture addresses: public (visitors) or signed for 10 minutes (the owner's preview). */
  small: string;
  large: string;
}

/** "Zobrazenie strán" (database update 29): one page at a time, or the pages one under another. */
export type PageLayout = "slider" | "stacked";

export interface ShownSection {
  id: string;
  title: string;
  display: "collapsed" | "open";
  position: SectionPosition;
  allow_download: boolean;
  /** "slider" before database update 29 too (the default). */
  page_layout: PageLayout;
  pages: SectionPage[];
}

interface Row {
  id: string;
  title: string;
  display: "collapsed" | "open";
  position: SectionPosition;
  sort: number;
  allow_download: boolean;
  version: number;
  pages: { page: number; width: number; height: number; ext: "webp" | "jpg"; text: string }[];
  page_layout?: PageLayout | null;
}

/** The public address of a page picture: <shop>/<section>/v<version>/<page>-<800|1600>.<ext>. */
export function publicPictureUrl(shopId: string, sectionId: string, version: number, page: number, size: 800 | 1600, ext: string): string {
  const base = supabaseEnv()?.url ?? "";
  return `${base}/storage/v1/object/public/${PUBLIC_BUCKET}/${shopId}/${sectionId}/v${version}/${page}-${size}.${ext}`;
}

/** The shop page's sections (none before database update 28, for free shops, or on any error). */
export const getShopSections = cache(async (slug: string, shopId: string): Promise<ShownSection[]> => {
  const db = await createClient();
  if (!db) return [];
  const { data, error } = await db.rpc("shop_sections", { p_slug: slug });
  if (error) return [];
  return ((data ?? []) as Row[]).map((row) => ({
    id: row.id,
    title: row.title,
    display: row.display,
    position: row.position,
    allow_download: row.allow_download,
    page_layout: row.page_layout === "stacked" ? "stacked" : "slider",
    pages: row.pages
      .filter((p) => p.width && p.height && p.ext)
      .map((p) => ({
        ...p,
        small: publicPictureUrl(shopId, row.id, row.version, p.page, 800, p.ext),
        large: publicPictureUrl(shopId, row.id, row.version, p.page, 1600, p.ext),
      })),
  }));
});

/** The header picture of a shop's own domain (database update 28; none before it). */
export interface HeaderPicture {
  url: string;
  small_url: string;
  width: number;
  height: number;
}

export const getHeaderPicture = cache(async (slug: string): Promise<HeaderPicture | null> => {
  const db = await createClient();
  if (!db) return null;
  const { data, error } = await db.rpc("shop_header_picture", { p_slug: slug });
  if (error) return null;
  return ((data ?? []) as HeaderPicture[])[0] ?? null;
});
