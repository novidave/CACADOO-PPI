import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { BlogPostView, blogPostMetadata } from "../../../../../[lang]/shops/[slug]/blog/BlogViews";

/** A post on the shop's own domain ("/blog/<post>", "/hu/blog/<post>"): only src/proxy.ts sends visitors here. */
export async function generateMetadata({ params }: PageProps<"/site/[lang]/[slug]/blog/[post]">): Promise<Metadata> {
  const { lang, slug, post } = await params;
  if (!isLocale(lang)) return {};
  return await blogPostMetadata(lang, slug, post, true);
}

export default async function SiteBlogPostPage({ params }: PageProps<"/site/[lang]/[slug]/blog/[post]">) {
  const { lang, slug, post } = await params;
  if (!isLocale(lang)) notFound();
  return <BlogPostView lang={lang} slug={slug} postSlug={post} onSite />;
}
