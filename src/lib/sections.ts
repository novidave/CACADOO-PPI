import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { supabaseEnv } from "@/lib/supabase/env";
import type { Locale } from "@/i18n/config";
import { blogPath, blogPhotoUrl, type BlogPlace } from "./blogFormat";
import { formatDate } from "./format";
import { cardExcerpt, pageImage, type ContentItem, type PageContent, type PostPhoto, type SlideView } from "./pageContent";

/**
 * The shop page's "Obsah stránky" (database update 38; before it the page sections of updates 28–31): one call to
 * shop_content() gives the settings and the slides the database shows (posts that are visible, files whose pictures
 * are public). The pictures are served straight from the public bucket with srcset (800 / 1600 px), never through
 * image optimisation; a PDF itself is never loaded in the page.
 */

export const PUBLIC_BUCKET = "shop-sections-public";

/** The public address of a page picture: <shop>/<section>/v<version>/<page>-<800|1600>.<ext>. */
export function publicPictureUrl(shopId: string, sectionId: string, version: number, page: number, size: 800 | 1600, ext: string): string {
  const base = supabaseEnv()?.url ?? "";
  return `${base}/storage/v1/object/public/${PUBLIC_BUCKET}/${shopId}/${sectionId}/v${version}/${page}-${size}.${ext}`;
}

/** The slider's settings and slides; null before database update 38, for an unknown shop or on any error. */
export const getShopContent = cache(async (slug: string): Promise<PageContent | null> => {
  const db = await createClient();
  if (!db) return null;
  const { data, error } = await db.rpc("shop_content", { p_slug: slug });
  if (error || !data) return null;
  return data as PageContent;
});

/** "Stiahnuť PDF" / "Stiahnuť" of a shown file: the website asks shop-files for a 10-minute address. */
export const downloadPath = (slug: string, itemId: string) => `/api/shops/${slug}/sections/${itemId}/download`;

function itemPages(shopId: string, item: ContentItem) {
  return item.pages
    .filter((p) => p.width && p.height && p.ext)
    .map((p) => ({
      ...pageImage(p, publicPictureUrl(shopId, item.id, item.version, p.page, 800, p.ext), publicPictureUrl(shopId, item.id, item.version, p.page, 1600, p.ext)),
      text: p.text,
    }));
}

/** A blog photo (or a video's picture) for a card; null without one. */
export function postImage(photo: PostPhoto | null) {
  const base = supabaseEnv()?.url ?? "";
  if (!photo?.large || !photo.width || !photo.height) return null;
  return { small: blogPhotoUrl(base, photo.small || photo.large), large: blogPhotoUrl(base, photo.large), width: photo.width, height: photo.height };
}

/**
 * The slides as the slider draws them: posts link to their page on the shop's canonical place (the own domain's
 * "/blog/…" there), dates in the shop's time zone, pictures from the public bucket.
 */
export function slideViews(
  content: PageContent,
  ctx: { shopId: string; slug: string; lang: Locale; timeZone: string; place: BlogPlace; onSite: boolean },
): SlideView[] {
  const views: SlideView[] = [];
  for (const slide of content.slides) {
    if (slide.kind === "post") {
      const p = slide.post;
      views.push({
        kind: "post",
        key: `post-${p.id}`,
        href: blogPath(ctx.lang, ctx.place, ctx.onSite, p.slug),
        title: p.title,
        date: formatDate(p.publish_at, ctx.lang, ctx.timeZone),
        dateTime: p.publish_at,
        excerpt: cardExcerpt(p.excerpt),
        image: postImage(p.photo),
      });
      continue;
    }
    const pages = itemPages(ctx.shopId, slide.item);
    if (!pages.length) continue;
    const download = slide.item.download ? downloadPath(ctx.slug, slide.item.id) : null;
    if (slide.kind === "pdf") {
      views.push({ kind: "pdf", key: `item-${slide.item.id}`, title: slide.item.title, layout: slide.item.page_layout, pages, download });
    } else {
      views.push({
        kind: "picture",
        key: `item-${slide.item.id}`,
        title: slide.item.show_title ? slide.item.title : null,
        alt: slide.item.alt || slide.item.title,
        image: pages[0],
        text: pages[0].text,
        download,
      });
    }
  }
  return views;
}

/**
 * The header logo of a shop's own domain (database update 31; none before it or without one) and
 * where it leads (update 32: an https address; null or missing = the shop's home page). Since
 * update 32 a shop with only a link has a row too (url null: the header shows the shop's logo).
 */
export interface SiteLogo {
  url: string | null;
  width: number | null;
  height: number | null;
  link?: string | null;
}

export const getSiteLogo = cache(async (slug: string): Promise<SiteLogo | null> => {
  const db = await createClient();
  if (!db) return null;
  const { data, error } = await db.rpc("shop_site_logo", { p_slug: slug });
  if (error) return null;
  return ((data ?? []) as SiteLogo[])[0] ?? null;
});
