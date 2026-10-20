import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { BlogListView, blogListMetadata, pageNumber } from "../../../../[lang]/shops/[slug]/blog/BlogViews";

/**
 * The shop's blog on its own domain ("/blog", "/hu/blog"; database update 37): only src/proxy.ts sends visitors here.
 * 404 unless the domain is live.
 */
export async function generateMetadata({ params, searchParams }: PageProps<"/site/[lang]/[slug]/blog">): Promise<Metadata> {
  const { lang, slug } = await params;
  if (!isLocale(lang)) return {};
  return await blogListMetadata(lang, slug, pageNumber(await searchParams), true);
}

export default async function SiteBlogPage({ params, searchParams }: PageProps<"/site/[lang]/[slug]/blog">) {
  const { lang, slug } = await params;
  if (!isLocale(lang)) notFound();
  return <BlogListView lang={lang} slug={slug} sp={await searchParams} onSite />;
}
